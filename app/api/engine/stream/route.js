import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }

  try {
    const run = getRun(runId);
    const stream = run.getReadable({ namespace: "state" });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || "Unable to read workflow stream" },
      { status: 404 }
    );
  }
}
