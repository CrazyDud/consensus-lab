import { start } from "workflow/api";
import { jevRealtimeEngine } from "../../../../workflows/jev-realtime-engine.js";

export const dynamic = "force-dynamic";

async function launch() {
  const run = await start(jevRealtimeEngine);
  return Response.json({
    ok: true,
    runId: run.runId,
    mode: "jev-realtime-paper",
    market: "BTC-USD live Coinbase WebSocket",
    model: "typesafe-ai/jev",
    note: "Paper only. Jev may decide entries/exits, but deterministic code enforces all risk limits and real orders are disabled."
  });
}

export async function POST() { return launch(); }

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("bootstrap") !== "paper-only") {
    return Response.json({ error: "Use POST to start the Jev realtime engine." }, { status: 405 });
  }
  return launch();
}