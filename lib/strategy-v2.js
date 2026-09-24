export function sma(values, n) {
  if (values.length < n) return null;
  return values.slice(-n).reduce((sum, v) => sum + v, 0) / n;
}

export function ema(values, n) {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i += 1) e = values[i] * k + e * (1 - k);
  return e;
}

export function std(values, n) {
  if (values.length < n) return null;
  const x = values.slice(-n);
  const mean = x.reduce((sum, v) => sum + v, 0) / n;
  return Math.sqrt(x.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n);
}

export function rsi(values, n = 14) {
  if (values.length < n + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - n; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
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

export function computeModels(candles, barSeconds = 300) {
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
  const prevMacd = ema(close.slice(-81, -1), 12) - ema(close.slice(-81, -1), 26);
  const green = candles.slice(-6).filter((c) => c.c > c.o).length;
  const lookbackMinutes = Math.round((12 * barSeconds) / 60);

  return [
    model("EMA trend", e9 > e21 ? "bull" : "bear", Math.abs(e9 - e21) / price * 150, "EMA9 vs EMA21"),
    model("Session trend", s20 > s50 ? "bull" : "bear", Math.abs(s20 - s50) / price * 100, "SMA20 vs SMA50"),
    model("Momentum", roc > 0.18 ? "bull" : roc < -0.18 ? "bear" : "neutral", Math.abs(roc) / 1.2, `${lookbackMinutes}m ROC ${roc.toFixed(2)}%`),
    model("RSI regime", currentRsi > 54 && currentRsi < 72 ? "bull" : currentRsi < 46 && currentRsi > 28 ? "bear" : "neutral", Math.abs(currentRsi - 50) / 25, `RSI ${currentRsi.toFixed(1)}`),
    model("20-bar breakout", price > hi20 ? "bull" : price < lo20 ? "bear" : "neutral", 0.9, "Price vs prior range"),
    model("VWAP pressure", price > vwap * 1.001 ? "bull" : price < vwap * 0.999 ? "bear" : "neutral", Math.abs(price - vwap) / price * 250, "Price vs rolling VWAP"),
    model("MACD impulse", macd > 0 && macd > prevMacd ? "bull" : macd < 0 && macd < prevMacd ? "bear" : "neutral", Math.abs(macd) / price * 500, `MACD ${macd.toFixed(2)}`),
    model("Bollinger reversion", price < lower ? "bull" : price > upper ? "bear" : "neutral", 0.75, "20-bar ±2σ"),
    model("Volume confirmation", volRatio > 1.25 ? (candles.at(-1).c > candles.at(-1).o ? "bull" : "bear") : "neutral", Math.max(0, (volRatio - 1) / 1.5), `Volume ${volRatio.toFixed(2)}× avg`),
    model("Candle structure", green >= 4 ? "bull" : green <= 2 ? "bear" : "neutral", Math.abs(green - 3) / 3, `${green}/6 green`),
  ];
}

export function summarize(models) {
  const bullish = models.filter((m) => m.vote === "bull").length;
  const bearish = models.filter((m) => m.vote === "bear").length;
  const neutral = models.length - bullish - bearish;
  const bullWeight = models.filter((m) => m.vote === "bull").reduce((s, m) => s + m.strength, 0);
  const bearWeight = models.filter((m) => m.vote === "bear").reduce((s, m) => s + m.strength, 0);
  return { bullish, bearish, neutral, bullWeight, bearWeight };
}

export function strictSignal(candles, threshold = 8, barSeconds = 300) {
  const models = computeModels(candles, barSeconds);
  if (models.length < 10) return { models, bullish: 0, bearish: 0, neutral: 10, direction: "flat", decision: "WARMING UP" };
  const counts = summarize(models);
  let direction = "flat";
  if (counts.bullish >= threshold && counts.bullish >= counts.bearish + 3) direction = "long";
  else if (counts.bearish >= threshold && counts.bearish >= counts.bullish + 3) direction = "short";
  return {
    models,
    ...counts,
    direction,
    decision: direction === "long" ? "LONG SETUP" : direction === "short" ? "SHORT SETUP" : "NO TRADE",
  };
}

export function fastSignal(candles, barSeconds = 60) {
  const models = computeModels(candles, barSeconds);
  if (models.length < 10) return { models, bullish: 0, bearish: 0, neutral: 10, direction: "flat", decision: "WARMING UP", score: 0 };
  const counts = summarize(models);
  const score = counts.bullWeight - counts.bearWeight;
  let direction = "flat";
  if (counts.bullish >= 6 && counts.bullish >= counts.bearish + 2 && score >= 1.8) direction = "long";
  else if (counts.bearish >= 6 && counts.bearish >= counts.bullish + 2 && score <= -1.8) direction = "short";
  return {
    models,
    ...counts,
    score,
    direction,
    decision: direction === "long" ? "LONG SETUP" : direction === "short" ? "SHORT SETUP" : "NO TRADE",
  };
}

export function adaptiveLeverageSignal(oneMinuteCandles, fiveMinuteCandles) {
  const fast = fastSignal(oneMinuteCandles, 60);
  const slow = strictSignal(fiveMinuteCandles, 7, 300);

  if (fast.direction === "flat") return { ...fast, leverage: 1, slowDirection: slow.direction, confirmed: false };
  const confirmed = slow.direction === fast.direction || (
    fast.direction === "long" ? slow.bullish >= 6 : slow.bearish >= 6
  );

  const dominant = fast.direction === "long" ? fast.bullish : fast.bearish;
  let leverage = 1;
  if (confirmed && dominant >= 7) leverage = 2;
  if (confirmed && dominant >= 8) leverage = 3;
  if (confirmed && dominant >= 9) leverage = 5;

  return {
    ...fast,
    leverage,
    slowDirection: slow.direction,
    confirmed,
    decision: fast.direction === "long" ? `LONG x${leverage}` : `SHORT x${leverage}`,
  };
}
