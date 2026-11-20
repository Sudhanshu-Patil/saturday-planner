// The functions the agent's tools run: geocoding, weather, places. Each one is a
// trace step, so the UI shows exactly what ran, how long it took and what came back.
import {
  clock,
  nextSaturday,
  normalizePreferences,
  toMin,
  type Brief,
  type FinalPlan,
  type Place,
  type RawPreferences,
  type Weather,
} from "./plan";
import { findPlaces, UA, type KindKey } from "./osm";

export type TraceEvent =
  | { type: "turn"; n: number; model: string; ms: number; tokens: number; action: string; reasoning: string | null }
  | { type: "tool_start"; id: string; name: string; label: string; why?: string; input?: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary: string; ms: number; output?: unknown }
  | { type: "brief"; brief: Brief }
  | { type: "model_fallback"; from: string; to: string; reason: string }
  | { type: "clarify"; questions: { question: string; options: string[] }[] }
  | { type: "plan"; plan: FinalPlan }
  | { type: "error"; message: string; retryable: boolean; retryAfter?: number }
  | { type: "done"; stats: { turns: number; calls: number; tokens: number; ms: number; models: string[] } };

export interface RunCtx {
  emit: (e: TraceEvent) => void;
  simulate: "osm-down" | "rate-limit" | null;
  seq: number;
  calls: number;
  brief: Brief | null;
  places: Map<string, Place>;
  weather: Weather | null;
  date: string;
  degraded: boolean;
  area: string;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run one function as a visible trace step. */
export async function step<T>(
  ctx: RunCtx,
  name: string,
  label: string,
  input: unknown,
  fn: () => Promise<{ value: T; summary: string; output?: unknown; ok?: boolean }>,
  why?: string,
): Promise<T> {
  const id = `s${++ctx.seq}`;
  const t0 = Date.now();
  ctx.calls++;
  ctx.emit({ type: "tool_start", id, name, label, why, input });
  try {
    const r = await fn();
    ctx.emit({ type: "tool_end", id, ok: r.ok ?? true, summary: r.summary, ms: Date.now() - t0, output: r.output ?? r.value });
    return r.value;
  } catch (e) {
    ctx.emit({ type: "tool_end", id, ok: false, summary: errMsg(e), ms: Date.now() - t0 });
    throw e;
  }
}

interface Hit {
  lat: number;
  lon: number;
  display: string;
  source: string;
  query: string;
}

async function nominatim(q: string, settlementOnly: boolean): Promise<Hit | null> {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1` +
    (settlementOnly ? "&featureType=settlement" : "");
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en" },
    signal: AbortSignal.timeout(6000),
    next: { revalidate: 86400 },
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const [hit] = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  return hit ? { lat: +hit.lat, lon: +hit.lon, display: hit.display_name, source: "Nominatim", query: q } : null;
}

async function openMeteoGeocode(q: string): Promise<Hit | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), next: { revalidate: 86400 } });
  if (!res.ok) throw new Error(`Open-Meteo geocoding HTTP ${res.status}`);
  const hit = ((await res.json()) as { results?: { latitude: number; longitude: number; name: string; admin1?: string; country?: string }[] })
    .results?.[0];
  return hit
    ? {
        lat: hit.latitude,
        lon: hit.longitude,
        display: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", "),
        source: "Open-Meteo geocoding",
        query: q,
      }
    : null;
}

/** getLocation: the neighbourhood if given, else the city; Nominatim first, Open-Meteo as backup. */
async function locate(area: string | null, city: string): Promise<{ hit: Hit | null; failures: string[] }> {
  const failures: string[] = [];
  const tries: [string, boolean][] = area ? [[`${area}, ${city}`, false], [city, true]] : [[city, true]];
  for (const [q, settlement] of tries) {
    try {
      const hit = await nominatim(q, settlement);
      if (hit) return { hit, failures };
    } catch (e) {
      failures.push(errMsg(e));
    }
  }
  if (failures.length) {
    // Only fall back when Nominatim was down, not when it simply found nothing.
    try {
      return { hit: await openMeteoGeocode(city), failures };
    } catch (e) {
      failures.push(errMsg(e));
    }
  }
  return { hit: null, failures };
}

async function getWeather(lat: number, lon: number): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&hourly=precipitation_probability,temperature_2m&daily=sunset,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=9`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), next: { revalidate: 1800 } });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const j = (await res.json()) as {
    utc_offset_seconds: number;
    hourly: { time: string[]; precipitation_probability: (number | null)[]; temperature_2m: (number | null)[] };
    daily: { time: string[]; sunset: string[]; temperature_2m_max: number[]; temperature_2m_min: number[] };
  };
  const date = nextSaturday(Date.now(), j.utc_offset_seconds);
  const i = j.hourly.time.findIndex((t) => t.startsWith(date));
  const d = j.daily.time.indexOf(date);
  if (i < 0 || d < 0) throw new Error("No forecast for Saturday yet");
  return {
    date,
    rain: j.hourly.precipitation_probability.slice(i, i + 24),
    temp: j.hourly.temperature_2m.slice(i, i + 24),
    sunset: toMin(j.daily.sunset[d].slice(11, 16)),
    tmin: Math.round(j.daily.temperature_2m_min[d]),
    tmax: Math.round(j.daily.temperature_2m_max[d]),
  };
}

