import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) return Response.json({ error: "runId is required" }, { status: 400 });

  try {
    const run = getRun(runId);
    const status = await run.status;
    return Response.json(
      { runId, workflowStatus: status },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (error) {
    return Response.json(
      { runId, error: error?.message || "Unable to inspect workflow status" },
      { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
}
