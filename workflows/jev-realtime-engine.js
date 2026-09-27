import { getWritable, sleep } from "workflow";
import { experimental_evaluate as evaluate } from "ai";
import { getMultiMarketData } from "../lib/market-multi.js";
import { adaptiveLeverageSignal } from "../lib/strategy-v2.js";

const START_CASH = 1000;
const FEE_PCT = 0.15;
const SLIP_PCT = 0.03;
const STOP_PCT = 0.7;
const TARGET_PCT = 1.2;
const SIZE_PCT = 10;
const HARD_MAX_LEVERAGE = 1;
const HARD_DD_STOP = 3;
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";
const WINDOW_MS = 50000;
const FIRST_WINDOW_MS = 8000;
const FEED_STALE_MS = 5000;
const MIN_ASK_GAP_MS = 750;
const FLAT_REFRESH_MS = 2500;
const HELD_REFRESH_MS = 1000;
const MOVE_TRIGGER_PCT = 0.015;
const MODEL_TIMEOUT_MS = 2200;
const EXIT_COOLDOWN_MS = 10000;
const MAX_HOLD_MS = 30 * 60 * 1000;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function newState() {
  return {
    portfolio: { cash: START_CASH, position: null, trades: [], peak: START_CASH, maxDD: 0, feesPaid: 0, lastExitAt: 0 },
    model: { calls: 0, errors: 0, latencyTotalMs: 0, lastLatencyMs: null, lastDecision: null, lastError: null },
    startedAt: Date.now(),
    windowCount: 0
  };
}

function unrealized(p, price) {
  if (!p) return 0;
  return p.side === "long" ? p.qty * (price - p.entry) : p.qty * (p.entry - price);
}

function equity(portfolio, price) {
  if (!portfolio.position) return portfolio.cash;
  const p = portfolio.position;
  const exitFee = p.qty * price * (FEE_PCT / 100);
  return portfolio.cash + p.margin + unrealized(p, price) - exitFee;
}

function updateRisk(portfolio, price) {
  const e = equity(portfolio, price);
  portfolio.peak = Math.max(portfolio.peak || START_CASH, e);
  const dd = portfolio.peak > 0 ? ((portfolio.peak - e) / portfolio.peak) * 100 : 0;
  portfolio.maxDD = Math.max(portfolio.maxDD || 0, dd);
}

function tradeStats(portfolio) {
  const wins = portfolio.trades.filter(function(t) { return t.pnl > 0; }).length;
  const losses = portfolio.trades.length - wins;
  const grossWin = portfolio.trades.filter(function(t) { return t.pnl > 0; }).reduce(function(s,t) { return s + t.pnl; }, 0);
  const grossLoss = Math.abs(portfolio.trades.filter(function(t) { return t.pnl < 0; }).reduce(function(s,t) { return s + t.pnl; }, 0));
  return {
    closedTrades: portfolio.trades.length,
    wins: wins,
    losses: losses,
    winRatePct: portfolio.trades.length ? wins / portfolio.trades.length * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null
  };
}

function summarize(portfolio, price) {
  const e = equity(portfolio, price);
  return Object.assign({
    label: "Consensus Jev Realtime",
    timeframe: "live Coinbase tape + Jev",
    equity: e,
    returnPct: (e / START_CASH - 1) * 100,
    cash: portfolio.cash,
    maxDrawdownPct: portfolio.maxDD,
    feesPaid: portfolio.feesPaid,
    position: portfolio.position,
    trades: portfolio.trades.slice(0, 30)
  }, tradeStats(portfolio));
}

function policy(portfolio, fresh, now, price) {
  const s = summarize(portfolio, price);
  const base = {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    source: "repo-fixed-supervisor-jev",
    action: "neutral",
    allowedDirections: ["long", "short"],
    riskMultiplier: 0.50,
    maxLeverage: 1,
    minConfidence: 0.68,
    reason: "Realtime Jev paper mode: half-size, x1 maximum, high entry threshold."
  };
  if (!fresh) return Object.assign({}, base, { action: "risk_off", allowedDirections: [], riskMultiplier: 0, minConfidence: 0.72, reason: "Live Coinbase feed is stale." });
  if (portfolio.maxDD >= HARD_DD_STOP) return Object.assign({}, base, { action: "risk_off", allowedDirections: [], riskMultiplier: 0, minConfidence: 0.75, reason: "Hard risk-off: Jev max drawdown reached 3%." });
  if (portfolio.maxDD >= 1.5) return Object.assign({}, base, { riskMultiplier: 0.25, minConfidence: 0.72, reason: "Drawdown throttle: quarter-size paper risk." });
  if (s.closedTrades >= 20 && s.returnPct < 0 && (s.winRatePct || 0) < 35 && (s.profitFactor || 0) < 0.8) {
    return Object.assign({}, base, { riskMultiplier: 0.35, minConfidence: 0.72, reason: "Weak Jev trade evidence: tighter paper policy." });
  }
  return base;
}

