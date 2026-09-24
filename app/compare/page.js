"use client";

import { useEffect, useMemo, useState } from "react";

const DEFAULT_COMPARE_RUN_ID = "wrun_01M3AETHNBNWCD1JRG5QK5RN8R";

function money(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return "$" + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  return m < 60 ? m + "m ago" : Math.floor(m / 60) + "h " + (m % 60) + "m ago";
}

export default function ComparePage() {
  const [runId, setRunId] = useState(DEFAULT_COMPARE_RUN_ID);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!runId) return;
    let stopped = false;

    async function load() {
      try {
        const response = await fetch("/api/compare/peek?runId=" + encodeURIComponent(runId), { cache: "no-store" });
        const data = await response.json();
        if (response.status === 202) return;
        if (!response.ok) throw new Error(data.error || "Comparison state unavailable");
        if (!stopped) {
          setSnapshot(data.snapshot || null);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError(e.message || "Comparison state unavailable");
      }
    }

    load();
    const timer = setInterval(load, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId]);

  const rows = useMemo(() => {
    const variants = snapshot?.variants || {};
    const result = Object.entries(variants).map(([key, value]) => ({ key, ...value }));
    if (snapshot?.baselines?.buyHold) result.push({ key: "buyHold", ...snapshot.baselines.buyHold, baseline: true });
    if (snapshot?.baselines?.cash) result.push({ key: "cash", ...snapshot.baselines.cash, baseline: true });
    return result.sort((a, b) => Number(b.returnPct || 0) - Number(a.returnPct || 0));
  }, [snapshot]);

  const live = snapshot?.heartbeatAt && Date.now() - snapshot.heartbeatAt < 3 * 60 * 1000;
  const openPositions = rows.filter((r) => r.position).length;

  return (
    <>
      <header>
        <div className="brand">Consensus Lab <span>COMPARE v0.5</span></div>
        <div className="sub">Multiple paper strategies running side-by-side from the same market</div>
      </header>

      <main className="wrap">
        <div className={"cloudBanner " + (error ? "bad" : live ? "" : "warn")}>
          <div>
            <div className="cloudTitle">
              {error ? "COMPARISON ENGINE ISSUE" : live ? "COMPARISON ENGINE RUNNING" : "CONNECTING TO COMPARISON ENGINE"}
            </div>
            <div className="cloudMeta">
              {snapshot
                ? "Last tick " + ago(snapshot.heartbeatAt) + " · every 1 minute · tick #" + snapshot.tickCount
                : runId
                  ? "Loading first comparison snapshot…"
                  : "Comparison run has not been linked yet."}
            </div>
          </div>
          <span className={"dot " + (error ? "bad" : live ? "" : "warn")} />
        </div>

        {error ? <div className="card" style={{ marginBottom: 12 }}><div className="neg"><strong>{error}</strong></div></div> : null}

        <div className="grid">
          <div className="card">
            <div className="label">BTC price</div>
            <div className="big">{money(snapshot?.market?.price)}</div>
            <div className="small">{snapshot?.market?.provider1m || "—"} 1m feed</div>
          </div>
          <div className="card">
            <div className="label">Strategies</div>
            <div className="big">7</div>
            <div className="small">+ buy & hold + cash</div>
          </div>
          <div className="card">
            <div className="label">Open positions</div>
            <div className="big">{openPositions}</div>
            <div className="small">across paper variants</div>
          </div>
          <div className="card">
            <div className="label">Adaptive leverage</div>
            <div className="big">x1–x5</div>
            <div className="small">chosen by signal strength</div>
          </div>

          <div className="card wide">
            <div className="row">
              <div>
                <div className="label">Live comparison</div>
                <div className="mid">Same $1,000 starting balance per strategy</div>
              </div>
              <div className="pill">paper only</div>
            </div>
            <div className="small" style={{ marginTop: 7 }}>
              Strict Long, Strict Long/Short, Fast x1/x2/x3/x5, and Adaptive x1–x5 are evaluated independently. Fees and slippage are included; leveraged accounts also include a funding-cost proxy.
            </div>
          </div>
        </div>

        <div className="compareList">
          {rows.map((row, index) => {
            const pos = row.position;
            return (
              <div className="compareCard" key={row.key}>
                <div className="row">
                  <div>
                    <div className="compareRank">#{index + 1}</div>
                    <div className="mid">{row.label}</div>
                    <div className="small">{row.timeframe || (row.baseline ? "baseline" : "")}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className={"compareReturn " + (Number(row.returnPct) > 0 ? "pos" : Number(row.returnPct) < 0 ? "neg" : "")}>
                      {pct(row.returnPct)}
                    </div>
                    <div className="small">{money(row.equity)}</div>
                  </div>
                </div>

                {!row.baseline ? (
                  <>
                    <div className="compareMetrics">
                      <div><span>Trades</span><strong>{row.closedTrades || 0}</strong></div>
                      <div><span>Win rate</span><strong>{row.winRatePct == null ? "—" : row.winRatePct.toFixed(1) + "%"}</strong></div>
                      <div><span>Max DD</span><strong>{Number(row.maxDrawdownPct || 0).toFixed(2)}%</strong></div>
                      <div><span>Fees</span><strong>{money(row.feesPaid || 0)}</strong></div>
                    </div>
                    <div className="positionStrip">
                      {pos
                        ? (pos.side === "long" ? "LONG" : "SHORT") + " x" + pos.leverage + " · entry " + money(pos.entry)
                        : "FLAT · waiting for signal"}
                    </div>
                    {row.key === "adaptive" ? (
                      <div className="small" style={{ marginTop: 7 }}>
                        Current signal leverage: x{row.signal?.leverage || 1} · 5m confirmed: {row.signal?.confirmed ? "yes" : "no"}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="positionStrip">Passive benchmark</div>
                )}
              </div>
            );
          })}
          {!rows.length ? <div className="card empty">Waiting for the first comparison tick.</div> : null}
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="mid">How adaptive leverage is chosen</div>
          <div className="small" style={{ marginTop: 7 }}>
            Fast consensus starts at x1. With 5-minute confirmation it moves to x2 at 7 dominant votes, x3 at 8, and x5 only at 9–10. This is a paper experiment, not a recommendation to use leverage with real funds.
          </div>
          <div className="kv"><span className="small">Check frequency</span><strong>1 minute</strong></div>
          <div className="kv"><span className="small">Strict decisions</span><strong>5-minute closed bars</strong></div>
          <div className="kv"><span className="small">Fast decisions</span><strong>1-minute closed bars</strong></div>
          <div className="kv"><span className="small">Max tested leverage</span><strong>x5</strong></div>
          <div className="kv"><span className="small">Real order capability</span><strong className="neg">Disabled</strong></div>
        </div>
      </main>
    </>
  );
}
