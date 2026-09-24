import { start } from "workflow/api";
import { comparisonEngine } from "../../../../workflows/comparison-engine.js";

export const dynamic = "force-dynamic";

async function launch() {
  const run = await start(comparisonEngine);
  return Response.json({
    ok: true,
    runId: run.runId,
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
      "Buy & Hold",
      "Cash"
    ],
    note: "Paper trading only. No real-order execution."
  });
}

export async function POST() {
  return launch();
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("bootstrap") !== "paper-only") {
    return Response.json({ error: "Use POST to start the comparison engine." }, { status: 405 });
  }
  return launch();
}
