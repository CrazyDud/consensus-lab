import { start } from "workflow/api";
import { intelligenceLiteEngine } from "../../../../workflows/intelligence-lite.js";

export const dynamic = "force-dynamic";

async function launch() {
  const run = await start(intelligenceLiteEngine);
  return Response.json({
    ok: true,
    runId: run.runId,
    mode: "intelligence-shadow",
    checkIntervalSeconds: 60,
    note: "Shadow paper research only. No real-order execution."
  });
}

export async function POST() {
  return launch();
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("bootstrap") !== "paper-only") {
    return Response.json({ error: "Use POST to start intelligence." }, { status: 405 });
  }
  return launch();
}
