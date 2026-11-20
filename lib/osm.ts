// Real OpenStreetMap places, keyless: Photon (komoot's OSM search) finds named places
// near the area, one Nominatim lookup adds their tags (hours, cuisine, diet), and the
// public Overpass API is the backup when Photon is down.
import { haversineKm, type Place } from "./plan";

interface KindDef {
  label: string;
  group: "activity" | "food";
  outdoor?: boolean;
  busy?: boolean;
  tags: string[]; // OSM key:value pairs, any of which matches
}

export const KINDS = {
  park: { label: "Park", group: "activity", outdoor: true, tags: ["leisure:park"] },
  garden: { label: "Garden", group: "activity", outdoor: true, tags: ["leisure:garden"] },
  lake: { label: "Lake", group: "activity", outdoor: true, tags: ["natural:water"] },
  viewpoint: { label: "Viewpoint", group: "activity", outdoor: true, tags: ["tourism:viewpoint"] },
  museum: { label: "Museum", group: "activity", tags: ["tourism:museum"] },
  gallery: { label: "Gallery", group: "activity", tags: ["tourism:gallery", "amenity:arts_centre"] },
  live_music: { label: "Live music", group: "activity", tags: ["amenity:music_venue", "amenity:nightclub"] },
  bar: { label: "Bar", group: "activity", tags: ["amenity:bar", "amenity:pub", "amenity:biergarten"] },
  theatre: { label: "Theatre", group: "activity", tags: ["amenity:theatre"] },
  cinema: { label: "Cinema", group: "activity", tags: ["amenity:cinema"] },
  bookstore: { label: "Bookstore", group: "activity", tags: ["shop:books"] },
  library: { label: "Library", group: "activity", tags: ["amenity:library"] },
  music_shop: { label: "Music shop", group: "activity", tags: ["shop:musical_instrument", "shop:music"] },
  games: {
    label: "Games",
    group: "activity",
    tags: ["leisure:bowling_alley", "leisure:amusement_arcade", "leisure:escape_game", "leisure:miniature_golf"],
  },
  spa: { label: "Spa", group: "activity", tags: ["leisure:spa", "shop:massage"] },
  sports: { label: "Sports", group: "activity", tags: ["leisure:sports_centre", "leisure:swimming_pool", "leisure:ice_rink"] },
  heritage: {
    label: "Heritage",
    group: "activity",
    outdoor: true,
    tags: ["historic:monument", "historic:memorial", "historic:castle", "historic:fort", "historic:palace", "historic:ruins"],
  },
  attraction: { label: "Attraction", group: "activity", busy: true, tags: ["tourism:attraction"] },
  market: { label: "Market", group: "activity", busy: true, outdoor: true, tags: ["amenity:marketplace"] },
  mall: { label: "Mall", group: "activity", busy: true, tags: ["shop:mall"] },
  restaurant: { label: "Restaurant", group: "food", tags: ["amenity:restaurant"] },
  cafe: { label: "Café", group: "food", tags: ["amenity:cafe"] },
  street_food: { label: "Quick bites", group: "food", tags: ["amenity:fast_food", "amenity:food_court"] },
  dessert: { label: "Dessert", group: "food", tags: ["amenity:ice_cream", "shop:confectionery", "shop:pastry", "shop:ice_cream"] },
  bakery: { label: "Bakery", group: "food", tags: ["shop:bakery"] },
} satisfies Record<string, KindDef>;

export type KindKey = keyof typeof KINDS;
const ALL = Object.keys(KINDS) as KindKey[];
export const ACTIVITY_KINDS = ALL.filter((k) => KINDS[k].group === "activity");
export const FOOD_KINDS = ALL.filter((k) => KINDS[k].group === "food");

export const UA = "saturday-planner/1.0 (demo app)";
const OSM_TYPE: Record<string, string> = { N: "node", W: "way", R: "relation" };

interface Candidate {
  kind: KindKey;
  name: string;
  lat: number;
  lon: number;
  osm: string; // N123, W456
  tags: Record<string, string>;
}

