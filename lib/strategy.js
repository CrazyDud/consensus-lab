export function sma(values, n) {
  if (values.length < n) return null;
  return values.slice(-n).reduce((sum, value) => sum + value, 0) / n;
}

export function ema(values, n) {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let value = values[0];
  for (let i = 1; i < values.length; i += 1) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

export function std(values, n) {
  if (values.length < n) return null;
  const sample = values.slice(-n);
  const mean = sample.reduce((sum, value) => sum + value, 0) / n;
  return Math.sqrt(sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n);
}

export function rsi(values, n = 14) {
  if (values.length < n + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - n; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (!losses) return 100;
  const rs = (gains / n) / (losses / n);
  return 100 - 100 / (1 + rs);
}

function model(name, vote, strength, detail) {
  return {
    name,
    vote,
    strength: Math.max(0, Math.min(1, Number.isFinite(strength) ? strength : 0)),
    detail,
  };
}

export function computeModels(candles) {
  if (!Array.isArray(candles) || candles.length < 70) return [];

  const close = candles.map((c) => c.c);
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const volume = candles.map((c) => c.v);
  const price = close.at(-1);

  const e9 = ema(close.slice(-80), 9);
  const e21 = ema(close.slice(-80), 21);
  const s20 = sma(close, 20);
  const s50 = sma(close, 50);
  const currentRsi = rsi(close);
  const roc = (price / close.at(-13) - 1) * 100;
  const sigma = std(close, 20);
  const upper = s20 + 2 * sigma;
  const lower = s20 - 2 * sigma;
  const hi20 = Math.max(...high.slice(-21, -1));
  const lo20 = Math.min(...low.slice(-21, -1));
  const volRatio = volume.at(-1) / (sma(volume, 20) || 1);
  const recent30 = candles.slice(-30);
  const vwap =
    recent30.reduce((sum, c) => sum + ((c.h + c.l + c.c) / 3) * c.v, 0) /
    recent30.reduce((sum, c) => sum + c.v, 0);
  const macd = ema(close.slice(-80), 12) - ema(close.slice(-80), 26);
  const previousMacd = ema(close.slice(-81, -1), 12) - ema(close.slice(-81, -1), 26);
  const green = candles.slice(-6).filter((c) => c.c > c.o).length;

  return [
    model("EMA trend", e9 > e21 ? "bull" : "bear", Math.abs(e9 - e21) / price * 150, "EMA9 vs EMA21"),
    model("Session trend", s20 > s50 ? "bull" : "bear", Math.abs(s20 - s50) / price * 100, "SMA20 vs SMA50"),
    model("Momentum 1h", roc > 0.18 ? "bull" : roc < -0.18 ? "bear" : "neutral", Math.abs(roc) / 1.2, `12-bar ROC ${roc.toFixed(2)}%`),
    model("RSI regime", currentRsi > 54 && currentRsi < 72 ? "bull" : currentRsi < 46 && currentRsi > 28 ? "bear" : "neutral", Math.abs(currentRsi - 50) / 25, `RSI ${currentRsi.toFixed(1)}`),
    model("20-bar breakout", price > hi20 ? "bull" : price < lo20 ? "bear" : "neutral", 0.9, "Price vs prior 20-bar range"),
    model("VWAP pressure", price > vwap * 1.001 ? "bull" : price < vwap * 0.999 ? "bear" : "neutral", Math.abs(price - vwap) / price * 250, "Price vs rolling VWAP"),
    model("MACD impulse", macd > 0 && macd > previousMacd ? "bull" : macd < 0 && macd < previousMacd ? "bear" : "neutral", Math.abs(macd) / price * 500, `MACD ${macd.toFixed(2)}`),
    model("Bollinger reversion", price < lower ? "bull" : price > upper ? "bear" : "neutral", 0.75, "20-bar ±2σ"),
    model("Volume confirmation", volRatio > 1.25 ? (candles.at(-1).c > candles.at(-1).o ? "bull" : "bear") : "neutral", Math.max(0, (volRatio - 1) / 1.5), `Volume ${volRatio.toFixed(2)}× avg`),
    model("Candle structure", green >= 4 ? "bull" : green <= 2 ? "bear" : "neutral", Math.abs(green - 3) / 3, `${green}/6 green`),
  ];
}

export function consensus(candles, threshold = 8) {
  const models = computeModels(candles);
  const bullish = models.filter((m) => m.vote === "bull").length;
  const bearish = models.filter((m) => m.vote === "bear").length;
  const neutral = 10 - bullish - bearish;

  let decision = "NO TRADE";
  let reason = "Consensus below threshold.";

  if (models.length < 10) {
    decision = "WARMING UP";
    reason = "Need at least 70 real 5-minute candles.";
  } else if (bullish >= threshold && bullish >= bearish + 3) {
    decision = "LONG SETUP";
    reason = `${bullish}/10 models bullish; threshold is ${threshold}.`;
  } else if (bearish >= threshold) {
    decision = "RISK-OFF";
    reason = `${bearish}/10 models bearish. The paper engine is long-only.`;
  }

  return { models, bullish, bearish, neutral, decision, reason };
}