const money = (n: number | null, currency: string) => (n == null ? "not given" : `${n} ${currency}`);

function weatherLine(w: Weather, b: Brief): string {
  const hours: string[] = [];
  for (let h = Math.floor(b.start / 60); h <= Math.min(23, Math.floor((b.end - 1) / 60)); h++)
    hours.push(`${h}h ${w.rain[h] ?? "?"}%`);
  return `${w.tmin}-${w.tmax}°C · rain chance ${hours.join(", ")} · sunset ${w.sunset != null ? clock(w.sunset) : "?"}`;
}

const placeLine = (p: Place) =>
  [
    p.id,
    p.name,
    [p.label, p.cuisine].filter(Boolean).join(" · "),
    p.veg ? `veg ${p.veg}` : null,
    `${p.dist} m`,
    p.hours ? `hours ${p.hours}` : null,
    p.outdoor ? "outdoor" : null,
    p.busy ? "busy" : null,
  ]
    .filter(Boolean)
    .join(" | ");

const countBy = (ps: Place[]) =>
  Object.entries(ps.reduce<Record<string, number>>((m, p) => ({ ...m, [p.label]: (m[p.label] ?? 0) + 1 }), {}))
    .map(([label, n]) => `${n} ${label.toLowerCase()}`)
    .join(", ");

export interface FindArgs {
  why: string;
  preferences: RawPreferences;
  search: { area: string | null; activity_kinds: KindKey[]; food_kinds: KindKey[]; radius_m: number };
}

