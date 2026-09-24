"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_RUN_ID = "";

function money(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return "$" + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function ago(ms) {
  if (!ms) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function PriceChart({ candles = [] }) {
  const points = useMemo(() => {
    const data = candles.slice(-90);
    if (data.length < 2) return "";
    const values = data.map((c) => Number(c.c));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return data
      .map((c, i) => {
        const x = 4 + (i / (data.length - 1)) * 92;
        const y = 92 - ((Number(c.c) - min) / span) * 82;
        return `${x},${y}`;
      })
      .join(" ");
  }, [candles]);

  return (
    <div className="chartWrap">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="BTC price chart">
        <defs>
          <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#8ce0bd" stopOpacity=".22" />
            <stop offset="100%" stopColor="#8ce0bd" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[20, 40, 60, 80].map((y) => (
          <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="#22313d" strokeWidth=".3" />
        ))}
        {points ? (
          <>
            <polyline points={`4,96 ${points} 96,96`} fill="url(#fill)" stroke="none" />
            <polyline points={points} fill="none" stroke="#8ce0bd" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
          </>
        ) : null}
      </svg>
    </div>
  );
}

export default function Home() {
  const [tab, setTab] = useState("overview");
  const [runId, setRunId] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [market, setMarket] = useState(null);
  const [marketError, setMarketError] = useState("");
  const [streamError, setStreamError] = useState("");
  const [starting, setStarting] = useState(false);
  const [, forceClock] = useState(0);
  const abortRef = useRef(null);

  useEffect(() => {
    const timer = setInterval(() => forceClock((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("run");
    const saved = window.localStorage.getItem("consensusCloudRunId");
    const initial = fromUrl || saved || DEFAULT_RUN_ID;
    if (initial) {
      setRunId(initial);
      window.localStorage.setItem("consensusCloudRunId", initial);
      if (fromUrl) {
        window.history.replaceState({}, "", window.location.pathname);
      }
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    async function loadMarket() {
      try {
        const response = await fetch("/api/market", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (!stopped) {
          setMarket(data);
          setMarketError("");
        }
      } catch (error) {
        if (!stopped) setMarketError(error.message || "Market data unavailable");
      }
    }
    loadMarket();
    const timer = setInterval(loadMarket, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    const controller = new AbortController();
    abortRef.current = controller;

    async function connect() {
      setStreamError("");
      try {
        const response = await fetch(`/api/engine/stream?runId=${encodeURIComponent(runId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const body = await response.text();
          throw new Error(body || `HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              setSnapshot(parsed);
              setStreamError("");
            } catch {
              // Ignore non-JSON framing data.
            }
          }
        }
      } catch (error) {
        if (!stopped && error.name !== "AbortError") {
          setStreamError(error.message || "Cloud stream disconnected");
        }
      }
    }

    connect();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [runId]);

  async function startCloudEngine() {
    if (starting) return;
    setStarting(true);
    setStreamError("");
    try {
      const response = await fetch("/api/engine/start", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setRunId(data.runId);
      window.localStorage.setItem("consensusCloudRunId", data.runId);
      setSnapshot(null);
    } catch (error) {
      setStreamError(error.message || "Could not start cloud engine");
    } finally {
      setStarting(false);
    }
  }

  const heartbeatAge = snapshot?.heartbeatAt ? Date.now() - snapshot.heartbeatAt : Infinity;
  const engineFresh = heartbeatAge < 10 * 60 * 1000;
  const engineClass = !runId ? "bad" : snapshot?.status === "degraded" ? "warn" : engineFresh ? "" : "warn";
  const engineTitle = !runId
    ? "CLOUD ENGINE NOT STARTED"
    : !snapshot
      ? "CONNECTING TO CLOUD ENGINE"
      : snapshot.status === "degraded"
        ? "CLOUD ENGINE DEGRADED"
        : engineFresh
          ? "CLOUD ENGINE RUNNING 24/7"
          : "CLOUD ENGINE RECONNECTING";

  const account = snapshot?.account || {
    startCash: 1000,
    equity: 1000,
    netReturnPct: 0,
    maxDrawdownPct: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
  };
  const signal = snapshot?.signal || { bullish: 0, bearish: 0, neutral: 10, decision: "WAITING", reason: "Waiting for the cloud engine.", models: [] };
  const livePrice = market?.ticker?.price ?? snapshot?.price;
  const candles = market?.candles || [];
  const oneHourMove = candles.length > 13 && livePrice
    ? ((Number(livePrice) / Number(candles.at(-13).c)) - 1) * 100
    : null;

  return (
    <>
      <header>
        <div className="brand">Consensus Lab <span>CLOUD v0.4</span></div>
        <div className="sub">24/7 server-side BTC paper research · phone can be closed</div>
      </header>

      <main className="wrap">
        <div className={`cloudBanner ${engineClass}`}>
          <div>
            <div className="cloudTitle">{engineTitle}</div>
            <div className="cloudMeta">
              {snapshot
                ? `Last cloud check ${ago(snapshot.heartbeatAt)} · checks every 5 minutes · ${snapshot.provider || "market feed"}`
                : runId
                  ? "Connecting to the durable workflow and replaying its latest state…"
                  : "Start once; Vercel keeps the paper engine alive without your phone."}
            </div>
          </div>
          <span className={`dot ${engineClass}`} />
        </div>

        {!runId ? (
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="mid">Start the 24/7 cloud paper engine</div>
            <div className="small" style={{ marginTop: 5 }}>
              This starts a durable Vercel workflow. It uses no exchange keys and cannot place real orders.
            </div>
            <div className="controls">
              <button className="primary" onClick={startCloudEngine} disabled={starting}>
                {starting ? "Starting…" : "Start cloud engine"}
              </button>
            </div>
          </div>
        ) : null}

        {streamError ? (
          <div className="card" style={{ marginBottom: 12, borderColor: "#6a2c39" }}>
            <div className="neg" style={{ fontWeight: 850 }}>Cloud stream issue</div>
            <div className="small" style={{ marginTop: 5 }}>{streamError}</div>
          </div>
        ) : null}

        <section className={`section ${tab === "overview" ? "active" : ""}`}>
          <div className="grid">
            <div className="card">
              <div className="label">Cloud paper equity</div>
              <div className="big">{money(account.equity)}</div>
              <div className="small">{money(account.startCash)} start</div>
            </div>
            <div className="card">
              <div className="label">Net return</div>
              <div className={`big ${Number(account.netReturnPct) > 0 ? "pos" : Number(account.netReturnPct) < 0 ? "neg" : ""}`}>{pct(account.netReturnPct)}</div>
              <div className="small">fees + slippage simulated</div>
            </div>
            <div className="card">
              <div className="label">Max drawdown</div>
              <div className="big amber">{Number(account.maxDrawdownPct || 0).toFixed(2)}%</div>
              <div className="small">since cloud engine start</div>
            </div>
            <div className="card">
              <div className="label">Closed trades</div>
              <div className="big">{account.closedTrades || 0}</div>
              <div className="small">{account.wins || 0} wins · {account.losses || 0} losses</div>
            </div>

            <div className="card wide">
              <div className="row">
                <div>
                  <div className="label">Bitcoin BTC / USD</div>
                  <div className="big">{money(livePrice)}</div>
                </div>
                <div className={`pill ${marketError ? "neg" : "pos"}`}>
                  {marketError ? "DATA ERROR" : `LIVE ${String(market?.provider || snapshot?.provider || "").toUpperCase()}`}
                </div>
              </div>
              <div className="small">
                {marketError
                  ? marketError
                  : oneHourMove == null
                    ? "Loading market history…"
                    : `1h move ${oneHourMove >= 0 ? "+" : ""}${oneHourMove.toFixed(2)}%`}
              </div>
              <PriceChart candles={candles} />
            </div>

            <div className="card wide">
              <div className="row">
                <div>
                  <div className="label">Cloud consensus decision</div>
                  <div className={`mid ${signal.decision === "LONG SETUP" ? "pos" : signal.decision === "RISK-OFF" ? "neg" : ""}`}>{signal.decision}</div>
                </div>
                <div className="pill">{signal.bullish} bull · {signal.bearish} bear · {signal.neutral} neutral</div>
              </div>
              <div className="small" style={{ marginTop: 7 }}>{signal.reason}</div>
            </div>

            <div className="card wide">
              <div className="row">
                <div>
                  <div className="label">Current cloud paper position</div>
                  <div className="mid">{snapshot?.position ? `LONG ${Number(snapshot.position.qty).toFixed(6)} BTC` : "FLAT"}</div>
                </div>
                <div className="pill">{snapshot?.tickCount ? `tick #${snapshot.tickCount}` : "waiting"}</div>
              </div>
              <div className="small" style={{ marginTop: 7 }}>
                {snapshot?.position
                  ? `Entry ${money(snapshot.position.entry)} · stop ${money(snapshot.position.stop)} · target ${money(snapshot.position.target)}`
                  : "No open simulated position. The cloud engine is waiting for a qualifying signal."}
              </div>
            </div>
          </div>
        </section>

        <section className={`section ${tab === "signals" ? "active" : ""}`}>
          <div className="card">
            <div className="row">
              <div>
                <div className="label">Cloud signal ensemble</div>
                <div className="mid">10 transparent rule families</div>
              </div>
              <div className="pill">{signal.bullish}/{signal.bearish}/{signal.neutral}</div>
            </div>
            <div className="small" style={{ marginTop: 7 }}>Votes are heuristics, not calibrated win probabilities.</div>
            <div className="models">
              {(signal.models || []).map((model) => (
                <div className="model" key={model.name}>
                  <div className="small">{model.name}</div>
                  <div className={`modelVote ${model.vote === "bull" ? "pos" : model.vote === "bear" ? "neg" : ""}`}>{String(model.vote).toUpperCase()}</div>
                  <div className="bar"><i style={{ width: `${Math.round((model.strength || 0) * 100)}%` }} /></div>
                  <div className="small" style={{ marginTop: 6 }}>{model.detail}</div>
                </div>
              ))}
            </div>
            {!signal.models?.length ? <div className="empty">Waiting for the first cloud tick.</div> : null}
          </div>
        </section>

        <section className={`section ${tab === "journal" ? "active" : ""}`}>
          <div className="card">
            <div className="row">
              <div>
                <div className="label">Cloud paper journal</div>
                <div className="mid">Trades survive phone shutdown</div>
              </div>
              <div className="pill">{snapshot?.trades?.length || 0} shown</div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Time</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Reason</th></tr></thead>
                <tbody>
                  {(snapshot?.trades || []).map((trade, index) => (
                    <tr key={`${trade.time}-${index}`}>
                      <td>{new Date(trade.time).toLocaleString()}</td>
                      <td>{money(trade.entry)}</td>
                      <td>{money(trade.exit)}</td>
                      <td className={trade.pnl >= 0 ? "pos" : "neg"}>{trade.pnl >= 0 ? "+" : ""}{money(trade.pnl)}</td>
                      <td>{trade.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!snapshot?.trades?.length ? <div className="empty">No closed cloud paper trades yet.</div> : null}
          </div>
        </section>

        <section className={`section ${tab === "settings" ? "active" : ""}`}>
          <div className="card">
            <div className="label">Cloud engine configuration</div>
            <div className="mid">Locked for this experiment</div>
            <div className="small" style={{ margin: "6px 0 10px" }}>Keeping assumptions fixed avoids quietly tuning the strategy after seeing results.</div>
            {Object.entries(snapshot?.config || {
              threshold: 8, sizePct: 20, stopPct: 1.2, targetPct: 2, maxBars: 24, feePct: 0.15, slipPct: 0.03,
            }).map(([key, value]) => (
              <div className="kv" key={key}><span className="small">{key}</span><strong>{String(value)}</strong></div>
            ))}
            <div className="kv"><span className="small">Cloud run ID</span><span className="mono">{runId || "not started"}</span></div>
            <div className="kv"><span className="small">Phone required</span><strong className="pos">No</strong></div>
            <div className="kv"><span className="small">Real-order capability</span><strong className="neg">Disabled</strong></div>
          </div>
        </section>
      </main>

      <nav className="tabs">
        {[
          ["overview", "Overview"],
          ["signals", "Signals"],
          ["journal", "Journal"],
          ["settings", "Settings"],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
    </>
  );
}