function openPosition(portfolio, side, price, now, supervisor) {
  const risk = clamp(Number(supervisor.riskMultiplier || 0), 0, 0.5);
  const leverage = Math.min(HARD_MAX_LEVERAGE, Math.max(1, Number(supervisor.maxLeverage || 1)));
  const feeRate = FEE_PCT / 100;
  let margin = portfolio.cash * SIZE_PCT / 100 * risk;
  margin = Math.min(margin, portfolio.cash / (1 + leverage * feeRate));
  if (!(margin > 0)) return false;
  const entry = side === "long" ? price * (1 + SLIP_PCT / 100) : price * (1 - SLIP_PCT / 100);
  const notional = margin * leverage;
  const qty = notional / entry;
  const entryFee = notional * feeRate;
  portfolio.cash -= margin + entryFee;
  portfolio.feesPaid += entryFee;
  portfolio.position = {
    side: side, entry: entry, qty: qty, margin: margin, leverage: leverage, notional: notional,
    entryFee: entryFee, entryTime: now,
    stop: side === "long" ? entry * (1 - STOP_PCT / 100) : entry * (1 + STOP_PCT / 100),
    target: side === "long" ? entry * (1 + TARGET_PCT / 100) : entry * (1 - TARGET_PCT / 100)
  };
  return true;
}

function closePosition(portfolio, price, reason, now) {
  const p = portfolio.position;
  if (!p) return false;
  const exit = p.side === "long" ? price * (1 - SLIP_PCT / 100) : price * (1 + SLIP_PCT / 100);
  const rawPnl = p.side === "long" ? p.qty * (exit - p.entry) : p.qty * (p.entry - exit);
  const exitFee = p.qty * exit * (FEE_PCT / 100);
  const returned = Math.max(0, p.margin + rawPnl - exitFee);
  portfolio.cash += returned;
  portfolio.feesPaid += exitFee;
  portfolio.trades.unshift({
    time: now, side: p.side, leverage: p.leverage, entry: p.entry, exit: exit,
    pnl: returned - p.margin - p.entryFee, rawPnl: rawPnl, fees: p.entryFee + exitFee,
    reason: reason, heldSeconds: Math.max(0, (now - p.entryTime) / 1000)
  });
  portfolio.trades = portfolio.trades.slice(0, 300);
  portfolio.position = null;
  portfolio.lastExitAt = now;
  return true;
}

function hardExits(portfolio, price, now, supervisor) {
  const p = portfolio.position;
  if (!p) return;
  if (supervisor.action === "risk_off") { closePosition(portfolio, price, "Fixed supervisor risk-off", now); return; }
  if ((p.side === "long" && price <= p.stop) || (p.side === "short" && price >= p.stop)) { closePosition(portfolio, price, "Hard stop loss", now); return; }
  if ((p.side === "long" && price >= p.target) || (p.side === "short" && price <= p.target)) { closePosition(portfolio, price, "Hard profit target", now); return; }
  if (now - p.entryTime >= MAX_HOLD_MS) closePosition(portfolio, price, "Maximum hold", now);
}

function pctMove(a, b) { return b > 0 ? (a - b) / b * 100 : 0; }

function moveAt(points, ms, price, now) {
  for (let i = points.length - 1; i >= 0; i--) if (now - points[i].t >= ms) return pctMove(price, points[i].p);
  return null;
}

function shouldAsk(tape, portfolio, now) {
  if (!(tape.price > 0)) return false;
  if (!tape.lastAskAt) return true;
  const gap = now - tape.lastAskAt;
  if (gap < MIN_ASK_GAP_MS) return false;
  if (portfolio.position && gap >= HELD_REFRESH_MS) return true;
  if (!portfolio.position && gap >= FLAT_REFRESH_MS) return true;
  return Math.abs(pctMove(tape.price, tape.lastAskPrice || tape.price)) >= MOVE_TRIGGER_PCT;
}

