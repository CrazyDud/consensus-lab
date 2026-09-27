import { getWritable, sleep } from "workflow";
import { getMultiMarketData } from "../lib/market-multi.js";
import { strictSignal, fastSignal, adaptiveLeverageSignal } from "../lib/strategy-v2.js";

const START_CASH = 1000;
const FEE_PCT = 0.15;
const SLIP_PCT = 0.03;
const FUNDING_PROXY_RATE = 0.0001;
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

const CONFIGS = {
  strictLong: {
    label: "Strict Long",
    timeframe: "5m",
    signal: "strict",
    allowShort: false,
    leverageMode: "fixed",
    leverage: 1,
    sizePct: 20,
    stopPct: 1.2,
    targetPct: 2.0,
    maxBars: 24,
  },
  strictTwoWay: {
    label: "Strict Long/Short",
    timeframe: "5m",
    signal: "strict",
    allowShort: true,
    leverageMode: "fixed",
    leverage: 1,
    sizePct: 20,
    stopPct: 1.2,
    targetPct: 2.0,
    maxBars: 24,
  },
  fastX1: {
    label: "Fast x1",
    timeframe: "1m",
    signal: "fast",
    allowShort: true,
    leverageMode: "fixed",
    leverage: 1,
    sizePct: 10,
    stopPct: 0.7,
    targetPct: 1.1,
    maxBars: 60,
  },
  fastX2: {
    label: "Fast x2",
    timeframe: "1m",
    signal: "fast",
    allowShort: true,
    leverageMode: "fixed",
    leverage: 2,
    sizePct: 10,
    stopPct: 0.7,
    targetPct: 1.1,
    maxBars: 60,
  },
  fastX3: {
    label: "Fast x3",
    timeframe: "1m",
    signal: "fast",
    allowShort: true,
    leverageMode: "fixed",
    leverage: 3,
    sizePct: 10,
    stopPct: 0.7,
    targetPct: 1.1,
    maxBars: 60,
  },
  fastX5: {
    label: "Fast x5",
    timeframe: "1m",
    signal: "fast",
    allowShort: true,
    leverageMode: "fixed",
    leverage: 5,
    sizePct: 10,
    stopPct: 0.7,
    targetPct: 1.1,
    maxBars: 60,
  },
  adaptive: {
    label: "Adaptive x1–x5",
    timeframe: "1m + 5m",
    signal: "adaptive",
    allowShort: true,
    leverageMode: "adaptive",
    leverage: 1,
    sizePct: 10,
    stopPct: 0.7,
    targetPct: 1.1,
    maxBars: 60,
  },
  intelligence: {
    label: "Consensus Intelligence",
    timeframe: "1m + 5m + GPT supervisor",
    signal: "intelligence",
    allowShort: true,
    leverageMode: "adaptive-capped",
    leverage: 1,
    sizePct: 10,
    stopPct: 0.7,
    targetPct: 1.2,
    maxBars: 90,
  },
};

function makePortfolio(config) {
  return {
    cash: START_CASH,
    startCash: START_CASH,
    position: null,
    trades: [],
    peak: START_CASH,
    maxDD: 0,
    feesPaid: 0,
    fundingPaid: 0,
    lastDecisionBar: 0,
    lastSignal: null,
    historical: {
      closedTrades: 0,
      wins: 0,
      losses: 0,
      grossWin: 0,
      grossLoss: 0,
    },
    historicalRecentTrades: [],
    config,
  };
}

function deriveHistoricalStats(summary) {
  const closedTrades = Math.max(0, Number(summary?.closedTrades || 0));
  const wins = Math.max(0, Number(summary?.wins || 0));
  const losses = Math.max(0, Number(summary?.losses || Math.max(0, closedTrades - wins)));
  const position = summary?.position || null;
  const preOpenCash = Number(summary?.cash ?? START_CASH) +
    (position ? Number(position.initialMargin ?? position.margin ?? 0) + Number(position.entryFee || 0) : 0);
  const netClosedPnl = preOpenCash - START_CASH + Number(summary?.fundingPaid || 0);
  const pf = Number(summary?.profitFactor);

  let grossWin = 0;
  let grossLoss = 0;
  if (wins === 0) {
    grossLoss = Math.max(0, -netClosedPnl);
  } else if (losses === 0) {
    grossWin = Math.max(0, netClosedPnl);
  } else if (Number.isFinite(pf) && pf >= 0 && Math.abs(pf - 1) > 1e-9) {
    grossLoss = netClosedPnl / (pf - 1);
    grossWin = pf * grossLoss;
    if (!Number.isFinite(grossLoss) || grossLoss < 0 || !Number.isFinite(grossWin) || grossWin < 0) {
      grossLoss = Math.max(0, -netClosedPnl);
      grossWin = Math.max(0, netClosedPnl + grossLoss);
    }
  } else {
    grossLoss = Math.max(0, -netClosedPnl);
    grossWin = Math.max(0, netClosedPnl + grossLoss);
  }

  return { closedTrades, wins, losses, grossWin, grossLoss };
}

