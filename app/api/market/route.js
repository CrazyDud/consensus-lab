import { getMarketData } from "../../../lib/market.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getMarketData();
    return Response.json(
      { ...data, serverTime: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (error) {
    return Response.json(
      { error: error?.message || "Market data unavailable", details: error?.details || null },
      { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
}
