# Consensus Lab

Mobile-first BTC market research and paper-trading experiment.

## v0.3

- Real public BTC-USD market data.
- Same-origin `/api/market` proxy so the mobile web app does not depend on browser CORS access to an exchange API.
- Coinbase Exchange is the primary public market-data source; Kraken is a server-side fallback.
- 10 transparent technical rule families produce bullish/bearish/neutral votes.
- Strict consensus gate (8/10 bullish by default) before simulated long entries.
- Long-only local paper account, fees, slippage, stop, target, maximum hold, drawdown and journal.
- No API keys, exchange account, wallet access, withdrawal access or real-order endpoints.

## Important

This is research software, not evidence of a profitable strategy. The model votes are heuristics and are **not** calibrated probabilities. Do not interpret an 8/10 vote as an 80% chance of profit.

The paper account currently persists in the browser using `localStorage`. The trading loop runs while the page is active; it is not yet a 24/7 server-side trader.

## Deploy

The repo is Vercel-ready. Import the GitHub repository into Vercel and deploy with the default settings. `index.html` is static and `api/market.js` is a serverless function.

## Next milestones

1. Cloud-side persistent paper-trading engine that continues with the phone closed.
2. Durable storage for candles, decisions, equity and trade journal.
3. Walk-forward evaluation against cash and buy-and-hold baselines.
4. Model calibration and regime-aware weighting.
5. Alerts only after statistically meaningful paper-trading evidence.

Real-money execution is deliberately out of scope until the strategy survives substantial out-of-sample and live paper testing.
