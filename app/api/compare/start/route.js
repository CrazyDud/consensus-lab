import { getRun, start } from "workflow/api";
import { comparisonEngine } from "../../../../workflows/comparison-engine.js";

export const dynamic = "force-dynamic";

function decodeChunk(value, decoder) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return decoder.decode(value, { stream: true });
  return String(value ?? "");
}

function parseLatestJson(raw) {
  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

async function readLatestSnapshot(runId) {
  const run = getRun(runId);
  const reader = run.getReadable({ namespace: "compare-state", startIndex: -1 }).getReader();
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
    ]);
    if (result?.timeout || result?.done) throw new Error("No continuation snapshot available");
    const snapshot = parseLatestJson(decodeChunk(result.value, new TextDecoder()));
    if (!snapshot?.variants) throw new Error("Continuation snapshot is incomplete");
    return snapshot;
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

async function launch(continueFrom = null) {
  const seedSnapshot = continueFrom ? await readLatestSnapshot(continueFrom) : null;
  const args = seedSnapshot ? [seedSnapshot, continueFrom] : [];
  const run = await start(comparisonEngine, args);

  return Response.json({
    ok: true,
    runId: run.runId,
    continuedFrom: continueFrom || null,
    seedTickCount: seedSnapshot?.tickCount || 0,
    mode: "comparison-cloud-paper",
    checkIntervalSeconds: 60,
    variants: [
      "Strict Long",
      "Strict Long/Short",
      "Fast x1",
      "Fast x2",
      "Fast x3",
      "Fast x5",
      "Adaptive x1–x5",
      "Consensus Intelligence",
      "Buy & Hold",
      "Cash"
    ],
    note: seedSnapshot
      ? "Paper-only state-preserving continuation. Aggregate metrics, evidence counters, baselines, recent trade history, and open paper positions were carried forward."
      : "Paper trading only. No real-order execution."
  });
}

export async function POST(request) {
  const url = new URL(request.url);
  return launch(url.searchParams.get("continueFrom"));
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("bootstrap") !== "paper-only") {
    return Response.json({ error: "Use POST to start the comparison engine." }, { status: 405 });
  }
  return launch(url.searchParams.get("continueFrom"));
}