async function askJev(tape, context, portfolio, supervisor, now) {
  const p = portfolio.position;
  const state = {
    market: {
      symbol: "BTC-USD", price: tape.price, bid: tape.bid, ask: tape.ask,
      spread_bps: tape.bid > 0 && tape.ask >= tape.bid ? Number(((tape.ask - tape.bid) / tape.price * 10000).toFixed(2)) : null,
      bid_size: tape.bidSize, ask_size: tape.askSize,
      book_lean: tape.bidSize > 0 && tape.askSize > 0 ? Number((tape.bidSize / tape.askSize).toFixed(3)) : null,
      move_1s_pct: moveAt(tape.points, 1000, tape.price, now),
      move_5s_pct: moveAt(tape.points, 5000, tape.price, now),
      move_15s_pct: moveAt(tape.points, 15000, tape.price, now),
      move_60s_pct: moveAt(tape.points, 60000, tape.price, now),
      prints_last_10s: tape.points.filter(function(x) { return now - x.t <= 10000; }).length
    },
    quantitative_context: {
      adaptive_direction: context.adaptive.direction,
      adaptive_score: context.adaptive.score,
      five_minute_direction: context.adaptive.slowDirection,
      five_minute_confirmed: context.adaptive.confirmed
    },
    paper_position: p ? {
      side: p.side, entry: p.entry,
      pnl_pct: Number((p.side === "long" ? pctMove(tape.price, p.entry) : pctMove(p.entry, tape.price)).toFixed(4)),
      held_seconds: Number(((now - p.entryTime) / 1000).toFixed(1)),
      stop: p.stop, target: p.target
    } : null,
    recent_closed_trades: portfolio.trades.slice(0,5).map(function(t) {
      return { side: t.side, pnl: Number(t.pnl.toFixed(4)), held_seconds: Number(t.heldSeconds.toFixed(1)), reason: t.reason };
    }),
    hard_policy: {
      paper_only: true, action: supervisor.action, allowed_directions: supervisor.allowedDirections,
      risk_multiplier: supervisor.riskMultiplier, max_leverage: 1,
      minimum_entry_probability: supervisor.minConfidence
    }
  };
  const questions = {
    direction: {
      type: "choice",
      instructions: "Over the next 15 to 30 seconds, choose the most likely BTC-USD path. Use the live tape first and the quantitative context second. Choose flat unless the directional edge is clean enough to overcome ordinary short-term noise and fees.",
      criteria: {
        up: "Meaningfully higher in 15-30 seconds; buyers have the cleaner immediate path.",
        down: "Meaningfully lower in 15-30 seconds; sellers have the cleaner immediate path.",
        flat: "No sufficiently clean directional edge, including noisy or conflicting evidence."
      }
    },
    reversal: {
      type: "boolean",
      instructions: p ? "Is there strong live evidence the current paper-trade thesis has reversed enough that exiting now is preferable to holding?" : "There is no open position. Return false."
    }
  };
  const t0 = Date.now();
  const result = await evaluate({
    model: "typesafe-ai/jev",
    state: state,
    questions: questions,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS)
  });
  const a = result.answers && result.answers.direction ? result.answers.direction : {};
  const choice = ["up","down","flat"].includes(a.choice) ? a.choice : "flat";
  const probabilities = a.probabilities || {};
  const selectedProbability = Number(probabilities[choice] || 0);
  const r = result.answers && result.answers.reversal ? result.answers.reversal : {};
  const reversalProbability = Number(r.probability || 0);
  return { choice: choice, probabilities: probabilities, selectedProbability: selectedProbability, reversalProbability: reversalProbability, latencyMs: Date.now() - t0 };
}

function applyDecision(state, decision, tape, supervisor, now) {
  const portfolio = state.portfolio;
  const direction = decision.choice === "up" ? "long" : decision.choice === "down" ? "short" : "flat";
  const confidence = Number.isFinite(decision.selectedProbability) ? decision.selectedProbability : 0;
  const required = Math.max(0.68, Number(supervisor.minConfidence || 0.68));
  let action = "hold";
  let reason = "No qualified trade.";

  if (portfolio.position) {
    const side = portfolio.position.side;
    const opposite = direction !== "flat" && direction !== side;
    if ((opposite && confidence >= Math.max(0.70, required)) || decision.reversalProbability >= 0.75) {
      closePosition(portfolio, tape.price, opposite ? "Jev high-confidence reversal" : "Jev reversal probability", now);
      action = "exit";
      reason = "Jev invalidated the open paper thesis.";
    } else {
      reason = "Open paper thesis remains within hard risk limits.";
    }
  } else if (supervisor.action !== "risk_off" && now - Number(portfolio.lastExitAt || 0) >= EXIT_COOLDOWN_MS) {
    const allowed = Array.isArray(supervisor.allowedDirections) ? supervisor.allowedDirections : [];
    if ((direction === "long" || direction === "short") && allowed.includes(direction) && confidence >= required) {
      if (openPosition(portfolio, direction, tape.price, now, supervisor)) {
        action = direction;
        reason = "Jev selected " + direction + " at " + (confidence * 100).toFixed(1) + "% probability.";
      }
    } else if (direction !== "flat") {
      reason = "Jev directional probability " + (confidence * 100).toFixed(1) + "% was below the " + (required * 100).toFixed(0) + "% entry floor.";
    }
  }

  state.model.lastDecision = {
    at: now, action: action, reason: reason, choice: decision.choice,
    probabilities: decision.probabilities, selectedProbability: decision.selectedProbability,
    reversalProbability: decision.reversalProbability, price: tape.price
  };
  updateRisk(portfolio, tape.price);
}

