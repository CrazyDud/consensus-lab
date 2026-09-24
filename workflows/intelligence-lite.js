import { getWritable, sleep } from "workflow";
import { getMultiMarketData } from "../lib/market-multi.js";
import { adaptiveLeverageSignal } from "../lib/strategy-v2.js";

const START_CASH = 1000;
const FEE_PCT = 0.15;
const SLIP_PCT = 0.03;
const ADVICE_URL = "https://consensus-lab-mu.vercel.app/gpt-latest.json";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function initialState() {
  return {
    cash: START_CASH,
    position: null,
    trades: [],
    peak: START_CASH,
    maxDD: 0,
    feesPaid: 0,
    lastDecisionBar: 0,
    tickCount: 0,
    startedAt: Date.now(),
    pendingForecasts: [],
    resolvedForecasts: 0,
    correctForecasts: 0,
    buyHold: null,
  };
}

async function loadAdvice() {
  try {
    const response = await fetch(ADVICE_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error("Advice unavailable");
    const advice = await response.json();
    const age = Date.now() - Date.parse(advice.updatedAt || 0);
    if (!Number.isFinite(age) || age > 3 * 60 * 60 * 1000) {
      return {
        action: "neutral",
        allowedDirections: ["long", "short"],
        riskMultiplier: 1,
        maxLeverage: 3,
        minConfidence: 0.58,
        stale: true,
      };
    }
    return advice;
  } catch {
    return {
      action: "neutral",
      allowedDirections: ["long", "short"],
      riskMultiplier: 1,
      maxLeverage: 3,
      minConfidence: 0.58,
      unavailable: true,
    };
  }
}

function entryPrice(side, price) {
  return side === "long"
    ? price * (1 + SLIP_PCT / 100)
    : price * (1 - SLIP_PCT / 100);
}

function exitPrice(side, price) {
  return side === "long"
    ? price * (1 - SLIP_PCT / 100)
    : price * (1 + SLIP_PCT / 100);
}

function unrealized(position, price) {
  if (!position) return 0;
  return position.side === "long"
    ? position.qty * (price - position.entry)
    : position.qty * (position.entry - price);
}

function equity(state, price) {
  if (!state.position) return state.cash;
  const exitFee = state.position.qty * price * (FEE_PCT / 100);
  return state.cash + state.position.margin + unrealized(state.position, price) - exitFee;
}

function updateRisk(state, price) {
  const eq = equity(state, price);
  state.peak = Math.max(state.peak || START_CASH, eq);
  const dd = state.peak > 0 ? ((state.peak - eq) / state.peak) * 100 : 0;
  state.maxDD = Math.max(state.maxDD || 0, dd);
  return eq;
}

function openPosition(state, direction, leverage, riskMultiplier, confidence, regime, price, barTime, now) {
  if (state.maxDD >= 5) return;
  let risk = clamp(riskMultiplier, 0, 1);
  if (state.maxDD >= 3) risk *= 0.5;
  if (risk <= 0) return;

  const margin = state.cash * 0.10 * risk;
  if (margin < 5) return;

  const lev = clamp(leverage, 1, 3);
  const entry = entryPrice(direction, price);
  const notional = margin * lev;
  const qty = notional / entry;
  const fee = notional * (FEE_PCT / 100);
  state.cash -= margin + fee;
  state.feesPaid += fee;

  const highVol = regime === "high";
  const stopPct = highVol ? 0.9 : 0.7;
  const targetPct = highVol ? 1.55 : 1.2;

  state.position = {
    side: direction,
    leverage: lev,
    margin,
    notional,
    qty,
    entry,
    entryFee: fee,
    entryTime: now,
    entryBar: barTime,
    confidence,
    stop: direction === "long" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100),
    target: direction === "long" ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100),
  };
}

function closePosition(state, price, reason, now) {
  const p = state.position;
  if (!p) return;
  const exit = exitPrice(p.side, price);
  const rawPnl = p.side === "long"
    ? p.qty * (exit - p.entry)
    : p.qty * (p.entry - exit);
  const exitFee = p.qty * exit * (FEE_PCT / 100);
  const returned = Math.max(0, p.margin + rawPnl - exitFee);
  const pnl = returned - p.margin - p.entryFee;

  state.cash += returned;
  state.feesPaid += exitFee;
  state.trades = [{
    time: now,
    side: p.side,
    leverage: p.leverage,
    entry: p.entry,
    exit,
    pnl,
    fees: p.entryFee + exitFee,
    reason,
    confidence: p.confidence,
  }, ...state.trades].slice(0, 300);
  state.position = null;
}

