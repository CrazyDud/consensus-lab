import { start } from "workflow/api";
import { paperEngine } from "../../../../workflows/paper-engine.js";

export const dynamic = "force-dynamic";

const DEFAULT_CONFIG = {
  startCash: 1000,
  threshold: 8,
  sizePct: 20,
  stopPct: 1.2,
  targetPct: 2.0,
  maxBars: 24,
  feePct: 0.15,
  slipPct: 0.03,
};

async function startEngine() {
  const run = await start(paperEngine, [DEFAULT_CONFIG]);
  return Response.json({
    ok: true,
    runId: run.runId,
    mode: "cloud-paper",
    checkIntervalSeconds: 300,
    config: DEFAULT_CONFIG,
    note: "Paper trading only. No exchange credentials or real-order execution.",
  });
}

export async function POST() {
  return startEngine();
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("bootstrap") !== "paper-only") {
    return Response.json({ error: "Use POST to start the paper engine." }, { status: 405 });
  }
  return startEngine();
}
