import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

const RUNS = [
  "wrun_01M3H9R0VSEYXCKFMV5H65CG18",
  "wrun_01M3H9SMV2T2N2HJJDK5TPQAFN"
];

export async function POST() {
  const results = [];
  for (const runId of RUNS) {
    try {
      const run = getRun(runId);
      const status = await run.status;
      if (status === "running" || status === "pending") {
        await run.cancel({ cancelReason: "Jev gateway billing access is not enabled yet; stop retries until account setup is complete." });
      }
      results.push({ runId, statusBefore: status, cancelled: status === "running" || status === "pending" });
    } catch (error) {
      results.push({ runId, error: error && error.message ? error.message : "cancel failed" });
    }
  }
  return Response.json({ ok: true, results });
}

export async function GET() {
  return Response.json({ error: "POST only" }, { status: 405 });
}