function portfolioFromSnapshot(key, config, summary, snapshot) {
  if (!summary) return makePortfolio(config);

  const portfolio = makePortfolio(config);
  const equity = Number(summary.equity || START_CASH);
  const maxDD = Math.max(0, Number(summary.maxDrawdownPct || 0));
  const impliedPeak = maxDD < 99.9 ? equity / Math.max(1e-6, 1 - maxDD / 100) : START_CASH;

  portfolio.cash = Number(summary.cash ?? equity);
  portfolio.position = summary.position ? structuredClone(summary.position) : null;
  portfolio.peak = Math.max(START_CASH, impliedPeak, equity);
  portfolio.maxDD = maxDD;
  portfolio.feesPaid = Number(summary.feesPaid || 0);
  portfolio.fundingPaid = Number(summary.fundingPaid || 0);
  portfolio.lastDecisionBar = String(config.timeframe || "").startsWith("5m")
    ? Number(snapshot?.market?.latest5mBar || 0)
    : Number(snapshot?.market?.latest1mBar || 0);
  portfolio.lastSignal = summary.signal ? structuredClone(summary.signal) : null;
  portfolio.historical = deriveHistoricalStats(summary);
  portfolio.historicalRecentTrades = Array.isArray(summary.trades)
    ? structuredClone(summary.trades.slice(0, 30))
    : [];
  return portfolio;
}

function initialState(seedSnapshot = null, continuedFromRunId = null) {
  if (!seedSnapshot?.variants) {
    const portfolios = {};
    for (const [key, config] of Object.entries(CONFIGS)) portfolios[key] = makePortfolio(config);
    return {
      portfolios,
      buyHold: null,
      intelligenceLearning: { pending: [], resolved: 0, correct: 0, lastForecastBar: 0 },
      startedAt: Date.now(),
      tickCount: 0,
      continuity: null,
    };
  }

  const portfolios = {};
  for (const [key, config] of Object.entries(CONFIGS)) {
    portfolios[key] = portfolioFromSnapshot(key, config, seedSnapshot.variants[key], seedSnapshot);
  }

  const buyHoldEntry = Number(seedSnapshot?.baselines?.buyHold?.entry || seedSnapshot?.market?.price || 0);
  const buyHoldFee = START_CASH * (FEE_PCT / 100);
  const resolved = Math.max(0, Number(seedSnapshot?.intelligence?.learning?.resolvedForecasts || 0));
  const accuracyPct = Number(seedSnapshot?.intelligence?.learning?.directionalAccuracyPct);
  const correct = resolved && Number.isFinite(accuracyPct)
    ? Math.max(0, Math.min(resolved, Math.round(resolved * accuracyPct / 100)))
    : 0;

  return {
    portfolios,
    buyHold: buyHoldEntry > 0 ? {
      entry: buyHoldEntry,
      qty: (START_CASH - buyHoldFee) / buyHoldEntry,
      entryFee: buyHoldFee,
    } : null,
    intelligenceLearning: {
      pending: [],
      resolved,
      correct,
      lastForecastBar: Number(seedSnapshot?.market?.latest1mBar || 0),
    },
    startedAt: Number(seedSnapshot.startedAt || Date.now()),
    tickCount: Math.max(0, Number(seedSnapshot.tickCount || 0)),
    continuity: {
      continuedFromRunId: continuedFromRunId || null,
      continuedAt: Date.now(),
      seedHeartbeatAt: Number(seedSnapshot.heartbeatAt || 0),
      seedTickCount: Math.max(0, Number(seedSnapshot.tickCount || 0)),
      note: "State-preserving continuation after infrastructure repair; aggregate trade/evidence metrics and open paper positions were carried forward.",
    },
  };
}

