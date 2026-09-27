import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const runId = "wrun_01M3H9R0VSEYXCKFMV5H65CG18";
  try {
    const run = getRun(runId);
    const status = await run.status;
    if (status === "running" || status === "pending") {
      await run.cancel({ cancelReason: "Preview Jev billing test is complete." });
    }
    return Response.json({ ok: true, runId, statusBefore: status, cancelled: status === "running" || status === "pending" });
  } catch (error) {
    return Response.json({ ok: false, runId, error: error && error.message ? error.message : "cancel failed" }, { status: 500 });
  }
}