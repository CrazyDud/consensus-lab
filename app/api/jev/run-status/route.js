import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) return Response.json({ error: "runId is required" }, { status: 400 });
  try {
    const run = getRun(runId);
    return Response.json({ runId: runId, workflowStatus: await run.status }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({ error: error && error.message ? error.message : "Unable to read Jev workflow status", runId: runId }, { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}