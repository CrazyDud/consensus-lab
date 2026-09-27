import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

const OBSOLETE_RUNS = [
  "wrun_01M3AD924QZRB6B5DKVHBD6PP9",
  "wrun_01M3AM017EFMX2AZ3WN6XSXJCK",
  "wrun_01M3AETHNBNWCD1JRG5QK5RN8R",
];

export async function POST() {
  const results = [];
  for (const runId of OBSOLETE_RUNS) {
    try {
      const run = getRun(runId);
      const statusBefore = await run.status;
      if (statusBefore === "running" || statusBefore === "pending") {
        await run.cancel({ cancelReason: "Superseded Consensus Lab paper run; cleaning up duplicate workflow load." });
      }
      results.push({ runId, statusBefore, cancelled: statusBefore === "running" || statusBefore === "pending" });
    } catch (error) {
      results.push({ runId, error: error?.message || "cancel failed" });
    }
  }
  return Response.json({ ok: true, results });
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("confirm") !== "cleanup-obsolete-paper-runs") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return POST();
}
