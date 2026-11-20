import { z } from "zod";
import { runAgent } from "@/lib/agent";
import type { TraceEvent } from "@/lib/tools";

export const maxDuration = 60;

const Simulate = z.enum(["osm-down", "rate-limit"]).nullish();
const Body = z.union([
  z.object({ message: z.string().trim().min(1).max(2000), simulate: Simulate }),
  z.looseObject({ city: z.string() }), // the brief's structured JSON, sent as-is
]);

// shortcut: per-instance memory, so the limit is approximate across serverless instances; move to a shared store if abuse shows up
const hits = new Map<string, number[]>();
function waitSeconds(ip: string): number {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 600_000);
  if (recent.length >= 6) {
    hits.set(ip, recent);
    return Math.ceil((600_000 - (now - recent[0])) / 1000);
  }
  hits.set(ip, [...recent, now]);
  return 0;
}

export async function POST(req: Request) {
  if (!process.env.GROQ_API_KEY) return Response.json({ error: "The server has no GROQ_API_KEY set." }, { status: 500 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Send { message } (up to 2,000 characters) or the brief's JSON." }, { status: 400 });
  const data: Record<string, unknown> = parsed.data;
  const message = typeof data.message === "string" ? data.message : JSON.stringify(data);
  if (message.length > 2000) return Response.json({ error: "That request is too long." }, { status: 400 });
  const sim = Simulate.safeParse(data.simulate ?? new URL(req.url).searchParams.get("simulate"));
  const simulate = (sim.success && sim.data) || null;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const wait = waitSeconds(ip);
  if (wait)
    return Response.json(
      { error: `That's a lot of Saturdays. Try again in ${Math.ceil(wait / 60)} min.` },
      { status: 429, headers: { "retry-after": String(wait) } },
    );

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: TraceEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        await runAgent(message, emit, simulate);
      } catch (e) {
        console.error(e);
        emit({ type: "error", message: "Something broke on our side. Try again.", retryable: true });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