/** The findOptions tool: brief, location, weather and places in one model turn. Returns compact text. */
export async function findOptions(args: FindArgs, ctx: RunCtx): Promise<string> {
  const { brief, missing } = await step(
    ctx,
    "parseUserPreferences",
    "Read your request",
    args.preferences,
    async () => {
      const r = normalizePreferences(args.preferences);
      const b = r.brief;
      return {
        value: r,
        summary: b
          ? `${b.city} · ${clock(b.start)} to ${clock(b.end)} · ${money(b.budget, b.currency)} · ${b.energy} energy`
          : `Missing ${r.missing.join(", ")}`,
      };
    },
    args.why,
  );
  if (!brief) return `CITY_MISSING (${missing.join(", ")}): call askClarifyingQuestions.`;
  ctx.brief = brief;
  ctx.emit({ type: "brief", brief });

  const { area, activity_kinds, food_kinds } = args.search;
  const loc = await step(ctx, "getLocation", "Find the area on the map", { area, city: brief.city }, async () => {
    const { hit, failures } = await locate(area, brief.city);
    const note = failures.length ? ` (after: ${failures.join("; ")})` : "";
    return {
      value: hit,
      summary: hit ? `${hit.display.split(",").slice(0, 3).join(",")} via ${hit.source}${note}` : `Not found${note}`,
    };
  });
  if (!loc)
    return `LOCATION_NOT_FOUND: "${area ? `${area}, ` : ""}${brief.city}" is not on the map. Ask which city they mean, offering 2-4 likely real cities.`;
  ctx.area = loc.query.split(",")[0];

  const radius = Math.min(5000, Math.max(800, Math.round(args.search.radius_m)));
  const kinds = [...new Set([...activity_kinds, ...food_kinds])];
  const placesP =
    ctx.simulate === "osm-down"
      ? Promise.reject(new Error("Simulated outage: Photon, Nominatim and Overpass are all down"))
      : findPlaces(kinds, loc, radius, { activity: 10, food: 12 });
  placesP.catch(() => {}); // awaited by the steps below; this avoids an unhandled rejection in between

  const via = (r: Awaited<typeof placesP>) => ` · via ${r.source}${r.notes.length ? ` (${r.notes.join("; ")})` : ""}`;
  const pick = (group: "activity" | "food") => async () => {
    const r = await placesP;
    const ps = r.places.filter((p) => p.group === group);
    return { value: ps, summary: `${ps.length} places${ps.length ? `: ${countBy(ps)}` : ""}${via(r)}`, output: ps };
  };

  const [weather, activities, food] = await Promise.all([
    step(ctx, "getWeather", "Check Saturday's weather", { lat: loc.lat, lon: loc.lon }, async () => {
      const w = await getWeather(loc.lat, loc.lon);
      return { value: w, summary: weatherLine(w, brief) };
    }).catch(() => null),
    activity_kinds.length
      ? step(ctx, "getActivityOptions", "Find things to do", { kinds: activity_kinds, radius }, pick("activity")).catch(() => null)
      : Promise.resolve([] as Place[]),
    food_kinds.length
      ? step(ctx, "getFoodOptions", "Find places to eat", { kinds: food_kinds, radius }, pick("food")).catch(() => null)
      : Promise.resolve([] as Place[]),
  ]);

  ctx.weather = weather;
  ctx.date = weather?.date ?? nextSaturday(Date.now(), Math.round(loc.lon / 15) * 3600);
  ctx.degraded = !(await placesP.then(() => true, () => false));
  const list = [...(activities ?? []), ...(food ?? [])];
  ctx.places = new Map(list.map((p) => [p.id, p]));

  const out = [
    `BRIEF ${brief.city} · ${clock(brief.start)} to ${clock(brief.end)} · budget ${money(brief.budget, brief.currency)} for ${brief.group} · energy ${brief.energy} · constraints ${[...brief.flags, ...brief.other].join(", ") || "none"}`,
    `AREA ${loc.display} (${loc.source})`,
    `DATE Saturday ${ctx.date}`,
    `WEATHER ${weather ? weatherLine(weather, brief) : "forecast unavailable, plan without it and say so"}`,
  ];
  if (ctx.degraded) {
    out.push(
      `PLACES_UNAVAILABLE: live map data is down. Suggest only well-known real places you are confident exist near ${ctx.area}, with ids x1, x2, ... They will be shown as unverified. Say so in assumptions.`,
    );
  } else {
    out.push(`ACTIVITIES (${activities?.length ?? 0} within ${radius} m)`, ...(activities ?? []).map(placeLine));
    out.push(`FOOD (${food?.length ?? 0})`, ...(food ?? []).map(placeLine));
    if (list.length < 3) out.push("NOTE few options: consider findOptions again with a wider radius or other kinds.");
  }
  return out.join("\n");
}
