import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) return Response.json({ error: "runId is required" }, { status: 400 });

  try {
    const run = getRun(runId);
    const reader = run.getReadable({ namespace: "compare-state", startIndex: 0 }).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latest = null;

    for (let reads = 0; reads < 1000; reads += 1) {
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2000)),
      ]);

      if (result?.timeout || result?.done) break;
      const value = typeof result.value === "string"
        ? result.value
        : decoder.decode(result.value, { stream: true });
      buffer += value;

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { latest = JSON.parse(trimmed); } catch {}
      }
    }

    try { await reader.cancel(); } catch {}
    if (!latest && buffer.trim()) {
      try { latest = JSON.parse(buffer.trim()); } catch {}
    }

    if (!latest) {
      return Response.json({ status: "starting", runId }, {
        status: 202,
        headers: { "Cache-Control": "no-store, max-age=0" }
      });
    }

    return Response.json({ runId, snapshot: latest }, {
      headers: { "Cache-Control": "no-store, max-age=0" }
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || "Unable to read comparison workflow state", runId },
      { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
}
