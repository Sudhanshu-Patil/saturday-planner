// Runs fixed scenarios against /api/plan and checks invariants.
// Usage: npx tsx scripts/eval.mts [baseUrl]   (default http://localhost:3000)
// Spaced out so a run stays inside Groq's free 8K tokens/min per model.
import type { TraceEvent } from "../lib/tools";

const BASE = process.argv[2] ?? "http://localhost:3000";
const GAP_MS = 35_000;

type Check = (ev: TraceEvent[]) => string | null; // null = pass, else the failure
const plan = (ev: TraceEvent[]) => ev.find((e) => e.type === "plan") as Extract<TraceEvent, { type: "plan" }> | undefined;
const has = (ev: TraceEvent[], t: TraceEvent["type"]) => ev.some((e) => e.type === t);

const planned: Check = (ev) => (plan(ev) ? null : "no plan");
const grounded: Check = (ev) => {
  const p = plan(ev)?.plan;
  return p && p.stops.every((s) => s.place && !s.place.unverified) ? null : "a stop is not from OSM";
};
const inBudget: Check = (ev) => {
  const p = plan(ev)?.plan;
  return p && (p.budget == null || p.totals.total <= p.budget * 1.15) ? null : "over budget";
};
const vegSafe: Check = (ev) => (plan(ev)?.plan.stops.some((s) => s.place?.veg === "no") ? "non-veg place" : null);
const noUnresolved: Check = (ev) => (plan(ev)?.plan.warnings.some((w) => w.startsWith("Not fully resolved")) ? "validator errors left" : null);
const clarifies: Check = (ev) => (has(ev, "clarify") ? null : "did not ask");
const fellBack: Check = (ev) => (has(ev, "model_fallback") ? null : "no model fallback");

const SCENARIOS: { name: string; body: object; checks: Check[] }[] = [
  {
    name: "Brief example (JSON)",
    body: {
      city: "Bangalore",
      budget: 2000,
      available_time: "4 hours",
      mood: "tired but wants to do something fun",
      interests: ["food", "music", "walks"],
      constraints: ["vegetarian", "avoid crowded places"],
    },
    checks: [planned, grounded, inBudget, vegSafe, noUnresolved],
  },
  { name: "Vague input", body: { message: "I'm bored. Plan something?" }, checks: [clarifies] },
  { name: "Unknown city", body: { message: "Plan my Saturday in Wakanda. ₹1,500, I love music." }, checks: [clarifies] },
  {
    name: "Tiny budget",
    body: { message: "Bangalore, ₹100 total, 5 hours, I love fancy dinners and live music." },
    checks: [planned, grounded, inBudget],
  },
  {
    name: "Family day, Mumbai",
    body: { message: "Mumbai with my parents in their 60s. ₹4,000 for three, 11 am to 5 pm, old buildings and Gujarati food, little walking." },
    checks: [planned, grounded, inBudget, noUnresolved],
  },
  {
    name: "Rate limit fallback",
    body: { message: "Delhi, Saturday evening, 3 hours, street food and history, ₹800.", simulate: "rate-limit" },
    checks: [fellBack, planned],
  },
];

const rows: string[] = [];
for (const [i, s] of SCENARIOS.entries()) {
  if (i) await new Promise((r) => setTimeout(r, GAP_MS));
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s.body) });
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as TraceEvent);
  const fails = s.checks.map((c) => c(events)).filter(Boolean);
  const done = events.find((e) => e.type === "done") as Extract<TraceEvent, { type: "done" }> | undefined;
  const row = `| ${s.name} | ${fails.length ? `FAIL: ${fails.join(", ")}` : "pass"} | ${done?.stats.turns ?? "-"} | ${done?.stats.tokens ?? "-"} | ${((Date.now() - t0) / 1000).toFixed(1)}s |`;
  console.log(row);
  rows.push(row);
}
console.log(`\n| Scenario | Result | Model turns | Tokens | Time |\n|---|---|---|---|---|\n${rows.join("\n")}`);