function entryPrice(side, price, slipPct) {
  return side === "long"
    ? price * (1 + slipPct / 100)
    : price * (1 - slipPct / 100);
}

function exitPrice(side, price, slipPct) {
  return side === "long"
    ? price * (1 - slipPct / 100)
    : price * (1 + slipPct / 100);
}

function unrealized(position, price) {
  if (!position) return 0;
  return position.side === "long"
    ? position.qty * (price - position.entry)
    : position.qty * (position.entry - price);
}

function portfolioEquity(portfolio, price) {
  if (!portfolio.position) return portfolio.cash;
  const p = portfolio.position;
  const estimatedExitFee = p.qty * price * (FEE_PCT / 100);
  return portfolio.cash + p.margin + unrealized(p, price) - estimatedExitFee;
}

function applyFunding(portfolio, now) {
  const p = portfolio.position;
  if (!p || p.leverage <= 1 || !p.nextFundingAt) return;
  while (now >= p.nextFundingAt) {
    const charge = p.notional * FUNDING_PROXY_RATE;
    p.margin = Math.max(0, p.margin - charge);
    portfolio.fundingPaid += charge;
    p.nextFundingAt += FUNDING_INTERVAL_MS;
  }
}

function openPosition(portfolio, side, price, barTime, leverage, now, sizeMultiplier = 1) {
  const feeRate = FEE_PCT / 100;
  const slipPct = SLIP_PCT;
  let margin = portfolio.cash * portfolio.config.sizePct / 100 * Math.max(0, Math.min(1, sizeMultiplier));
  const maxMargin = portfolio.cash / (1 + leverage * feeRate);
  margin = Math.min(margin, maxMargin);

  const entry = entryPrice(side, price, slipPct);
  const notional = margin * leverage;
  const qty = notional / entry;
  const entryFee = notional * feeRate;

  portfolio.cash -= margin + entryFee;
  portfolio.feesPaid += entryFee;

  const stop = side === "long"
    ? entry * (1 - portfolio.config.stopPct / 100)
    : entry * (1 + portfolio.config.stopPct / 100);
  const target = side === "long"
    ? entry * (1 + portfolio.config.targetPct / 100)
    : entry * (1 - portfolio.config.targetPct / 100);

  portfolio.position = {
    side,
    entry,
    qty,
    margin,
    initialMargin: margin,
    leverage,
    notional,
    entryFee,
    entryBar: barTime,
    entryTime: now,
    stop,
    target,
    nextFundingAt: leverage > 1 ? now + FUNDING_INTERVAL_MS : null,
  };
}

function closePosition(portfolio, price, reason, now) {
  const p = portfolio.position;
  if (!p) return;

  const exit = exitPrice(p.side, price, SLIP_PCT);
  const pnl = p.side === "long"
    ? p.qty * (exit - p.entry)
    : p.qty * (p.entry - exit);
  const exitFee = p.qty * exit * (FEE_PCT / 100);
  const returned = Math.max(0, p.margin + pnl - exitFee);

  portfolio.cash += returned;
  portfolio.feesPaid += exitFee;

  portfolio.trades = [
    {
      time: now,
      side: p.side,
      leverage: p.leverage,
      entry: p.entry,
      exit,
      pnl: returned - p.margin - p.entryFee,
      rawPnl: pnl,
      fees: p.entryFee + exitFee,
      reason,
    },
    ...portfolio.trades,
  ].slice(0, 300);

  portfolio.position = null;
}

function maybeLiquidate(portfolio, price, now) {
  const p = portfolio.position;
  if (!p || p.leverage <= 1) return false;
  const loss = unrealized(p, price);
  if (loss <= -0.9 * p.margin) {
    closePosition(portfolio, price, "Simulated isolated-margin liquidation", now);
    return true;
  }
  return false;
}

function updateRisk(portfolio, price) {
  const equity = portfolioEquity(portfolio, price);
  portfolio.peak = Math.max(portfolio.peak || START_CASH, equity);
  const dd = portfolio.peak > 0 ? ((portfolio.peak - equity) / portfolio.peak) * 100 : 0;
  portfolio.maxDD = Math.max(portfolio.maxDD || 0, dd);
}