function parseCoinbase(raw, tape) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return false; }
  if (!msg || msg.product_id !== "BTC-USD") return false;
  const now = msg.time ? Date.parse(msg.time) : Date.now();
  if (msg.type === "ticker") {
    const price = Number(msg.price);
    if (!(price > 0)) return false;
    tape.price = price;
    tape.bid = Number(msg.best_bid || tape.bid || 0);
    tape.ask = Number(msg.best_ask || tape.ask || 0);
    tape.bidSize = Number(msg.best_bid_size || tape.bidSize || 0);
    tape.askSize = Number(msg.best_ask_size || tape.askSize || 0);
    tape.lastMessageAt = now;
    tape.points.push({ t: now, p: price });
    tape.points = tape.points.filter(function(x) { return now - x.t <= 70000; }).slice(-1200);
    return true;
  }
  if (msg.type === "match" || msg.type === "last_match" || msg.type === "heartbeat") tape.lastMessageAt = now;
  return false;
}

export async function jevRealtimeWindow(previousState, durationMs) {
  "use step";
  const state = structuredClone(previousState);
  const started = Date.now();
  const data = await Promise.all([getMultiMarketData(60), getMultiMarketData(300)]);
  const m1 = data[0], m5 = data[1];
  const b1 = Math.floor(started / 1000 / 60) * 60;
  const b5 = Math.floor(started / 1000 / 300) * 300;
  const c1 = m1.candles.filter(function(c) { return c.t < b1; });
  const c5 = m5.candles.filter(function(c) { return c.t < b5; });
  if (c1.length < 70 || c5.length < 70) throw new Error("Not enough closed candles for Jev context");
  const adaptive = adaptiveLeverageSignal(c1, c5);
  const context = { adaptive: adaptive };
  const tape = {
    price: Number(m1.ticker.price), bid: Number(m1.ticker.bid || 0), ask: Number(m1.ticker.ask || 0),
    bidSize: 0, askSize: 0, lastMessageAt: Date.now(), lastAskAt: 0,
    lastAskPrice: Number(m1.ticker.price), points: [{ t: Date.now(), p: Number(m1.ticker.price) }]
  };

  let busy = false, pending = false, closed = false, ws;

  async function decide() {
    if (busy || closed) { pending = true; return; }
    const now = Date.now();
    const fresh = now - tape.lastMessageAt <= FEED_STALE_MS;
    const supervisor = policy(state.portfolio, fresh, now, tape.price);
    hardExits(state.portfolio, tape.price, now, supervisor);
    updateRisk(state.portfolio, tape.price);
    if (!shouldAsk(tape, state.portfolio, now) || supervisor.action === "risk_off") return;
    busy = true;
    pending = false;
    tape.lastAskAt = now;
    tape.lastAskPrice = tape.price;
    try {
      const decision = await askJev(tape, context, state.portfolio, supervisor, now);
      state.model.calls += 1;
      state.model.latencyTotalMs += decision.latencyMs;
      state.model.lastLatencyMs = decision.latencyMs;
      state.model.lastError = null;
      applyDecision(state, decision, tape, supervisor, Date.now());
    } catch (error) {
      state.model.errors += 1;
      state.model.lastError = error && error.message ? error.message : "Jev evaluation failed";
    } finally {
      busy = false;
      if (pending && !closed && Date.now() - started < durationMs - 300) setTimeout(function() { void decide(); }, 0);
    }
  }

  await new Promise(function(resolve, reject) {
    const timer = setTimeout(function() { reject(new Error("Coinbase WebSocket open timeout")); }, 5000);
    ws = new WebSocket(COINBASE_WS);
    ws.onopen = function() {
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker","matches","heartbeat"] }));
      resolve();
    };
    ws.onerror = function() { clearTimeout(timer); reject(new Error("Coinbase WebSocket failed to open")); };
  });

  ws.onmessage = function(event) {
    const changed = parseCoinbase(typeof event.data === "string" ? event.data : String(event.data), tape);
    const now = Date.now();
    const fresh = now - tape.lastMessageAt <= FEED_STALE_MS;
    const supervisor = policy(state.portfolio, fresh, now, tape.price);
    hardExits(state.portfolio, tape.price, now, supervisor);
    updateRisk(state.portfolio, tape.price);
    if (changed) void decide();
  };

  await new Promise(function(resolve) { setTimeout(resolve, durationMs); });
  closed = true;
  try { ws.close(); } catch {}
  const until = Date.now() + MODEL_TIMEOUT_MS + 300;
  while (busy && Date.now() < until) await new Promise(function(resolve) { setTimeout(resolve, 25); });

  const ended = Date.now();
  const fresh = ended - tape.lastMessageAt <= FEED_STALE_MS;
  const supervisor = policy(state.portfolio, fresh, ended, tape.price);
  hardExits(state.portfolio, tape.price, ended, supervisor);
  updateRisk(state.portfolio, tape.price);
  state.windowCount += 1;

  return {
    state: state,
    snapshot: {
      status: fresh ? "running" : "degraded",
      mode: "jev-realtime-paper",
      heartbeatAt: ended,
      startedAt: state.startedAt,
      windowCount: state.windowCount,
      liveWindowSeconds: durationMs / 1000,
      market: {
        price: tape.price, bid: tape.bid, ask: tape.ask, lastMessageAt: tape.lastMessageAt,
        provider: "coinbase-websocket", latest1mBar: c1[c1.length - 1].t, latest5mBar: c5[c5.length - 1].t
      },
      variant: summarize(state.portfolio, tape.price),
      jev: {
        model: "typesafe-ai/jev",
        provider: "vercel-ai-gateway",
        authentication: "vercel-oidc",
        decisionMode: "event-driven live tape",
        minDecisionGapMs: MIN_ASK_GAP_MS,
        flatRefreshMs: FLAT_REFRESH_MS,
        heldRefreshMs: HELD_REFRESH_MS,
        priceTriggerPct: MOVE_TRIGGER_PCT,
        calls: state.model.calls,
        errors: state.model.errors,
        averageLatencyMs: state.model.calls ? state.model.latencyTotalMs / state.model.calls : null,
        lastLatencyMs: state.model.lastLatencyMs,
        lastDecision: state.model.lastDecision,
        lastError: state.model.lastError,
        supervisor: supervisor,
        quantitativeContext: {
          adaptiveDirection: adaptive.direction,
          adaptiveScore: adaptive.score,
          fiveMinuteDirection: adaptive.slowDirection,
          fiveMinuteConfirmed: adaptive.confirmed
        },
        safety: {
          realOrders: false, hardMaxLeverage: HARD_MAX_LEVERAGE, hardDrawdownStopPct: HARD_DD_STOP,
          stopPct: STOP_PCT, targetPct: TARGET_PCT,
          modelCanIncreaseRisk: false, modelCanEnableRealOrders: false
        }
      },
      error: fresh ? null : "Coinbase live tape became stale."
    }
  };
}