async function getJson<T>(url: string, revalidate: number, retry = true): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en" },
    signal: AbortSignal.timeout(7000),
    next: { revalidate },
  });
  if ((res.status === 429 || res.status === 503) && retry) {
    await new Promise((r) => setTimeout(r, 700)); // public servers throttle bursts; one polite retry
    return getJson<T>(url, revalidate, false);
  }
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Nearest named places for a group of kinds, in one Photon reverse search with OSM tag filters. */
async function photon(kinds: KindKey[], lat: number, lon: number, radiusM: number): Promise<Candidate[]> {
  if (!kinds.length) return [];
  const tags = kinds.flatMap((k) => (KINDS[k] as KindDef).tags);
  const url =
    `https://photon.komoot.io/reverse?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius=${radiusM / 1000}&limit=50&` +
    tags.map((t) => `osm_tag=${encodeURIComponent(t)}`).join("&");
  const j = await getJson<{
    features: {
      properties: { osm_type: string; osm_id: number; osm_key: string; osm_value: string; name?: string };
      geometry: { coordinates: [number, number] };
    }[];
  }>(url, 86400);
  return j.features.flatMap(({ properties: p, geometry }) => {
    const kind = kinds.find((k) => (KINDS[k] as KindDef).tags.includes(`${p.osm_key}:${p.osm_value}`));
    return kind && p.name
      ? [{ kind, name: p.name.trim(), lat: geometry.coordinates[1], lon: geometry.coordinates[0], osm: `${p.osm_type}${p.osm_id}`, tags: {} }]
      : [];
  });
}

/** One Nominatim lookup adds the tags Photon leaves out (opening hours, cuisine, diet, brand). */
async function addTags(cands: Candidate[]): Promise<void> {
  if (!cands.length) return;
  const rows = await getJson<{ osm_type: string; osm_id: number; extratags?: Record<string, string> | null }[]>(
    `https://nominatim.openstreetmap.org/lookup?osm_ids=${cands.map((c) => c.osm).join(",")}&format=jsonv2&extratags=1`,
    86400,
  );
  const byId = new Map(rows.map((r) => [`${r.osm_type[0].toUpperCase()}${r.osm_id}`, r.extratags ?? {}]));
  for (const c of cands) c.tags = byId.get(c.osm) ?? {};
}

/** Backup source: one bounding-box query to the public Overpass API. */
async function overpass(kinds: KindKey[], lat: number, lon: number, radiusM: number): Promise<Candidate[]> {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((n) => n.toFixed(4)).join(",");
  const parts = kinds.flatMap((k) =>
    (KINDS[k] as KindDef).tags.map((t) => {
      const [key, value] = t.split(":");
      return `nwr["${key}"="${value}"]["name"](${bbox});`;
    }),
  );
  const query = `[out:json][timeout:12];(${parts.join("")});out center tags 300;`;
  const j = await getJson<{
    elements: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[];
  }>(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, 86400);
  return j.elements.flatMap((el) => {
    const tags = el.tags ?? {};
    const kind = kinds.find((k) => (KINDS[k] as KindDef).tags.some((t) => tags[t.split(":")[0]] === t.split(":")[1]));
    const plat = el.lat ?? el.center?.lat;
    const plon = el.lon ?? el.center?.lon;
    return kind && tags.name && plat != null && plon != null
      ? [{ kind, name: tags.name.trim(), lat: plat, lon: plon, osm: `${el.type[0].toUpperCase()}${el.id}`, tags }]
      : [];
  });
}

