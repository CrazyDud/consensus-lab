"use client";

import { useEffect, useState } from "react";

const DEFAULT_RUN_ID = "wrun_01M3AM017EFMX2AZ3WN6XSXJCK";

function money(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return "$" + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function age(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + "s ago";
  return Math.floor(s / 60) + "m ago";
}

export default function IntelligencePage() {
  const [runId] = useState(DEFAULT_RUN_ID);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [, clock] = useState(0);

  useEffect(() => {
    const t = setInterval(() => clock((v) => v + 1), 1000);
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
        if (!response.ok) throw new Error(data.error || "Intelligence data unavailable");
        if (!stopped) {
          setSnapshot(data.snapshot);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError(e.message || "Intelligence data unavailable");
      }
    }
    load();
    const t = setInterval(load, 15000);
    return () => { stopped = true; clearInterval(t); };
  }, [runId]);

  const intel = snapshot?.variants?.intelligence;
  const meta = snapshot?.intelligence;
  const advice = meta?.gptAdvice;
  const learning = meta?.learning;
  const evaluation = meta?.evaluation;
  const forecast = intel?.signal;
  const live = snapshot?.heartbeatAt && Date.now() - snapshot.heartbeatAt < 3 * 60 * 1000;

  return (
    <>
      <header>
        <div className="brand">Consensus <span>INTELLIGENCE v0.6</span></div>
        <div className="sub">Quant engine + GPT supervisor · shadow paper trading only</div>
      </header>

      <main className="wrap">
        <div className={"cloudBanner " + (error ? "bad" : live ? "" : "warn")}>
          <div>
            <div className="cloudTitle">{error ? "INTELLIGENCE ISSUE" : live ? "INTELLIGENCE RUNNING" : "CONNECTING"}</div>
            <div className="cloudMeta">
              {snapshot ? "Cloud tick #" + snapshot.tickCount + " · last update " + age(snapshot.heartbeatAt) + " · 1-minute cycle" : "Waiting for live cohort…"}
            </div>
          </div>
          <span className={"dot " + (error ? "bad" : live ? "" : "warn")} />
        </div>

        {error ? <div className="card" style={{ marginBottom: 12 }}><strong className="neg">{error}</strong></div> : null}

        <div className="grid">
          <div className="card">
            <div className="label">Shadow equity</div>
            <div className="big">{money(intel?.equity)}</div>
            <div className="small">{pct(intel?.returnPct)} after simulated costs</div>
          </div>
          <div className="card">
            <div className="label">Current forecast</div>
            <div className={"big " + (forecast?.direction === "long" ? "pos" : forecast?.direction === "short" ? "neg" : "")}>
              {String(forecast?.direction || "WAIT").toUpperCase()}
            </div>
            <div className="small">{forecast?.confidence ? (forecast.confidence * 100).toFixed(1) + "% internal confidence" : "No qualifying edge"}</div>
          </div>
          <div className="card">
            <div className="label">Leverage cap/use</div>
            <div className="big">x{forecast?.leverage || 1}</div>
            <div className="small">hard capped at x3</div>
          </div>
          <div className="card">
            <div className="label">Closed trades</div>
            <div className="big">{intel?.closedTrades || 0}</div>
            <div className="small">{intel?.wins || 0} wins · {intel?.losses || 0} losses</div>
          </div>

          <div className="card wide">
            <div className="row">
              <div>
                <div className="label">GPT supervisory policy</div>
                <div className="mid">{String(advice?.action || "neutral").toUpperCase()}</div>
              </div>
              <div className="pill">external review layer</div>
            </div>
            <div className="small" style={{ marginTop: 7 }}>
              {advice?.reason || advice?.regimeNote || "Neutral bootstrap policy. The GPT layer may only reduce/restrict risk; it cannot increase the quant engine beyond its own limits."}
            </div>
            <div className="compareMetrics">
              <div><span>Directions</span><strong>{(advice?.allowedDirections || ["long","short"]).join("/")}</strong></div>
              <div><span>Risk multiplier</span><strong>{Number(advice?.riskMultiplier ?? 1).toFixed(2)}x</strong></div>
              <div><span>Max leverage</span><strong>x{advice?.maxLeverage || 3}</strong></div>
              <div><span>Min confidence</span><strong>{((advice?.minConfidence || .58) * 100).toFixed(0)}%</strong></div>
            </div>
          </div>

          <div className="card wide">
            <div className="row">
              <div>
                <div className="label">Evidence check</div>
                <div className="mid">{evaluation?.verdict || "Collecting evidence"}</div>
              </div>
              <div className="pill">{evaluation?.stage || "COLLECTING"}</div>
            </div>
            <div className="small" style={{ marginTop: 7 }}>{evaluation?.nextGate || "First gate: 20 closed trades + 100 resolved 15-minute forecasts."}</div>
            <div className="compareMetrics">
              <div><span>Resolved forecasts</span><strong>{learning?.resolvedForecasts || 0}</strong></div>
              <div><span>Direction accuracy</span><strong>{learning?.directionalAccuracyPct == null ? "—" : learning.directionalAccuracyPct.toFixed(1) + "%"}</strong></div>
              <div><span>Profit factor</span><strong>{intel?.profitFactor == null ? "—" : Number(intel.profitFactor).toFixed(2)}</strong></div>
              <div><span>Max drawdown</span><strong>{Number(intel?.maxDrawdownPct || 0).toFixed(2)}%</strong></div>
            </div>
          </div>

          <div className="card wide">
            <div className="row">
              <div>
                <div className="label">Current shadow position</div>
                <div className="mid">{intel?.position ? String(intel.position.side).toUpperCase() + " x" + intel.position.leverage : "FLAT"}</div>
              </div>
              <div className="pill">{money(snapshot?.market?.price)} BTC</div>
            </div>
            <div className="small" style={{ marginTop: 7 }}>
              {intel?.position ? "Entry " + money(intel.position.entry) + " · stop " + money(intel.position.stop) + " · target " + money(intel.position.target) : "Waiting for the numerical engine and GPT risk filters to agree."}
            </div>
          </div>

          <div className="card wide">
            <div className="label">Benchmarks</div>
            <div className="compareMetrics">
              <div><span>Intelligence</span><strong>{pct(intel?.returnPct)}</strong></div>
              <div><span>Buy & Hold</span><strong>{pct(snapshot?.baselines?.buyHold?.returnPct)}</strong></div>
              <div><span>Cash</span><strong>+0.00%</strong></div>
              <div><span>Real money</span><strong className="neg">OFF</strong></div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="mid">Safety architecture</div>
          <div className="small" style={{ marginTop: 7 }}>
            The one-minute quant layer remains the primary decision engine. GPT is a slower supervisor that can raise the confidence requirement, restrict long/short directions, lower the risk multiplier, lower the leverage cap, or switch to risk-off. It cannot increase risk above the quant engine's hard limits.
          </div>
        </div>
      </main>
    </>
  );
}
