const COINBASE = "https://api.exchange.coinbase.com";
const KRAKEN = "https://api.kraken.com/0/public";

function normalizeCoinbase(rows) {
  return rows
    .map((r) => ({ t: Number(r[0]), l: Number(r[1]), h: Number(r[2]), o: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }))
    .sort((a, b) => a.t - b.t);
}

async function fromCoinbase() {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 299 * 300;
  const headers = { "User-Agent": "consensus-lab/0.4" };
  const [candleResponse, tickerResponse] = await Promise.all([
    fetch(`${COINBASE}/products/BTC-USD/candles?granularity=300&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`, { headers, cache: "no-store" }),
    fetch(`${COINBASE}/products/BTC-USD/ticker`, { headers, cache: "no-store" }),
  ]);

  if (!candleResponse.ok || !tickerResponse.ok) {
    throw new Error(`Coinbase HTTP ${candleResponse.status}/${tickerResponse.status}`);
  }

  const rawCandles = await candleResponse.json();
  const rawTicker = await tickerResponse.json();
  if (!Array.isArray(rawCandles) || rawCandles.length < 70 || !rawTicker?.price) {
    throw new Error("Coinbase returned incomplete market data");
  }

  return {
    provider: "coinbase",
    candles: normalizeCoinbase(rawCandles),
    ticker: {
      price: Number(rawTicker.price),
      bid: Number(rawTicker.bid),
      ask: Number(rawTicker.ask),
      time: rawTicker.time || new Date().toISOString(),
    },
  };
}

async function fromKraken() {
  const [ohlcResponse, tickerResponse] = await Promise.all([
    fetch(`${KRAKEN}/OHLC?pair=XBTUSD&interval=5`, { cache: "no-store" }),
    fetch(`${KRAKEN}/Ticker?pair=XBTUSD`, { cache: "no-store" }),
  ]);

  if (!ohlcResponse.ok || !tickerResponse.ok) {
    throw new Error(`Kraken HTTP ${ohlcResponse.status}/${tickerResponse.status}`);
  }

  const ohlc = await ohlcResponse.json();
  const ticker = await tickerResponse.json();
  if (ohlc.error?.length || ticker.error?.length) throw new Error("Kraken API error");

  const candleKey = Object.keys(ohlc.result || {}).find((key) => key !== "last");
  const tickerKey = Object.keys(ticker.result || {})[0];
  const rows = (ohlc.result?.[candleKey] || []).slice(-300);
  const rawTicker = ticker.result?.[tickerKey];

  if (rows.length < 70 || !rawTicker) throw new Error("Kraken returned incomplete market data");

  return {
    provider: "kraken",
    candles: rows
      .map((r) => ({ t: Number(r[0]), l: Number(r[3]), h: Number(r[2]), o: Number(r[1]), c: Number(r[4]), v: Number(r[6]) }))
      .sort((a, b) => a.t - b.t),
    ticker: {
      price: Number(rawTicker.c?.[0]),
      bid: Number(rawTicker.b?.[0]),
      ask: Number(rawTicker.a?.[0]),
      time: new Date().toISOString(),
    },
  };
}

export async function getMarketData() {
  try {
    return await fromCoinbase();
  } catch (coinbaseError) {
    try {
      const fallback = await fromKraken();
      return { ...fallback, fallback: true, primaryError: coinbaseError.message };
    } catch (krakenError) {
      const error = new Error("Both public BTC market-data providers are unavailable");
      error.details = { coinbase: coinbaseError.message, kraken: krakenError.message };
      throw error;
    }
  }
}
