import { getWritable, sleep } from "workflow";
import { getMarketData } from "../lib/market.js";
import { consensus } from "../lib/strategy.js";

const CHECK_INTERVAL = "5m";

function defaultState(config = {}) {
  const startCash = Number(config.startCash || 1000);
  return {
    startCash,
    cash: startCash,
    threshold: Number(config.threshold || 8),
    sizePct: Number(config.sizePct || 20),
    stopPct: Number(config.stopPct || 1.2),
    targetPct: Number(config.targetPct || 2.0),
    maxBars: Number(config.maxBars || 24),
    feePct: Number(config.feePct || 0.15),
    slipPct: Number(config.slipPct || 0.03),
    position: null,
    trades: [],
    peak: startCash,
    maxDD: 0,
    lastDecisionBar: 0,
    tickCount: 0,
    startedAt: Date.now(),
  };
}

function paperEquity(state, price) {
  if (!state.position) return state.cash;
  return state.cash + state.position.qty * price * (1 - state.feePct / 100);
}

function closePosition(state, price, reason, now) {
  if (!state.position) return state;
  const position = state.position;
  const exit = price * (1 - state.slipPct / 100);
  const gross = position.qty * exit;
  const exitFee = gross * state.feePct / 100;
  const proceeds = gross - exitFee;
  const pnl = proceeds - (position.qty * position.entry + position.entryFee);

  state.cash += proceeds;
  state.trades = [
    {
      time: now,
      entry: position.entry,
      exit,
      qty: position.qty,
      pnl,
      fees: position.entryFee + exitFee,
      reason,
    },
    ...state.trades,
  ].slice(0, 200);
  state.position = null;
  return state;
}

function openPosition(state, price, barTime, now) {
  const entry = price * (1 + state.slipPct / 100);
  let allocation = state.cash * state.sizePct / 100;
  const feeRate = state.feePct / 100;
  if (allocation * (1 + feeRate) > state.cash) {
    allocation = state.cash / (1 + feeRate);
  }
  const entryFee = allocation * feeRate;
  const qty = allocation / entry;

  state.cash -= allocation + entryFee;
  state.position = {
    entry,
    qty,
    entryBar: barTime,
    entryTime: now,
    stop: entry * (1 - state.stopPct / 100),
    target: entry * (1 + state.targetPct / 100),
    entryFee,
  };
  return state;
}

export async function runPaperTick(previousState) {
  "use step";

  const state = structuredClone(previousState);
  const now = Date.now();

  try {
    const market = await getMarketData();
    const currentBucket = Math.floor(now / 1000 / 300) * 300;
    const closedCandles = market.candles.filter((c) => c.t < currentBucket);
    if (closedCandles.length < 70) throw new Error("Not enough closed 5-minute candles");

    const price = Number(market.ticker.price);
    const latestBar = closedCandles.at(-1);
    const signal = consensus(closedCandles, state.threshold);

    if (state.position) {
      const heldBars = Math.max(0, Math.floor((latestBar.t - state.position.entryBar) / 300));
      if (price <= state.position.stop) {
        closePosition(state, price, "Stop loss", now);
      } else if (price >= state.position.target) {
        closePosition(state, price, "Profit target", now);
      } else if (heldBars >= state.maxBars) {
        closePosition(state, price, "Maximum hold", now);
      } else if (signal.bearish >= 6) {
        closePosition(state, price, "Bearish consensus", now);
      }
    }

    if (!state.position && latestBar.t !== state.lastDecisionBar) {
      if (signal.decision === "LONG SETUP") {
        openPosition(state, price, latestBar.t, now);
      }
      state.lastDecisionBar = latestBar.t;
    }

    const equity = paperEquity(state, price);
    state.peak = Math.max(state.peak || state.startCash, equity);
    const drawdown = state.peak > 0 ? ((state.peak - equity) / state.peak) * 100 : 0;
    state.maxDD = Math.max(state.maxDD || 0, drawdown);
    state.tickCount += 1;

    const wins = state.trades.filter((t) => t.pnl > 0).length;
    const losses = state.trades.filter((t) => t.pnl <= 0).length;

    return {
      state,
      snapshot: {
        status: "running",
        mode: "cloud-paper",
        heartbeatAt: now,
        nextCheckApproxAt: now + 5 * 60 * 1000,
        checkIntervalSeconds: 300,
        provider: market.provider,
        fallback: Boolean(market.fallback),
        price,
        latestClosedBar: latestBar.t,
        signal,
        account: {
          startCash: state.startCash,
          cash: state.cash,
          equity,
          netReturnPct: (equity / state.startCash - 1) * 100,
          maxDrawdownPct: state.maxDD,
          closedTrades: state.trades.length,
          wins,
          losses,
        },
        position: state.position,
        trades: state.trades.slice(0, 50),
        config: {
          threshold: state.threshold,
          sizePct: state.sizePct,
          stopPct: state.stopPct,
          targetPct: state.targetPct,
          maxBars: state.maxBars,
          feePct: state.feePct,
          slipPct: state.slipPct,
        },
        tickCount: state.tickCount,
        startedAt: state.startedAt,
      },
    };
  } catch (error) {
    state.tickCount += 1;
    return {
      state,
      snapshot: {
        status: "degraded",
        mode: "cloud-paper",
        heartbeatAt: now,
        nextCheckApproxAt: now + 5 * 60 * 1000,
        checkIntervalSeconds: 300,
        error: error?.message || "Unknown market-data error",
        account: {
          startCash: state.startCash,
          cash: state.cash,
          equity: state.cash,
          netReturnPct: (state.cash / state.startCash - 1) * 100,
          maxDrawdownPct: state.maxDD,
          closedTrades: state.trades.length,
          wins: state.trades.filter((t) => t.pnl > 0).length,
          losses: state.trades.filter((t) => t.pnl <= 0).length,
        },
        position: state.position,
        trades: state.trades.slice(0, 50),
        config: {
          threshold: state.threshold,
          sizePct: state.sizePct,
          stopPct: state.stopPct,
          targetPct: state.targetPct,
          maxBars: state.maxBars,
          feePct: state.feePct,
          slipPct: state.slipPct,
        },
        tickCount: state.tickCount,
        startedAt: state.startedAt,
      },
    };
  }
}

export async function emitSnapshot(snapshot) {
  "use step";
  const writer = getWritable({ namespace: "state" }).getWriter();
  try {
    await writer.write(JSON.stringify(snapshot) + "\n");
  } finally {
    writer.releaseLock();
  }
}

export async function paperEngine(config = {}) {
  "use workflow";

  let state = defaultState(config);

  while (true) {
    const result = await runPaperTick(state);
    state = result.state;
    await emitSnapshot(result.snapshot);
    await sleep(CHECK_INTERVAL);
  }
}
