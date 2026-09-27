import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const runId = "wrun_01M3HAJ3B0800GS9JFM3H5FJZZ";
  try {
    const run = getRun(runId);
    const status = await run.status;
    if (status === "running" || status === "pending") {
      await run.cancel({ cancelReason: "Restarting Jev realtime paper run with enforced provider backoff." });
    }
    return Response.json({ ok: true, runId, statusBefore: status, cancelled: status === "running" || status === "pending" });
  } catch (error) {
    return Response.json({ ok: false, runId, error: error && error.message ? error.message : "cancel failed" }, { status: 500 });
  }
}