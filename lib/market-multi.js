const COINBASE = "https://api.exchange.coinbase.com";
const KRAKEN = "https://api.kraken.com/0/public";

function normalizeCoinbase(rows) {
  return rows
    .map((r) => ({
      t: Number(r[0]),
      l: Number(r[1]),
      h: Number(r[2]),
      o: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]),
    }))
    .sort((a, b) => a.t - b.t);
}

function normalizeGranularity(seconds) {
  return Number(seconds) === 60 ? 60 : 300;
}

async function coinbase(seconds) {
  const granularity = normalizeGranularity(seconds);
  const end = Math.floor(Date.now() / 1000);
  const start = end - 299 * granularity;
  const headers = { "User-Agent": "consensus-lab/0.5" };

  const candleUrl =
    COINBASE +
    "/products/BTC-USD/candles?granularity=" +
    granularity +
    "&start=" +
    encodeURIComponent(new Date(start * 1000).toISOString()) +
    "&end=" +
    encodeURIComponent(new Date(end * 1000).toISOString());

  const [cr, tr] = await Promise.all([
    fetch(candleUrl, { headers, cache: "no-store" }),
    fetch(COINBASE + "/products/BTC-USD/ticker", { headers, cache: "no-store" }),
  ]);

  if (!cr.ok || !tr.ok) throw new Error("Coinbase market request failed");

  const rows = await cr.json();
  const ticker = await tr.json();

  if (!Array.isArray(rows) || rows.length < 70 || !ticker?.price) {
    throw new Error("Coinbase returned incomplete market data");
  }

  return {
    provider: "coinbase",
    granularity,
    candles: normalizeCoinbase(rows),
    ticker: {
      price: Number(ticker.price),
      bid: Number(ticker.bid),
      ask: Number(ticker.ask),
      time: ticker.time || new Date().toISOString(),
    },
  };
}

async function kraken(seconds) {
  const granularity = normalizeGranularity(seconds);
  const interval = granularity === 60 ? 1 : 5;

  const [or, tr] = await Promise.all([
    fetch(KRAKEN + "/OHLC?pair=XBTUSD&interval=" + interval, { cache: "no-store" }),
    fetch(KRAKEN + "/Ticker?pair=XBTUSD", { cache: "no-store" }),
  ]);

  if (!or.ok || !tr.ok) throw new Error("Kraken market request failed");

  const ohlc = await or.json();
  const ticker = await tr.json();
  const candleKey = Object.keys(ohlc.result || {}).find((key) => key !== "last");
  const tickerKey = Object.keys(ticker.result || {})[0];
  const rows = (ohlc.result?.[candleKey] || []).slice(-300);
  const tk = ticker.result?.[tickerKey];

  if (rows.length < 70 || !tk) throw new Error("Kraken returned incomplete market data");

  return {
    provider: "kraken",
    granularity,
    candles: rows
      .map((r) => ({
        t: Number(r[0]),
        l: Number(r[3]),
        h: Number(r[2]),
        o: Number(r[1]),
        c: Number(r[4]),
        v: Number(r[6]),
      }))
      .sort((a, b) => a.t - b.t),
    ticker: {
      price: Number(tk.c?.[0]),
      bid: Number(tk.b?.[0]),
      ask: Number(tk.a?.[0]),
      time: new Date().toISOString(),
    },
  };
}

export async function getMultiMarketData(seconds = 300) {
  try {
    return await coinbase(seconds);
  } catch (primaryError) {
    try {
      const fallback = await kraken(seconds);
      return { ...fallback, fallback: true, primaryError: primaryError.message };
    } catch (fallbackError) {
      const error = new Error("Both BTC market-data providers are unavailable");
      error.details = {
        coinbase: primaryError.message,
        kraken: fallbackError.message,
      };
      throw error;
    }
  }
}
