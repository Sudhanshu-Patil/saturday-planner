"use client";

import {
  ArrowSquareOut,
  Car,
  Check,
  Copy,
  Footprints,
  MapTrifold,
  SunHorizon,
  WarningCircle,
} from "@phosphor-icons/react";
import { useState } from "react";
import { clock, day, money, span, toMinutes } from "@/lib/format";
import type { FinalPlan } from "@/lib/plan";

const REFINE = ["Make it cheaper", "Less walking", "More food", "Start later", "Keep it indoors"];

function DayStrip({ plan }: { plan: FinalPlan }) {
  const { start, end } = plan.window;
  const pct = (m: number) => `${(Math.min(Math.max(m, start), end) - start) / ((end - start) / 100)}%`;
  const hours: number[] = []; // labelled hour ticks
  for (let h = Math.ceil(start / 60); h * 60 <= end; h++) hours.push(h);
  const slots: number[] = []; // every hour the window touches, for rain shading
  for (let h = Math.floor(start / 60); h < Math.ceil(end / 60); h++) slots.push(h);
  const w = plan.weather;
  const stops = plan.stops.map((s) => ({ ...s, a: toMinutes(s.start), b: toMinutes(s.end) }));
  return (
    <figure className="rounded-[14px] border border-line bg-card px-4 pt-3 pb-4" aria-label="Your Saturday at a glance">
      <div className="relative h-4 text-[11px] leading-4 text-ink-3">
        {hours.map((h) => (
          <span
            key={h}
            className={`tnum absolute whitespace-nowrap ${h * 60 >= end ? "-translate-x-full" : h * 60 <= start ? "" : "-translate-x-1/2"}`}
            style={{ left: pct(h * 60) }}
          >
            {clock(h * 60).replace(":00", "")}
          </span>
        ))}
      </div>
      <div className="relative mt-2 h-10 rounded-[8px] bg-raised">
        {w &&
          slots.map((h) => {
            const rain = w.rain[h] ?? 0;
            return rain >= 20 ? (
              <span
                key={`r${h}`}
                className="absolute inset-y-0"
                style={{ left: pct(h * 60), width: `calc(${pct((h + 1) * 60)} - ${pct(h * 60)})`, background: "var(--rain)", opacity: Math.min(1, rain / 70) }}
                title={`${rain}% chance of rain`}
              />
            ) : null;
          })}
        {stops.slice(1).map((s, i) => (
          <span
            key={`g${i}`}
            className="absolute top-1/2 border-t-2 border-dashed border-route"
            style={{ left: pct(stops[i].b), width: `calc(${pct(s.a)} - ${pct(stops[i].b)})` }}
          />
        ))}
        {stops.map((s, i) => (
          <span
            key={i}
            className="absolute inset-y-1 flex items-center gap-1.5 overflow-hidden rounded-[6px] border border-line-strong bg-card px-2 text-[12px] leading-4 whitespace-nowrap text-ink"
            style={{ left: pct(s.a), width: `calc(${pct(s.b)} - ${pct(s.a)})` }}
            title={`${s.start} to ${s.end} · ${s.name}`}
          >
            <span className="tnum text-ink-3">{i + 1}</span>
            <span className="truncate">{s.name}</span>
          </span>
        ))}
        {w?.sunset != null && w.sunset > start && w.sunset < end && (
          <span className="absolute -inset-y-1 w-0.5 rounded-full bg-route" style={{ left: pct(w.sunset) }} title={`Sunset ${clock(w.sunset)}`} />
        )}
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-4 text-ink-3">
        {w ? (
          <>
            <span>
              {w.tmin}–{w.tmax}°C
            </span>
            {w.sunset != null && (
              <span className="flex items-center gap-1">
                <SunHorizon size={14} aria-hidden /> Sunset {clock(w.sunset)}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-[2px]" style={{ background: "var(--rain)" }} /> Rain chance
            </span>
          </>
        ) : (
          <span>No forecast available</span>
        )}
      </figcaption>
    </figure>
  );
}

function Badge({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "warn" }) {
  return (
    <span
      className={`inline-flex items-center rounded-[6px] px-1.5 py-0.5 text-[12px] leading-4 ${
        tone === "warn" ? "bg-raised text-warn" : "bg-raised text-ink-2"
      }`}
    >
      {children}
    </span>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section>
      <h3 className="text-[13px] leading-5 text-ink-3">{title}</h3>
      <ul className="mt-2 space-y-1.5 text-[14px] leading-5 text-ink-2">
        {items.map((t, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-3" />
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function planAsText(plan: FinalPlan): string {
  const lines = [plan.title, `${day(plan.date)} · ${span(plan.window.start, plan.window.end)} · ${plan.area}`, ""];
  plan.stops.forEach((s, i) => {
    lines.push(`${i + 1}. ${clock(toMinutes(s.start))} to ${clock(toMinutes(s.end))}  ${s.name}: ${s.activity} (${s.cost ? money(s.cost, plan.currency) : "free"})`);
    const leg = plan.legs[i];
    if (leg) lines.push(`   ${leg.mode === "walk" ? `${leg.minutes} min walk` : `${leg.minutes} min ride, about ${money(leg.fare, plan.currency)}`}`);
  });
  lines.push("", `Total about ${money(plan.totals.total, plan.currency)}${plan.budget != null ? ` of ${money(plan.budget, plan.currency)}` : ""}`);
  if (plan.routeUrl) lines.push(`Route: ${plan.routeUrl}`);
  return lines.join("\n");
}

export function PlanView({ plan, onRefine }: { plan: FinalPlan; onRefine: (adjustment: string) => void }) {
  const [copied, setCopied] = useState(false);
  const { totals, budget, currency } = plan;
  const over = budget != null && totals.total > budget;
  const share = budget ? Math.min(100, (totals.total / budget) * 100) : 0;

  return (
    <article className="space-y-8">
      {plan.degraded && (
        <p className="flex gap-2 rounded-[14px] border border-line bg-card p-4 text-[14px] leading-5 text-ink-2">
          <WarningCircle size={18} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          Live map data was down, so these places come from the model&apos;s own knowledge. They are unverified, so check them
          before you go.
        </p>
      )}

      <header>
        <p className="text-[13px] leading-5 text-ink-3">
          {day(plan.date)} · {span(plan.window.start, plan.window.end)} · {plan.area}
        </p>
        <h2 className="mt-1 text-[28px] leading-[1.15] font-medium tracking-[-0.01em] text-balance">{plan.title}</h2>
        <p className="mt-2 max-w-[62ch] text-[15px] leading-[22px] text-ink-2">{plan.summary}</p>
        <div className="mt-5 max-w-sm">
          <p className="tnum flex items-baseline justify-between text-[14px] leading-5">
            <span>
              <span className="text-[20px] font-medium">{money(totals.total, currency)}</span>
              <span className="text-ink-3">{budget != null ? ` of ${money(budget, currency)}` : " estimated"}</span>
            </span>
            <span className={over ? "text-warn" : "text-ink-3"}>
              {budget == null ? "" : over ? `${money(totals.total - budget, currency)} over` : `${money(budget - totals.total, currency)} left`}
            </span>
          </p>
          {budget != null && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised" role="meter" aria-valuenow={totals.total} aria-valuemin={0} aria-valuemax={budget} aria-label="Budget used">
              <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
            </div>
          )}
          <p className="tnum mt-2 text-[12px] leading-4 text-ink-3">
            {money(totals.stops, currency)} at stops · {money(totals.transport, currency)} on rides · {totals.walkKm} km on foot
            {plan.group > 1 ? ` · for ${plan.group}` : ""}
          </p>
        </div>
      </header>

      <DayStrip plan={plan} />

      {plan.warnings.length > 0 && (
        <ul className="space-y-1.5 text-[13px] leading-5 text-ink-2">
          {plan.warnings.map((w, i) => (
            <li key={i} className="flex gap-2">
              <WarningCircle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      )}

      <ol>
        {plan.stops.map((s, i) => {
          const p = s.place;
          const leg = plan.legs[i];
          const last = i === plan.stops.length - 1;
          return (
            <li key={i} className="rise grid grid-cols-[64px_28px_minmax(0,1fr)] gap-x-3" style={{ animationDelay: `${Math.min(i, 5) * 50}ms` }}>
              <p className="tnum pt-1 text-[13px] leading-5 text-ink-2">
                {clock(toMinutes(s.start))}
                <span className="block text-ink-3">{clock(toMinutes(s.end))}</span>
              </p>
              <div className="flex flex-col items-center">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-[13px] leading-none font-medium text-accent-ink">
                  {i + 1}
                </span>
                {!last && <span aria-hidden className="mt-1 w-0 flex-1 border-l-2 border-dashed border-route" />}
              </div>
              <div className={last ? "pb-2" : "pb-6"}>
                <div className="flex items-start justify-between gap-4">
                  <h3 className="text-[17px] leading-6 font-medium">{s.name}</h3>
                  <p className="tnum shrink-0 pt-0.5 text-[14px] leading-5 text-ink-2">
                    {s.cost ? money(s.cost, currency) : "Free"}
                    {plan.group > 1 && s.cost ? <span className="text-ink-3"> each</span> : null}
                  </p>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {p && <Badge>{[p.label, p.cuisine].filter(Boolean).join(" · ")}</Badge>}
                  {p?.veg === "only" && <Badge>Pure veg</Badge>}
                  {(p?.veg === "yes" || p?.veg === "limited") && <Badge>Veg options</Badge>}
                  {p?.hours && <Badge>Hours {p.hours}</Badge>}
                  {p?.unverified && <Badge tone="warn">Unverified</Badge>}
                </div>
                <p className="mt-2 text-[15px] leading-[22px] text-ink">{s.activity}</p>
                <p className="mt-1 text-[14px] leading-5 text-ink-2">
                  <span className="text-ink-3">Why it fits you: </span>
                  {s.why}
                </p>
                {s.tip && <p className="mt-1 text-[13px] leading-5 text-ink-3">{s.tip}</p>}
                {p && (
                  <p className="mt-2 flex gap-4 text-[12px] leading-4">
                    <a className="inline-flex items-center gap-1 text-ink-3 transition-colors duration-150 hover:text-ink" href={p.mapsUrl} target="_blank" rel="noreferrer">
                      Google Maps <ArrowSquareOut size={12} aria-hidden />
                    </a>
                    {p.osmUrl && (
                      <a className="inline-flex items-center gap-1 text-ink-3 transition-colors duration-150 hover:text-ink" href={p.osmUrl} target="_blank" rel="noreferrer">
                        OpenStreetMap <ArrowSquareOut size={12} aria-hidden />
                      </a>
                    )}
                  </p>
                )}
                {!last && leg && (
                  <p className="tnum mt-4 flex items-center gap-1.5 text-[12px] leading-4 text-ink-3">
                    {leg.mode === "walk" ? <Footprints size={14} aria-hidden /> : <Car size={14} aria-hidden />}
                    {leg.mode === "walk"
                      ? `${leg.minutes} min walk · ${leg.km} km`
                      : `${leg.approx ? "About " : ""}${leg.minutes} min ride · ${leg.km} km · ${money(leg.fare, currency)}`}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-6 md:grid-cols-2">
        <List title="Trade-offs" items={plan.tradeoffs} />
        <List title="Assumptions" items={plan.assumptions} />
        {plan.backup && <List title="If plans change" items={[plan.backup]} />}
      </div>

      <div className="space-y-4 border-t border-line pt-6">
        <div className="flex flex-wrap gap-2">
          {plan.routeUrl && (
            <a
              href={plan.routeUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-line-strong bg-card px-4 text-[14px] transition-colors duration-150 hover:bg-raised"
            >
              <MapTrifold size={16} aria-hidden /> Open route in Google Maps
            </a>
          )}
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(planAsText(plan));
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
            className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-line-strong bg-card px-4 text-[14px] transition-colors duration-150 hover:bg-raised"
          >
            {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />} {copied ? "Copied" : "Copy plan"}
          </button>
        </div>
        <div>
          <p className="text-[13px] leading-5 text-ink-3">Not quite right?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {REFINE.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => onRefine(r)}
                className="h-8 rounded-[8px] bg-raised px-3 text-[13px] text-ink-2 transition-colors duration-150 hover:text-ink"
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
