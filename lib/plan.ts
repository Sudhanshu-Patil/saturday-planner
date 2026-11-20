// Pure plan logic: preference normalising, travel legs, costs, validation and the
// enriched plan the UI renders. No network, no framework, so it is unit tested.
import opening_hours from "opening_hours";
import { clock } from "./format";

export type Energy = "low" | "medium" | "high";
export const FLAGS = [
  "vegetarian",
  "vegan",
  "jain",
  "halal",
  "no_alcohol",
  "avoid_crowds",
  "low_walking",
  "wheelchair",
  "kids",
] as const;
export type Flag = (typeof FLAGS)[number];

export interface RawPreferences {
  city: string | null;
  budget: number | null;
  currency: string | null;
  group_size: number | null;
  start_time: string | null;
  duration_hours: number | null;
  part_of_day: string | null;
  mood: string;
  energy: string;
  interests: string[];
  constraints: string[];
  other_constraints: string[];
}

// Map loose wording ("avoid crowded places", "veg") onto the flags the validator checks.
const FLAG_PATTERNS: [RegExp, Flag][] = [
  [/vegan/, "vegan"],
  [/jain/, "jain"],
  [/veg|vegetarian/, "vegetarian"],
  [/halal/, "halal"],
  [/alcohol|sober|teetotal/, "no_alcohol"],
  [/crowd|quiet|busy/, "avoid_crowds"],
  [/(less|little|no|not much|minimal|limited|low|can'?t)\s+walk/, "low_walking"],
  [/wheelchair|accessib/, "wheelchair"],
  [/kid|child/, "kids"],
];
export function toFlags(items: string[]): { flags: Flag[]; other: string[] } {
  const flags = new Set<Flag>();
  const other: string[] = [];
  for (const item of items) {
    const text = item.toLowerCase().replace(/_/g, " ");
    const hit = FLAG_PATTERNS.find(([re]) => re.test(text));
    if (hit) flags.add(hit[1]);
    else other.push(item);
  }
  return { flags: [...flags], other };
}

export interface Brief {
  city: string;
  budget: number | null;
  currency: string;
  group: number;
  start: number; // minutes after midnight
  end: number;
  mood: string;
  energy: Energy;
  interests: string[];
  flags: Flag[];
  other: string[];
  assumptions: string[];
}

export interface Place {
  id: string;
  name: string;
  kind: string;
  label: string;
  group: "activity" | "food";
  lat: number;
  lon: number;
  dist: number;
  hours?: string;
  veg?: "only" | "yes" | "limited" | "no";
  cuisine?: string;
  busy: boolean;
  outdoor: boolean;
  osm?: string;
  unverified?: boolean;
}

export interface Weather {
  date: string; // YYYY-MM-DD of the Saturday
  rain: (number | null)[]; // 24 hourly precipitation probabilities
  temp: (number | null)[];
  sunset: number | null; // minutes after midnight
  tmin: number | null;
  tmax: number | null;
}

export interface Ride {
  base: number;
  per_km: number;
}

export interface Leg {
  km: number;
  mode: "walk" | "ride";
  minutes: number;
  fare: number;
  approx?: boolean;
}

export interface PlanStop {
  id: string;
  name: string;
  start: string;
  end: string;
  activity: string;
  why: string;
  cost: number;
  tip: string;
}

export interface PlanDraft {
  title: string;
  summary: string;
  stops: PlanStop[];
  ride: Ride;
  tradeoffs: string[];
  assumptions: string[];
  backup: string;
}

export interface Ctx {
  brief: Brief;
  places: Map<string, Place>;
  weather: Weather | null;
  date: string;
  degraded: boolean;
}

export function toMin(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export { clock };

const list = (names: string[]) => [...new Set(names)].join(", ");

export const isVeg = (b: Brief) =>
  b.flags.some((f) => f === "vegetarian" || f === "vegan" || f === "jain");

/** parseUserPreferences: turn the model's extraction into a brief the code can check against. */
export function normalizePreferences(p: RawPreferences): { brief: Brief | null; missing: string[] } {
  const city = p.city?.trim();
  if (!city) return { brief: null, missing: ["city"] };
  const assumptions: string[] = [];

  let currency = (p.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    currency = "USD";
    assumptions.push("Assumed prices in USD");
  }

  const hasDuration = p.duration_hours != null && p.duration_hours > 0;
  const hours = hasDuration ? Math.min(p.duration_hours!, 14) : 4;
  if (!hasDuration) assumptions.push("Assumed you have about 4 hours");

  let start = p.start_time ? toMin(p.start_time) : null;
  if (start == null) {
    const part = (p.part_of_day ?? "").toLowerCase();
    start = /morning/.test(part) ? 600 : /evening|night/.test(part) ? 1020 : hours > 5 ? 660 : 900;
    assumptions.push(`Assumed you start around ${clock(start)}`);
  }
  let end = Math.round(start + hours * 60);
  if (end > 23 * 60 + 30) {
    end = 23 * 60 + 30;
    assumptions.push("Wrapped up by 11:30 PM");
  }

  const budget = p.budget != null && p.budget >= 0 ? p.budget : null;
  if (budget == null) assumptions.push("No budget given, so I kept costs moderate");

  const { flags, other } = toFlags([...p.constraints, ...p.other_constraints]);
  const energy: Energy = p.energy === "low" || p.energy === "high" ? p.energy : "medium";
  return {
    brief: {
      city,
      budget,
      currency,
      group: Math.max(1, Math.min(20, Math.round(p.group_size ?? 1))),
      start,
      end,
      mood: p.mood,
      energy,
      interests: p.interests,
      flags,
      other,
      assumptions,
    },
    missing: [],
  };
}

/** The upcoming Saturday in the city's local time (today if it is Saturday before 5 PM). */
export function nextSaturday(nowMs: number, utcOffsetSeconds: number): string {
  const local = new Date(nowMs + utcOffsetSeconds * 1000);
  const dow = local.getUTCDay();
  const add = dow === 6 ? (local.getUTCHours() < 17 ? 0 : 7) : 6 - dow;
  local.setUTCDate(local.getUTCDate() + add);
  return local.toISOString().slice(0, 10);
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function legBetween(a: Place | undefined, b: Place | undefined, ride: Ride, brief: Brief): Leg {
  const slow = brief.energy === "low" || brief.flags.includes("low_walking");
  if (!a || !b || a.unverified || b.unverified) {
    // No coordinates for unverified places: assume a typical short city ride.
    return { km: 3, mode: "ride", minutes: 20, fare: Math.round(ride.base + ride.per_km * 3), approx: true };
  }
  const km = Math.round(haversineKm(a, b) * 1.35 * 10) / 10; // 1.35: streets are not straight lines
  if (km <= (slow ? 0.8 : 1.2)) {
    return { km, mode: "walk", minutes: Math.max(2, Math.ceil((km / (slow ? 4 : 4.5)) * 60)), fare: 0 };
  }
  return { km, mode: "ride", minutes: Math.ceil((km / 18) * 60) + 6, fare: Math.round(ride.base + ride.per_km * km) };
}

/** estimateCost: legs between stops, fares, and totals for the whole group. */
export function estimateCost(draft: PlanDraft, places: Map<string, Place>, brief: Brief) {
  const legs = draft.stops
    .slice(1)
    .map((s, i) => legBetween(places.get(draft.stops[i].id), places.get(s.id), draft.ride, brief));
  const stops = Math.round(draft.stops.reduce((sum, s) => sum + Math.max(0, s.cost) * brief.group, 0));
  const transport = legs.reduce((sum, l) => sum + l.fare, 0);
  const walkKm = Math.round(legs.filter((l) => l.mode === "walk").reduce((s, l) => s + l.km, 0) * 10) / 10;
  return { legs, totals: { stops, transport, total: stops + transport, walkKm } };
}

function openFor(hours: string, date: string, start: number, end: number): boolean | null {
  try {
    const oh = new opening_hours(hours);
    const [y, m, d] = date.split("-").map(Number);
    const from = new Date(y, m - 1, d, 0, start);
    const to = new Date(y, m - 1, d, 0, end);
    const [open, unknown] = oh.getOpenDuration(from, to);
    if (unknown > 0) return null;
    return open >= (end - start - 5) * 60_000;
  } catch {
    return null; // unparseable or needs holiday data: treat as unknown
  }
}

function peakRain(w: Weather, start: number, end: number): number {
  let peak = 0;
  for (let h = Math.floor(start / 60); h <= Math.floor((end - 1) / 60); h++) peak = Math.max(peak, w.rain[h] ?? 0);
  return peak;
}

/** validatePlan: hard rules the model cannot skip. Errors send the draft back for revision. */
export function validatePlan(draft: PlanDraft, ctx: Ctx) {
  const { brief, places, weather } = ctx;
  const errors: string[] = [];
  const warnings: string[] = [];
  const { legs, totals } = estimateCost(draft, places, brief);
  const noHours: string[] = [];
  const noVegTag: string[] = [];

  if (!draft.stops.length) errors.push("The plan has no stops.");
  if (legs.some((l) => l.mode === "ride") && draft.ride.base <= 0 && draft.ride.per_km <= 0)
    errors.push("Some stops need a ride but the ride fare is 0. Give the real local auto or taxi fare.");

  let prevEnd: number | null = null;
  draft.stops.forEach((s, i) => {
    const place = places.get(s.id);
    if (!place) errors.push(`"${s.id}" (${s.name}) is not an id from findOptions. Use only listed ids.`);
    const start = toMin(s.start);
    const end = toMin(s.end);
    if (start == null || end == null || end <= start) {
      errors.push(`${s.name}: times "${s.start}" to "${s.end}" are invalid. Use HH:MM with the end after the start.`);
      return;
    }
    if (prevEnd != null) {
      const gap = start - prevEnd;
      const leg = legs[i - 1];
      if (gap < 0) errors.push(`${s.name} starts before ${draft.stops[i - 1].name} ends.`);
      else if (gap + 3 < leg.minutes)
        errors.push(
          `Only ${gap} min between ${draft.stops[i - 1].name} and ${s.name}, but the ${leg.mode} takes about ${leg.minutes} min.`,
        );
    }
    prevEnd = end;
    if (!place) return;

    if (isVeg(brief) && place.group === "food") {
      if (place.veg === "no") errors.push(`${place.name} is tagged as having no vegetarian food.`);
      else if (!place.veg) noVegTag.push(place.name);
    }
    if (brief.flags.includes("avoid_crowds") && place.busy)
      errors.push(`${place.name} gets crowded on Saturdays and the user wants to avoid crowds.`);
    if (place.hours) {
      const open = openFor(place.hours, ctx.date, start, end);
      if (open === false) errors.push(`${place.name} is closed for part of ${s.start} to ${s.end} (hours: ${place.hours}).`);
      if (open === null) noHours.push(place.name);
    } else if (!place.unverified) noHours.push(place.name);
    if (place.outdoor && weather) {
      const peak = peakRain(weather, start, end);
      if (peak >= 70) errors.push(`${place.name} is outdoors but the rain chance is ${peak}% then. Move it or pick an indoor option.`);
      if (weather.sunset != null && end > weather.sunset + 20)
        warnings.push(`${place.name} runs past sunset (${clock(weather.sunset)}).`);
    }
  });

  const first = toMin(draft.stops[0]?.start ?? "");
  const last = toMin(draft.stops.at(-1)?.end ?? "");
  if (first != null && first < brief.start - 15)
    errors.push(`The plan starts at ${clock(first)} but the user is free from ${clock(brief.start)}.`);
  if (last != null && last > brief.end + 15)
    errors.push(`The plan ends at ${clock(last)} but the user's time runs out at ${clock(brief.end)}.`);

  if (brief.budget != null && totals.total > brief.budget) {
    const named = draft.tradeoffs.some((t) => /budget/i.test(t));
    if (totals.total > brief.budget * 1.15 || !named)
      errors.push(
        `Total is ${totals.total} ${brief.currency} (stops ${totals.stops} + rides ${totals.transport}) against a budget of ${brief.budget}. ` +
          (named ? "Cut costs." : "Cut costs, or stay within 15% over and name the budget trade-off."),
      );
    else warnings.push(`About ${totals.total - brief.budget} ${brief.currency} over budget, explained in the trade-offs.`);
  }
  if (totals.walkKm > 3 && (brief.energy === "low" || brief.flags.includes("low_walking")))
    warnings.push(`About ${totals.walkKm} km of walking in total.`);
  if (noVegTag.length) warnings.push(`OpenStreetMap has no vegetarian tag for ${list(noVegTag)}. Check the menu.`);
  if (noHours.length) warnings.push(`Opening hours aren't listed for ${list(noHours)}. Check before you go.`);

  return { errors, warnings, legs, totals };
}

/** The plan the UI renders: the model's draft plus everything the code computed. */
export function finalizePlan(
  draft: PlanDraft,
  ctx: Ctx & { area: string },
  result: ReturnType<typeof validatePlan>,
  unresolved: string[],
) {
  const { brief } = ctx;
  const stops = draft.stops.map((s) => {
    const p = ctx.places.get(s.id);
    return {
      ...s,
      place: p
        ? {
            name: p.name,
            label: p.label,
            kind: p.kind,
            lat: p.lat,
            lon: p.lon,
            hours: p.hours ?? null,
            veg: p.veg ?? null,
            cuisine: p.cuisine ?? null,
            busy: p.busy,
            outdoor: p.outdoor,
            unverified: !!p.unverified,
            osmUrl: p.osm ? `https://www.openstreetmap.org/${p.osm}` : null,
            mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name}, ${brief.city}`)}`,
          }
        : null,
    };
  });
  const pts = stops
    .filter((s) => s.place && !s.place.unverified)
    .map((s) => `${s.place!.lat},${s.place!.lon}`);
  const routeUrl =
    pts.length >= 2
      ? `https://www.google.com/maps/dir/?api=1&origin=${pts[0]}&destination=${pts.at(-1)}` +
        (pts.length > 2 ? `&waypoints=${encodeURIComponent(pts.slice(1, -1).join("|"))}` : "")
      : null;
  return {
    title: draft.title,
    summary: draft.summary,
    date: ctx.date,
    city: brief.city,
    area: ctx.area,
    currency: brief.currency,
    budget: brief.budget,
    group: brief.group,
    window: { start: brief.start, end: brief.end },
    stops,
    legs: result.legs,
    totals: result.totals,
    weather: ctx.weather,
    tradeoffs: draft.tradeoffs,
    assumptions: [...new Set([...brief.assumptions, ...draft.assumptions])],
    backup: draft.backup,
    warnings: [...unresolved, ...result.warnings],
    degraded: ctx.degraded,
    routeUrl,
  };
}

export type FinalPlan = ReturnType<typeof finalizePlan>;
