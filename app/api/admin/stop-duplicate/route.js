import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

const RUN_ID = "wrun_01M3EFSSTR0A240HR338PFA2VN";

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("confirm") !== "stop-duplicate-20260927") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const run = getRun(RUN_ID);
  const statusBefore = await run.status;
  if (statusBefore === "running" || statusBefore === "pending") {
    await run.cancel({ cancelReason: "Duplicate comparison run stopped to reduce Vercel CPU and Workflow Events usage." });
  }
  const statusAfter = await run.status;
  return Response.json({ runId: RUN_ID, statusBefore, statusAfter });
}
