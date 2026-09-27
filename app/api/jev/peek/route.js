import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";

function decodeChunk(value, decoder) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return decoder.decode(value, { stream: true });
  return String(value ?? "");
}
function parseLatestJson(raw) {
  const lines = String(raw || "").split("\n").map(function(line) { return line.trim(); }).filter(Boolean).reverse();
  for (const line of lines) { try { return JSON.parse(line); } catch {} }
  return null;
}

export async function GET(request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) return Response.json({ error: "runId is required" }, { status: 400 });
  let reader;
  try {
    const run = getRun(runId);
    reader = run.getReadable({ namespace: "jev-realtime-state", startIndex: -1 }).getReader();
    const result = await Promise.race([
      reader.read(),
      new Promise(function(resolve) { setTimeout(function() { resolve({ timeout: true }); }, 3500); })
    ]);
    if (result && (result.timeout || result.done)) {
      return Response.json({ status: "starting", runId: runId }, { status: 202, headers: { "Cache-Control": "no-store, max-age=0" } });
    }
    const latest = parseLatestJson(decodeChunk(result.value, new TextDecoder()));
    if (!latest) return Response.json({ status: "starting", runId: runId }, { status: 202, headers: { "Cache-Control": "no-store, max-age=0" } });
    return Response.json({ runId: runId, snapshot: latest }, { headers: { "Cache-Control": "no-store, max-age=0", "X-Workflow-Read-Mode": "tail-only" } });
  } catch (error) {
    return Response.json({ error: error && error.message ? error.message : "Unable to read Jev realtime workflow state", runId: runId }, { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } });
  } finally {
    try { if (reader) await reader.cancel(); } catch {}
  }
}