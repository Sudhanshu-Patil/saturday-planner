"use client";

import { ArrowsLeftRight, Brain, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { useMedia } from "@/lib/use-media";
import type { TraceEvent } from "@/lib/tools";

type Start = Extract<TraceEvent, { type: "tool_start" }>;
type End = Extract<TraceEvent, { type: "tool_end" }>;
export type Stats = Extract<TraceEvent, { type: "done" }>["stats"];
export type TraceItem =
  | { kind: "step"; start: Start; end?: End }
  | { kind: "turn"; turn: Extract<TraceEvent, { type: "turn" }> }
  | { kind: "fallback"; ev: Extract<TraceEvent, { type: "model_fallback" }> };

const shortModel = (m: string) => m.split("/").pop() ?? m;
const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Details({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group mt-1.5">
      <summary className="cursor-pointer list-none text-[12px] leading-4 text-ink-3 transition-colors duration-150 hover:text-ink-2">
        {label}
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-[8px] bg-raised p-3 text-[11px] leading-4 whitespace-pre-wrap text-ink-2">
        {children}
      </pre>
    </details>
  );
}

function StepRow({ start, end }: { start: Start; end?: End }) {
  const icon = !end ? (
    <span className="spinner" aria-label="Running" />
  ) : end.ok ? (
    <CheckCircle size={16} className="text-ok" aria-label="Done" />
  ) : (
    <WarningCircle size={16} className="text-bad" aria-label="Problem" />
  );
  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2.5 py-2">
      <span className="grid h-5 place-items-center">{icon}</span>
      <div className="min-w-0">
        <p className="text-[14px] leading-5 text-ink">
          {start.label} <span className="text-[12px] text-ink-3">{start.name}</span>
        </p>
        {start.why && <p className="text-[13px] leading-5 text-ink-3">“{start.why}”</p>}
        {end && <p className="text-[13px] leading-5 break-words text-ink-2">{end.summary}</p>}
        {end && (
          <Details label="Input and output">
            {JSON.stringify({ input: start.input, output: end.output }, null, 2)}
          </Details>
        )}
      </div>
      <span className="tnum text-[12px] leading-5 text-ink-3">{end ? `${(end.ms / 1000).toFixed(1)}s` : ""}</span>
    </li>
  );
}

export function Trace({ items, stats, running }: { items: TraceItem[]; stats: Stats | null; running: boolean }) {
  const desktop = useMedia("(min-width: 1024px)");
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? (desktop || running); // phones: watch it run, then fold it away under the plan
  const setOpen = (f: (o: boolean) => boolean) => setChoice(f(open));
  if (!items.length && !running) return null;
  const steps = items.filter((i) => i.kind === "step").length;
  return (
    <section aria-labelledby="trace-title" className="rounded-[16px] border border-line bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <h2 id="trace-title" className="text-[15px] font-medium">
          How I planned it
        </h2>
        <span className="text-[12px] text-ink-3">
          {running ? "Working…" : `${steps} steps`} · {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="border-t border-line px-4 pb-3">
          <ol role="log" aria-live="polite" aria-relevant="additions" className="divide-y divide-line">
            {items.map((item, i) =>
              item.kind === "step" ? (
                <StepRow key={item.start.id} start={item.start} end={item.end} />
              ) : item.kind === "turn" ? (
                <li key={`t${i}`} className="grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2.5 py-2">
                  <span className="grid h-5 place-items-center text-ink-3">
                    <Brain size={16} aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13px] leading-5 text-ink-2">
                      Model turn {item.turn.n} chose <span className="text-ink">{item.turn.action}</span>
                    </p>
                    <p className="text-[12px] leading-4 text-ink-3">
                      {shortModel(item.turn.model)} on Groq · {kTokens(item.turn.tokens)} tokens
                    </p>
                    {item.turn.reasoning && <Details label="Model reasoning (raw)">{item.turn.reasoning}</Details>}
                  </div>
                  <span className="tnum text-[12px] leading-5 text-ink-3">{(item.turn.ms / 1000).toFixed(1)}s</span>
                </li>
              ) : (
                <li key={`f${i}`} className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 py-2">
                  <span className="grid h-5 place-items-center text-warn">
                    <ArrowsLeftRight size={16} aria-hidden />
                  </span>
                  <p className="text-[13px] leading-5 text-ink-2">
                    {shortModel(item.ev.from)} hit a {item.ev.reason}, so I switched to {shortModel(item.ev.to)}
                  </p>
                </li>
              ),
            )}
            {running && !items.some((i) => i.kind === "step" && !i.end) && (
              <li className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 py-2">
                <span className="grid h-5 place-items-center">
                  <span className="spinner" aria-hidden />
                </span>
                <p className="text-[13px] leading-5 text-ink-3">Thinking…</p>
              </li>
            )}
          </ol>
          {stats && (
            <p className="tnum mt-2 border-t border-line pt-3 text-[12px] leading-4 text-ink-3">
              {stats.turns} model turns · {stats.calls} function calls · {kTokens(stats.tokens)} tokens ·{" "}
              {(stats.ms / 1000).toFixed(1)}s · {stats.models.map(shortModel).join(", ")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
