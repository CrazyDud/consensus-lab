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
    config,
  };
}

function initialState() {
  const portfolios = {};
  for (const [key, config] of Object.entries(CONFIGS)) portfolios[key] = makePortfolio(config);
  return {
    portfolios,
    buyHold: null,
    startedAt: Date.now(),
    tickCount: 0,
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

function openPosition(portfolio, side, price, barTime, leverage, now) {
  const feeRate = FEE_PCT / 100;
  const slipPct = SLIP_PCT;
  let margin = portfolio.cash * portfolio.config.sizePct / 100;
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

function summarizePortfolio(portfolio, price) {
  const equity = portfolioEquity(portfolio, price);
  const wins = portfolio.trades.filter((t) => t.pnl > 0).length;
  const losses = portfolio.trades.filter((t) => t.pnl <= 0).length;
  const grossWin = portfolio.trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(portfolio.trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  return {
    label: portfolio.config.label,
    timeframe: portfolio.config.timeframe,
    equity,
    returnPct: (equity / START_CASH - 1) * 100,
    cash: portfolio.cash,
    maxDrawdownPct: portfolio.maxDD,
    closedTrades: portfolio.trades.length,
    wins,
    losses,
    winRatePct: portfolio.trades.length ? (wins / portfolio.trades.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : null,
    feesPaid: portfolio.feesPaid,
    fundingPaid: portfolio.fundingPaid,
    position: portfolio.position,
    signal: portfolio.lastSignal,
    config: portfolio.config,
    trades: portfolio.trades.slice(0, 30),
  };
}

function processPortfolio(portfolio, signal, price, latestBar, barSeconds, now, forcedLeverage = null) {
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
      openPosition(portfolio, direction, price, latestBar.t, leverage, now);
    }
    portfolio.lastDecisionBar = latestBar.t;
  }

  portfolio.lastSignal = signal;
  updateRisk(portfolio, price);
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
  const strict = strictSignal(c5, 8, 300);
  const fast = fastSignal(c1, 60);
  const adaptive = adaptiveLeverageSignal(c1, c5);

  const strictLongSignal = { ...strict, direction: strict.direction === "long" ? "long" : "flat" };

  processPortfolio(state.portfolios.strictLong, strictLongSignal, price, c5.at(-1), 300, now, 1);
  processPortfolio(state.portfolios.strictTwoWay, strict, price, c5.at(-1), 300, now, 1);
  processPortfolio(state.portfolios.fastX1, fast, price, c1.at(-1), 60, now, 1);
  processPortfolio(state.portfolios.fastX2, fast, price, c1.at(-1), 60, now, 2);
  processPortfolio(state.portfolios.fastX3, fast, price, c1.at(-1), 60, now, 3);
  processPortfolio(state.portfolios.fastX5, fast, price, c1.at(-1), 60, now, 5);
  processPortfolio(state.portfolios.adaptive, adaptive, price, c1.at(-1), 60, now, adaptive.leverage || 1);

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
  const snapshot = {
    status: "running",
    mode: "comparison-cloud-paper",
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
    variants,
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

export async function comparisonEngine() {
  "use workflow";

  let state = initialState();

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
