import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

function decodeChunk(value, decoder) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return decoder.decode(value, { stream: true });
  return String(value ?? "");
}

export async function GET(request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }

  try {
    const run = getRun(runId);
    const reader = run.getReadable({ namespace: "state" }).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latest = null;
    let reads = 0;

    while (reads < 500) {
      reads += 1;
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 250)),
      ]);

      if (result?.timeout) break;
      if (result?.done) break;

      buffer += decodeChunk(result.value, decoder);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          latest = JSON.parse(trimmed);
        } catch {
          // Ignore framing or partial non-JSON data.
        }
      }
    }

    try { await reader.cancel(); } catch {}

    if (!latest && buffer.trim()) {
      try { latest = JSON.parse(buffer.trim()); } catch {}
    }

    if (!latest) {
      return Response.json({ status: "starting", runId }, {
        status: 202,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    return Response.json({ runId, snapshot: latest }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || "Unable to read workflow state", runId },
      { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
}
