import assert from "node:assert/strict";
import { test } from "node:test";
import {
  legBetween,
  nextSaturday,
  normalizePreferences,
  validatePlan,
  type Brief,
  type Place,
  type PlanDraft,
  type RawPreferences,
  type Weather,
} from "./plan";

const raw: RawPreferences = {
  city: "Bangalore",
  budget: 2000,
  currency: "INR",
  group_size: null,
  start_time: null,
  duration_hours: 4,
  part_of_day: null,
  mood: "tired but wants to do something fun",
  energy: "low",
  interests: ["food", "music", "walks"],
  constraints: ["vegetarian", "avoid_crowds"],
  other_constraints: [],
};

const brief = normalizePreferences(raw).brief as Brief;

const place = (p: Partial<Place> & Pick<Place, "id" | "name">): Place => ({
  kind: "restaurant",
  label: "Restaurant",
  group: "food",
  lat: 12.9716,
  lon: 77.5946,
  dist: 100,
  busy: false,
  outdoor: false,
  ...p,
});

const places = new Map<string, Place>(
  [
    place({ id: "a1", name: "Quiet Park", kind: "park", label: "Park", group: "activity", outdoor: true, lat: 12.9716, lon: 77.5946 }),
    place({ id: "f1", name: "Veg Thali House", veg: "only", hours: "Mo-Su 11:00-22:00", lat: 12.9735, lon: 77.5946 }),
    place({ id: "f2", name: "Grill Shack", veg: "no", lat: 12.9735, lon: 77.5946 }),
    place({ id: "f3", name: "Weekday Cafe", veg: "yes", hours: "Mo-Fr 09:00-17:00", lat: 12.9735, lon: 77.5946 }),
    place({ id: "a2", name: "Mega Mall", kind: "mall", label: "Mall", group: "activity", busy: true, lat: 12.9735, lon: 77.5946 }),
    place({ id: "a3", name: "Far Lake", kind: "lake", label: "Lake", group: "activity", outdoor: true, lat: 13.03, lon: 77.62 }),
  ].map((p) => [p.id, p]),
);

const weather: Weather = {
  date: "2026-11-21",
  rain: Array.from({ length: 24 }, (_, h) => (h >= 18 ? 80 : 10)),
  temp: Array(24).fill(25),
  sunset: 17 * 60 + 52,
  tmin: 19,
  tmax: 28,
};

const ctx = { brief, places, weather, date: "2026-11-21", degraded: false };

const draft = (stops: [string, string, string, number][], extra: Partial<PlanDraft> = {}): PlanDraft => ({
  title: "Test",
  summary: "",
  ride: { base: 30, per_km: 16 },
  tradeoffs: [],
  assumptions: [],
  backup: "",
  stops: stops.map(([id, start, end, cost]) => ({
    id,
    name: places.get(id)?.name ?? id,
    start,
    end,
    activity: "",
    why: "",
    cost,
    tip: "",
  })),
  ...extra,
});

test("normalizePreferences fills the window and states assumptions", () => {
  assert.equal(brief.start, 15 * 60);
  assert.equal(brief.end, 19 * 60);
  assert.equal(brief.group, 1);
  assert.ok(brief.assumptions.some((a) => a.includes("3 PM")));
  assert.deepEqual(normalizePreferences({ ...raw, city: " " }).missing, ["city"]);
  const evening = normalizePreferences({ ...raw, part_of_day: "evening", currency: "rupees" }).brief!;
  assert.equal(evening.start, 17 * 60);
  assert.equal(evening.currency, "USD");
});

test("loose constraint wording maps onto validator flags", () => {
  const b = normalizePreferences({ ...raw, constraints: ["vegetarian", "avoid crowded places"], other_constraints: ["no stairs"] }).brief!;
  assert.deepEqual(b.flags.sort(), ["avoid_crowds", "vegetarian"]);
  assert.deepEqual(b.other, ["no stairs"]);
});

test("nextSaturday works in the city's timezone", () => {
  const fri = Date.UTC(2026, 10, 20, 10); // Friday 20 Nov
  assert.equal(nextSaturday(fri, 19800), "2026-11-21");
  assert.equal(nextSaturday(Date.UTC(2026, 10, 21, 4), 19800), "2026-11-21"); // Saturday morning
  assert.equal(nextSaturday(Date.UTC(2026, 10, 21, 14), 19800), "2026-11-28"); // Saturday 7:30 PM
  assert.equal(nextSaturday(Date.UTC(2026, 10, 22, 6), 0), "2026-11-28"); // Sunday
});

test("legBetween walks short hops and rides long ones", () => {
  const ride = { base: 30, per_km: 16 };
  const walk = legBetween(places.get("a1"), places.get("f1"), ride, brief);
  assert.equal(walk.mode, "walk");
  assert.equal(walk.fare, 0);
  const far = legBetween(places.get("f1"), places.get("a3"), ride, brief);
  assert.equal(far.mode, "ride");
  assert.ok(far.fare > ride.base && far.minutes > 15);
});

test("a sensible plan passes", () => {
  const r = validatePlan(draft([["a1", "15:00", "16:15", 0], ["f1", "16:25", "17:45", 450]]), ctx);
  assert.deepEqual(r.errors, []);
  assert.equal(r.totals.total, 450);
});

test("validatePlan catches what the model gets wrong", () => {
  const errs = (d: PlanDraft) => validatePlan(d, ctx).errors.join("\n");
  assert.match(errs(draft([["z9", "15:00", "16:00", 0]])), /not an id/);
  assert.match(errs(draft([["a1", "15:00", "16:30", 0], ["f1", "16:00", "17:00", 0]])), /starts before/);
  assert.match(errs(draft([["f1", "15:00", "16:00", 0], ["a3", "16:05", "17:00", 0]])), /takes about/);
  assert.match(errs(draft([["f2", "15:00", "16:00", 300]])), /no vegetarian/);
  assert.match(errs(draft([["f3", "15:00", "16:00", 300]])), /closed/);
  assert.match(errs(draft([["a2", "15:00", "16:00", 0]])), /crowded/);
  assert.match(errs(draft([["a1", "18:00", "18:50", 0]])), /rain chance is 80%/);
  assert.match(errs(draft([["f1", "13:00", "14:00", 300]])), /free from 3 PM/);
  assert.match(errs(draft([["f1", "15:00", "16:00", 2200]])), /against a budget of 2000/);
  assert.match(errs(draft([["f1", "15:00", "16:00", 0], ["a3", "16:30", "17:30", 0]], { ride: { base: 0, per_km: 0 } })), /fare is 0/);
});

test("slightly over budget is allowed only when the trade-off says so", () => {
  const over = draft([["f1", "15:00", "16:00", 2200]], { tradeoffs: ["About 200 over budget for the best thali in town"] });
  const r = validatePlan(over, ctx);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes("over budget")));
});