/** Find, enrich, rank and trim places. Throws only when every source failed. */
export async function findPlaces(
  kinds: KindKey[],
  center: { lat: number; lon: number },
  radiusM: number,
  limits: { activity: number; food: number },
): Promise<{ places: Place[]; source: string; notes: string[] }> {
  const notes: string[] = [];
  const groups = [kinds.filter((k) => KINDS[k].group === "activity"), kinds.filter((k) => KINDS[k].group === "food")];
  const settled = await Promise.allSettled(groups.map((g) => photon(g, center.lat, center.lon, radiusM)));
  settled.forEach((s) => s.status === "rejected" && notes.push(String(s.reason?.message ?? s.reason)));
  let cands: Candidate[];
  let source = "Photon";
  if (settled.some((s) => s.status === "fulfilled")) {
    const dist = (c: Candidate) => -haversineKm(center, c);
    const found = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    // Nominatim lookup takes 50 ids, so pre-pick the nearest of every kind before adding tags.
    cands = [
      ...roundRobin(found.filter((c) => KINDS[c.kind].group === "activity"), 22, dist),
      ...roundRobin(found.filter((c) => KINDS[c.kind].group === "food"), 26, dist),
    ];
    try {
      await addTags(cands);
      source += " + Nominatim tags";
    } catch (e) {
      notes.push(`tags unavailable (${e instanceof Error ? e.message : e})`);
    }
  } else {
    source = "Overpass";
    try {
      cands = await overpass(kinds, center.lat, center.lon, radiusM);
    } catch (e) {
      notes.push(`Overpass: ${e instanceof Error ? e.message : e}`);
      throw new Error(`Every place source failed (${notes.join("; ")})`);
    }
  }
  return { places: rank(cands, center, radiusM, limits), source, notes };
}

function roundRobin<T extends { kind: string }>(items: T[], limit: number, score: (t: T) => number): T[] {
  const byKind = new Map<string, T[]>();
  for (const it of items) byKind.set(it.kind, [...(byKind.get(it.kind) ?? []), it]);
  const queues = [...byKind.values()].map((q) => q.sort((a, b) => score(b) - score(a)));
  const out: T[] = [];
  while (out.length < limit && queues.some((q) => q.length))
    for (const q of queues) if (q.length && out.length < limit) out.push(q.shift()!);
  return out;
}

function rank(
  cands: Candidate[],
  center: { lat: number; lon: number },
  radiusM: number,
  limits: { activity: number; food: number },
): Place[] {
  const best = new Map<string, Place & { score: number }>();
  for (const c of cands) {
    const def = KINDS[c.kind] as KindDef;
    const t = c.tags;
    const dist = Math.round(haversineKm(center, c) * 1000);
    const diet = t["diet:vegetarian"];
    const veg = /^(only|yes|limited|no)$/.test(diet ?? "")
      ? (diet as Place["veg"])
      : /pure veg/i.test(c.name)
        ? "only"
        : /vegetarian/.test(t.cuisine ?? "")
          ? "yes"
          : undefined;
    const richness =
      (t.opening_hours ? 1.5 : 0) +
      (t.cuisine ? 1 : 0) +
      (diet ? 1 : 0) +
      (t.website || t["contact:website"] || t.phone || t["contact:phone"] ? 0.5 : 0) +
      (t.wikidata ? 0.5 : 0);
    const score = richness - (t.brand ? 1.5 : 0) - (dist / radiusM) * 2; // local spots over chains
    const place = {
      id: "",
      name: c.name,
      kind: c.kind,
      label: def.label,
      group: def.group,
      lat: c.lat,
      lon: c.lon,
      dist,
      hours: t.opening_hours?.slice(0, 80),
      veg,
      cuisine: t.cuisine?.split(";").slice(0, 2).join(", ").replace(/_/g, " "),
      busy: !!def.busy || t.tourism === "attraction" || (!!t.wikidata && (c.kind === "museum" || c.kind === "heritage")),
      outdoor: !!def.outdoor,
      osm: `${OSM_TYPE[c.osm[0]]}/${c.osm.slice(1)}`,
      score,
    };
    const key = c.name.toLowerCase();
    if (!best.has(key) || best.get(key)!.score < score) best.set(key, place);
  }

  const all = [...best.values()];
  return (["activity", "food"] as const).flatMap((group) =>
    roundRobin(all.filter((p) => p.group === group), limits[group], (p) => p.score).map(({ score, ...p }, i) => ({
      ...p,
      id: `${group === "activity" ? "a" : "f"}${i + 1}`,
    })),
  );
}