function resolveForecasts(state, price, now) {
  const keep = [];
  for (const f of state.pendingForecasts) {
    if (f.dueAt > now) {
      keep.push(f);
      continue;
    }
    const actualLong = price > f.price;
    const correct = (f.direction === "long") === actualLong;
    state.resolvedForecasts += 1;
    if (correct) state.correctForecasts += 1;
  }
  state.pendingForecasts = keep;
}

function evidenceStatus(state, eq, buyHoldEq) {
  const trades = state.trades.length;
  const forecasts = state.resolvedForecasts;
  const accuracy = forecasts ? state.correctForecasts / forecasts : null;
  const returnPct = (eq / START_CASH - 1) * 100;
  const holdReturn = (buyHoldEq / START_CASH - 1) * 100;

  if (trades < 20 || forecasts < 100) {
    return {
      stage: "COLLECTING",
      verdict: "Not enough evidence yet",
      nextGate: "20 closed trades + 100 resolved 15-minute forecasts",
    };
  }

  const wins = state.trades.filter((t) => t.pnl > 0).length;
  const grossWin = state.trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(state.trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : null;

  const promising =
    returnPct > 0 &&
    returnPct > holdReturn &&
    state.maxDD < 8 &&
    accuracy !== null &&
    accuracy > 0.52 &&
    pf !== null &&
    pf > 1.15;

  return {
    stage: trades >= 50 && forecasts >= 250 ? "MEANINGFUL" : "PRELIMINARY",
    verdict: promising ? "Promising candidate edge" : "Not yet showing a convincing edge",
    nextGate: trades >= 50 ? "100 closed trades + multiple market regimes" : "50 closed trades + 250 resolved forecasts",
    criteria: {
      positiveAfterCosts: returnPct > 0,
      beatsBuyHold: returnPct > holdReturn,
      maxDrawdownBelow8Pct: state.maxDD < 8,
      directionalAccuracyAbove52Pct: accuracy !== null && accuracy > 0.52,
      profitFactorAbove1_15: pf !== null && pf > 1.15,
    },
  };
}

export async function intelligenceLiteTick(previousState) {
  "use step";

  const state = structuredClone(previousState);
  const now = Date.now();
  const [m1, m5, advice] = await Promise.all([
    getMultiMarketData(60),
    getMultiMarketData(300),
    loadAdvice(),
  ]);

  const bucket1 = Math.floor(now / 1000 / 60) * 60;
  const bucket5 = Math.floor(now / 1000 / 300) * 300;
  const c1 = m1.candles.filter((c) => c.t < bucket1);
  const c5 = m5.candles.filter((c) => c.t < bucket5);
  if (c1.length < 70 || c5.length < 70) throw new Error("Not enough closed candles");

  const price = Number(m1.ticker.price);
  resolveForecasts(state, price, now);

  const raw = adaptiveLeverageSignal(c1, c5);
  const score = Number(raw.score || 0);
  const confidence = clamp(0.5 + Math.abs(score) * 0.12, 0.5, 0.85);
  const minConfidence = Math.max(0.58, Number(advice.minConfidence || 0.58));

  let direction = raw.direction;
  if (confidence < minConfidence) direction = "flat";
  const allowed = Array.isArray(advice.allowedDirections) ? advice.allowedDirections : ["long", "short"];
  if (!allowed.includes(direction)) direction = "flat";
  if (advice.action === "risk_off") direction = "flat";

  const maxLev = clamp(Number(advice.maxLeverage || 3), 1, 3);
  const leverage = Math.min(clamp(Number(raw.leverage || 1), 1, 3), maxLev);
  let riskMultiplier = clamp(Number(advice.riskMultiplier ?? 1), 0, 1);
  const regime = raw.slowDirection === "flat" ? "normal" : "trend";
  if (!raw.confirmed && direction !== "flat") riskMultiplier *= 0.7;

  if (c1.at(-1).t !== state.lastDecisionBar) {
    if (direction !== "flat") {
      state.pendingForecasts.push({
        dueAt: now + 15 * 60 * 1000,
        direction,
        price,
        confidence,
      });
      state.pendingForecasts = state.pendingForecasts.slice(-500);
    }
    state.lastDecisionBar = c1.at(-1).t;
  }

  if (state.position) {
    const p = state.position;
    const heldMinutes = Math.max(0, Math.floor((c1.at(-1).t - p.entryBar) / 60));
    const opposite = direction !== "flat" && direction !== p.side && confidence >= 0.62;

    if (p.side === "long" && price <= p.stop) closePosition(state, price, "Stop loss", now);
    else if (p.side === "short" && price >= p.stop) closePosition(state, price, "Stop loss", now);
    else if (p.side === "long" && price >= p.target) closePosition(state, price, "Profit target", now);
    else if (p.side === "short" && price <= p.target) closePosition(state, price, "Profit target", now);
    else if (heldMinutes >= 90) closePosition(state, price, "Maximum hold", now);
    else if (advice.action === "risk_off") closePosition(state, price, "GPT supervisor risk-off", now);
    else if (opposite) closePosition(state, price, "Opposite intelligence signal", now);
  }

  if (!state.position && direction !== "flat") {
    openPosition(
      state,
      direction,
      leverage,
      riskMultiplier,
      confidence,
      regime,
      price,
      c1.at(-1).t,
      now
    );
  }

  if (!state.buyHold) {
    const fee = START_CASH * (FEE_PCT / 100);
    state.buyHold = { entry: price, qty: (START_CASH - fee) / price };
  }

  const eq = updateRisk(state, price);
  const buyHoldEq = state.buyHold.qty * price * (1 - FEE_PCT / 100);
  const wins = state.trades.filter((t) => t.pnl > 0).length;
  const losses = state.trades.filter((t) => t.pnl <= 0).length;
  const grossWin = state.trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(state.trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  state.tickCount += 1;

  return {
    state,
    snapshot: {
      status: "running",
      mode: "intelligence-shadow",
      heartbeatAt: now,
      nextCheckApproxAt: now + 60 * 1000,
      checkIntervalSeconds: 60,
      tickCount: state.tickCount,
      startedAt: state.startedAt,
      market: {
        price,
        provider1m: m1.provider,
        provider5m: m5.provider,
        latest1mBar: c1.at(-1).t,
        latest5mBar: c5.at(-1).t,
      },
      forecast: {
        direction,
        confidence,
        leverage,
        riskMultiplier,
        rawScore: score,
        slowConfirmed: Boolean(raw.confirmed),
        slowDirection: raw.slowDirection,
        reason: direction === "flat"
          ? "No trade after confidence and supervisor filters."
          : direction.toUpperCase() + " x" + leverage + " at " + (confidence * 100).toFixed(1) + "% internal confidence.",
      },
      gptAdvice: advice,
      learning: {
        resolvedForecasts: state.resolvedForecasts,
        pendingForecasts: state.pendingForecasts.length,
        directionalAccuracyPct: state.resolvedForecasts
          ? (state.correctForecasts / state.resolvedForecasts) * 100
          : null,
      },
      account: {
        startCash: START_CASH,
        cash: state.cash,
        equity: eq,
        returnPct: (eq / START_CASH - 1) * 100,
        maxDrawdownPct: state.maxDD,
        feesPaid: state.feesPaid,
        closedTrades: state.trades.length,
        wins,
        losses,
        winRatePct: state.trades.length ? (wins / state.trades.length) * 100 : null,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      },
      position: state.position,
      trades: state.trades.slice(0, 50),
      baselines: {
        buyHold: { equity: buyHoldEq, returnPct: (buyHoldEq / START_CASH - 1) * 100 },
        cash: { equity: START_CASH, returnPct: 0 },
      },
      evaluation: evidenceStatus(state, eq, buyHoldEq),
      safety: {
        realOrders: false,
        maxLeverage: 3,
        gptCanIncreaseRisk: false,
        drawdownThrottlePct: 3,
        newEntriesStopPct: 5,
      },
    },
  };
}

export async function emitIntelligenceLite(snapshot) {
  "use step";
  const writer = getWritable({ namespace: "intelligence-state" }).getWriter();
  try {
    await writer.write(JSON.stringify(snapshot) + "\n");
  } finally {
    writer.releaseLock();
  }
}

export async function intelligenceLiteEngine() {
  "use workflow";

  let state = initialState();

  while (true) {
    try {
      const result = await intelligenceLiteTick(state);
      state = result.state;
      await emitIntelligenceLite(result.snapshot);
    } catch (error) {
      await emitIntelligenceLite({
        status: "degraded",
        mode: "intelligence-shadow",
        heartbeatAt: Date.now(),
        nextCheckApproxAt: Date.now() + 60 * 1000,
        checkIntervalSeconds: 60,
        tickCount: state.tickCount,
        startedAt: state.startedAt,
        error: error?.message || "Intelligence tick failed",
      });
    }
    await sleep("1m");
  }
}