function portfolioStats(portfolio) {
  const historical = portfolio.historical || {};
  const currentWins = portfolio.trades.filter((t) => Number(t.pnl) > 0).length;
  const currentLosses = portfolio.trades.filter((t) => Number(t.pnl) <= 0).length;
  const currentGrossWin = portfolio.trades
    .filter((t) => Number(t.pnl) > 0)
    .reduce((s, t) => s + Number(t.pnl || 0), 0);
  const currentGrossLoss = Math.abs(
    portfolio.trades
      .filter((t) => Number(t.pnl) < 0)
      .reduce((s, t) => s + Number(t.pnl || 0), 0)
  );

  return {
    closedTrades: Number(historical.closedTrades || 0) + portfolio.trades.length,
    wins: Number(historical.wins || 0) + currentWins,
    losses: Number(historical.losses || 0) + currentLosses,
    grossWin: Number(historical.grossWin || 0) + currentGrossWin,
    grossLoss: Number(historical.grossLoss || 0) + currentGrossLoss,
  };
}

function summarizePortfolio(portfolio, price) {
  const equity = portfolioEquity(portfolio, price);
  const stats = portfolioStats(portfolio);
  const recentTrades = [
    ...portfolio.trades,
    ...(Array.isArray(portfolio.historicalRecentTrades) ? portfolio.historicalRecentTrades : []),
  ].slice(0, 30);

  return {
    label: portfolio.config.label,
    timeframe: portfolio.config.timeframe,
    equity,
    returnPct: (equity / START_CASH - 1) * 100,
    cash: portfolio.cash,
    maxDrawdownPct: portfolio.maxDD,
    closedTrades: stats.closedTrades,
    wins: stats.wins,
    losses: stats.losses,
    winRatePct: stats.closedTrades ? (stats.wins / stats.closedTrades) * 100 : null,
    profitFactor: stats.grossLoss > 0 ? stats.grossWin / stats.grossLoss : stats.grossWin > 0 ? null : null,
    feesPaid: portfolio.feesPaid,
    fundingPaid: portfolio.fundingPaid,
    position: portfolio.position,
    signal: portfolio.lastSignal,
    config: portfolio.config,
    trades: recentTrades,
    continuity: portfolio.historical?.closedTrades ? {
      migratedClosedTrades: Number(portfolio.historical.closedTrades || 0),
      newClosedTrades: portfolio.trades.length,
    } : null,
  };
}