export async function emitJev(snapshot) {
  "use step";
  const writer = getWritable({ namespace: "jev-realtime-state" }).getWriter();
  try { await writer.write(JSON.stringify(snapshot) + "\n"); }
  finally { writer.releaseLock(); }
}

export async function jevRealtimeEngine() {
  "use workflow";
  let state = newState();
  let first = true;
  while (true) {
    try {
      const result = await jevRealtimeWindow(state, first ? FIRST_WINDOW_MS : WINDOW_MS);
      state = result.state;
      await emitJev(result.snapshot);
    } catch (error) {
      await emitJev({
        status: "degraded",
        mode: "jev-realtime-paper",
        heartbeatAt: Date.now(),
        startedAt: state.startedAt,
        windowCount: state.windowCount,
        variant: summarize(state.portfolio, state.portfolio.position ? state.portfolio.position.entry : START_CASH),
        jev: {
          model: "typesafe-ai/jev", provider: "vercel-ai-gateway", authentication: "vercel-oidc",
          calls: state.model.calls, errors: state.model.errors, lastError: state.model.lastError,
          safety: { realOrders: false, hardMaxLeverage: HARD_MAX_LEVERAGE, modelCanEnableRealOrders: false }
        },
        error: error && error.message ? error.message : "Jev realtime window failed"
      });
    }
    first = false;
    await sleep("1s");
  }
}