function processPortfolio(portfolio, signal, price, latestBar, barSeconds, now, forcedLeverage = null, sizeMultiplier = 1) {
  applyFunding(portfolio, now);
  if (maybeLiquidate(portfolio, price, now)) {
    updateRisk(portfolio, price);
    return;
  }

  const p = portfolio.position;
  if (p) {
    const heldBars = Math.max(0, Math.floor((latestBar.t - p.entryBar) / barSeconds));
    const opposite = signal.direction !== "flat" && signal.direction !== p.side;

    if (p.side === "long" && price <= p.stop) closePosition(portfolio, price, "Stop loss", now);
    else if (p.side === "short" && price >= p.stop) closePosition(portfolio, price, "Stop loss", now);
    else if (p.side === "long" && price >= p.target) closePosition(portfolio, price, "Profit target", now);
    else if (p.side === "short" && price <= p.target) closePosition(portfolio, price, "Profit target", now);
    else if (heldBars >= portfolio.config.maxBars) closePosition(portfolio, price, "Maximum hold", now);
    else if (opposite) closePosition(portfolio, price, "Opposite signal", now);
  }

  if (!portfolio.position && latestBar.t !== portfolio.lastDecisionBar) {
    const direction = signal.direction;
    const allowed = direction === "long" || (direction === "short" && portfolio.config.allowShort);
    if (allowed) {
      const leverage = forcedLeverage || portfolio.config.leverage || 1;
      openPosition(portfolio, direction, price, latestBar.t, leverage, now, sizeMultiplier);
    }
    portfolio.lastDecisionBar = latestBar.t;
  }

  portfolio.lastSignal = signal;
  updateRisk(portfolio, price);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fixedSupervisorPolicy(state, now, latest1mBar, latest5mBar, price) {
  const portfolio = state.portfolios.intelligence;
  const learning = state.intelligenceLearning;
  const resolved = Number(learning.resolved || 0);
  const accuracy = resolved > 0 ? Number(learning.correct || 0) / resolved : null;
  const stats = portfolioStats(portfolio);
  const winRate = stats.closedTrades ? stats.wins / stats.closedTrades : null;
  const profitFactor = stats.grossLoss > 0 ? stats.grossWin / stats.grossLoss : null;
  const equity = portfolioEquity(portfolio, price);
  const returnPct = (equity / START_CASH - 1) * 100;
  const age1mMs = now - Number(latest1mBar || 0) * 1000;
  const age5mMs = now - Number(latest5mBar || 0) * 1000;

  const base = {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    source: "repo-fixed-supervisor",
    action: "neutral",
    allowedDirections: ["long", "short"],
    riskMultiplier: 0.75,
    maxLeverage: 2,
    minConfidence: 0.62,
    regimeNote: "Conservative paper-only collection mode.",
    reason: "Fixed supervisor baseline: reduced sizing, x2 leverage cap, and elevated confidence floor while evidence accumulates.",
  };

  const stale = !Number.isFinite(age1mMs) || !Number.isFinite(age5mMs) || age1mMs > 3 * 60 * 1000 || age5mMs > 10 * 60 * 1000;
  if (stale) {
    return {
      ...base,
      action: "risk_off",
      allowedDirections: [],
      riskMultiplier: 0,
      maxLeverage: 1,
      minConfidence: 0.70,
      regimeNote: "Market data is stale or invalid.",
      reason: "Hard risk-off: the fixed supervisor will not permit new paper positions while market inputs are stale.",
    };
  }

  if (Number(portfolio.maxDD || 0) >= 3) {
    return {
      ...base,
      action: "risk_off",
      allowedDirections: [],
      riskMultiplier: 0,
      maxLeverage: 1,
      minConfidence: 0.72,
      regimeNote: "Consensus Intelligence drawdown reached the hard supervisory threshold.",
      reason: "Hard risk-off at 3% max drawdown; new paper entries remain disabled until the run is reviewed or restarted.",
    };
  }

  const weakForecastEvidence = resolved >= 50 && accuracy !== null && accuracy < 0.45;
  const weakTradeEvidence = stats.closedTrades >= 10 && returnPct < -0.5 && winRate !== null && winRate < 0.25 &&
    (profitFactor === null || profitFactor < 0.5);

  if (weakForecastEvidence || weakTradeEvidence) {
    return {
      ...base,
      riskMultiplier: 0.50,
      maxLeverage: 1,
      minConfidence: 0.68,
      regimeNote: "Early evidence is weak; continue paper-only learning at reduced exposure.",
      reason: "Caution tier: at least one broad-sample quality check is weak, so size is halved, leverage is capped at x1, and the confidence floor is raised without stopping data collection.",
    };
  }

  if (Number(portfolio.maxDD || 0) >= 1.5) {
    return {
      ...base,
      riskMultiplier: 0.35,
      maxLeverage: 1,
      minConfidence: 0.70,
      regimeNote: "Drawdown is elevated but remains below the hard stop.",
      reason: "Drawdown throttle: keep paper learning active with sharply reduced size, x1 leverage, and a higher confidence floor.",
    };
  }

  return base;
}

function resolveIntelligenceForecasts(state, price, now) {
  const keep = [];
  for (const item of state.intelligenceLearning.pending) {
    if (item.dueAt > now) {
      keep.push(item);
      continue;
    }
    const actualLong = price > item.price;
    if ((item.direction === "long") === actualLong) state.intelligenceLearning.correct += 1;
    state.intelligenceLearning.resolved += 1;
  }
  state.intelligenceLearning.pending = keep;
}

function intelligenceEvaluation(portfolio, learning, price, buyHoldEquity) {
  const summary = summarizePortfolio(portfolio, price);
  const accuracy = learning.resolved ? learning.correct / learning.resolved : null;
  const enough = summary.closedTrades >= 20 && learning.resolved >= 100;
  const promising = enough &&
    summary.returnPct > 0 &&
    summary.equity > buyHoldEquity &&
    summary.maxDrawdownPct < 8 &&
    accuracy !== null && accuracy > 0.52 &&
    summary.profitFactor !== null && summary.profitFactor > 1.15;

  return {
    stage: !enough ? "COLLECTING" : (summary.closedTrades >= 50 && learning.resolved >= 250 ? "MEANINGFUL" : "PRELIMINARY"),
    verdict: !enough ? "Not enough evidence yet" : (promising ? "Promising candidate edge" : "Not yet showing a convincing edge"),
    nextGate: summary.closedTrades < 20 || learning.resolved < 100
      ? "20 closed trades + 100 resolved 15-minute forecasts"
      : summary.closedTrades < 50 || learning.resolved < 250
        ? "50 closed trades + 250 resolved forecasts"
        : "100 closed trades + multiple market regimes",
    directionalAccuracyPct: accuracy === null ? null : accuracy * 100,
  };
}

export async function compareTick(previousState) {
  "use step";

  const state = structuredClone(previousState);
  const now = Date.now();

  const [m1, m5] = await Promise.all([
    getMultiMarketData(60),
    getMultiMarketData(300),
  ]);

  const oneMinuteBucket = Math.floor(now / 1000 / 60) * 60;
  const fiveMinuteBucket = Math.floor(now / 1000 / 300) * 300;
  const c1 = m1.candles.filter((c) => c.t < oneMinuteBucket);
  const c5 = m5.candles.filter((c) => c.t < fiveMinuteBucket);
  if (c1.length < 70 || c5.length < 70) throw new Error("Not enough closed candles");

  const price = Number(m1.ticker.price);
  const gptAdvice = fixedSupervisorPolicy(state, now, c1.at(-1)?.t, c5.at(-1)?.t, price);
  const strict = strictSignal(c5, 8, 300);
  const fast = fastSignal(c1, 60);
  const adaptive = adaptiveLeverageSignal(c1, c5);

  resolveIntelligenceForecasts(state, price, now);
  const rawConfidence = clamp(0.5 + Math.abs(Number(adaptive.score || 0)) * 0.12, 0.5, 0.85);
  const minConfidence = Math.max(0.58, Number(gptAdvice.minConfidence || 0.58));
  let intelligenceDirection = rawConfidence >= minConfidence ? adaptive.direction : "flat";
  const allowedDirections = Array.isArray(gptAdvice.allowedDirections) ? gptAdvice.allowedDirections : ["long", "short"];
  if (!allowedDirections.includes(intelligenceDirection) || gptAdvice.action === "risk_off") intelligenceDirection = "flat";
  const intelligenceLeverage = Math.min(clamp(Number(adaptive.leverage || 1), 1, 3), clamp(Number(gptAdvice.maxLeverage || 3), 1, 3));
  let intelligenceRisk = clamp(Number(gptAdvice.riskMultiplier ?? 1), 0, 1);
  if (!adaptive.confirmed && intelligenceDirection !== "flat") intelligenceRisk *= 0.7;
  if (state.portfolios.intelligence.maxDD >= 3) intelligenceRisk *= 0.5;
  if (state.portfolios.intelligence.maxDD >= 5) intelligenceRisk = 0;

  const intelligenceSignal = {
    ...adaptive,
    direction: intelligenceDirection,
    decision: intelligenceDirection === "flat" ? "NO TRADE" : intelligenceDirection.toUpperCase() + " x" + intelligenceLeverage,
    confidence: rawConfidence,
    leverage: intelligenceLeverage,
    riskMultiplier: intelligenceRisk,
    supervisor: gptAdvice,
  };

  if (c1.at(-1).t !== state.intelligenceLearning.lastForecastBar) {
    if (intelligenceDirection !== "flat") {
      state.intelligenceLearning.pending.push({
        dueAt: now + 15 * 60 * 1000,
        direction: intelligenceDirection,
        price,
        confidence: rawConfidence,
      });
      state.intelligenceLearning.pending = state.intelligenceLearning.pending.slice(-500);
    }
    state.intelligenceLearning.lastForecastBar = c1.at(-1).t;
  }

  const strictLongSignal = { ...strict, direction: strict.direction === "long" ? "long" : "flat" };

  processPortfolio(state.portfolios.strictLong, strictLongSignal, price, c5.at(-1), 300, now, 1);
  processPortfolio(state.portfolios.strictTwoWay, strict, price, c5.at(-1), 300, now, 1);
  processPortfolio(state.portfolios.fastX1, fast, price, c1.at(-1), 60, now, 1);
  processPortfolio(state.portfolios.fastX2, fast, price, c1.at(-1), 60, now, 2);
  processPortfolio(state.portfolios.fastX3, fast, price, c1.at(-1), 60, now, 3);
  processPortfolio(state.portfolios.fastX5, fast, price, c1.at(-1), 60, now, 5);
  processPortfolio(state.portfolios.adaptive, adaptive, price, c1.at(-1), 60, now, adaptive.leverage || 1);

  if (state.portfolios.intelligence.position) {
    const currentSide = state.portfolios.intelligence.position.side;
    if (gptAdvice.action === "risk_off" || !allowedDirections.includes(currentSide)) {
      closePosition(state.portfolios.intelligence, price, "GPT supervisor risk filter", now);
    }
  }
  processPortfolio(
    state.portfolios.intelligence,
    intelligenceSignal,
    price,
    c1.at(-1),
    60,
    now,
    intelligenceLeverage,
    intelligenceRisk
  );

  if (!state.buyHold) {
    const fee = START_CASH * (FEE_PCT / 100);
    state.buyHold = {
      entry: price,
      qty: (START_CASH - fee) / price,
      entryFee: fee,
    };
  }

  state.tickCount += 1;

  const variants = {};
  for (const [key, portfolio] of Object.entries(state.portfolios)) {
    variants[key] = summarizePortfolio(portfolio, price);
  }

  const buyHoldEquity = state.buyHold.qty * price * (1 - FEE_PCT / 100);
  const intelligenceEvaluationResult = intelligenceEvaluation(
    state.portfolios.intelligence,
    state.intelligenceLearning,
    price,
    buyHoldEquity
  );
  const snapshot = {
    status: "running",
    mode: "comparison-cloud-paper",
    heartbeatAt: now,
    nextCheckApproxAt: now + 60 * 1000,
    checkIntervalSeconds: 60,
    tickCount: state.tickCount,
    startedAt: state.startedAt,
    continuity: state.continuity,
    market: {
      price,
      provider1m: m1.provider,
      provider5m: m5.provider,
      latest1mBar: c1.at(-1).t,
      latest5mBar: c5.at(-1).t,
    },
    variants,
    intelligence: {
      gptAdvice,
      learning: {
        resolvedForecasts: state.intelligenceLearning.resolved,
        pendingForecasts: state.intelligenceLearning.pending.length,
        directionalAccuracyPct: state.intelligenceLearning.resolved
          ? (state.intelligenceLearning.correct / state.intelligenceLearning.resolved) * 100
          : null,
      },
      evaluation: intelligenceEvaluationResult,
      safety: {
        realOrders: false,
        maxLeverage: 3,
        gptCanIncreaseRisk: false,
        drawdownThrottlePct: 3,
        newEntriesStopPct: 5,
      },
    },
    baselines: {
      buyHold: {
        label: "Buy & Hold",
        equity: buyHoldEquity,
        returnPct: (buyHoldEquity / START_CASH - 1) * 100,
        entry: state.buyHold.entry,
      },
      cash: {
        label: "Cash",
        equity: START_CASH,
        returnPct: 0,
      },
    },
    notes: {
      feePct: FEE_PCT,
      slippagePct: SLIP_PCT,
      fundingProxy: "0.01% of notional every 8h on leveraged positions",
      leverage: "Adaptive chooses x1/x2/x3/x5 from fast consensus strength plus 5m confirmation.",
      execution: "Paper only; isolated-margin liquidation is simulated at ~90% margin loss.",
    },
  };

  return { state, snapshot };
}

export async function emitComparison(snapshot) {
  "use step";
  const writer = getWritable({ namespace: "compare-state" }).getWriter();
  try {
    await writer.write(JSON.stringify(snapshot) + "\n");
  } finally {
    writer.releaseLock();
  }
}

export async function comparisonEngine(seedSnapshot = null, continuedFromRunId = null) {
  "use workflow";

  let state = initialState(seedSnapshot, continuedFromRunId);

  while (true) {
    try {
      const result = await compareTick(state);
      state = result.state;
      await emitComparison(result.snapshot);
    } catch (error) {
      await emitComparison({
        status: "degraded",
        mode: "comparison-cloud-paper",
        heartbeatAt: Date.now(),
        nextCheckApproxAt: Date.now() + 60 * 1000,
        checkIntervalSeconds: 60,
        tickCount: state.tickCount,
        startedAt: state.startedAt,
        error: error?.message || "Comparison tick failed",
      });
    }
    await sleep("1m");
  }
}
