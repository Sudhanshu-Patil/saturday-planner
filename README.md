# Saturday planner

An agent that turns your city, budget, free time and mood into a realistic Saturday plan made of real places. It checks the plan in code and shows every step it took.

**Live:** https://saturday-planner-dusky.vercel.app

## Try it

Open the live URL and press **Plan my Saturday**. The box is prefilled with the example from the brief. The chips under it fill in other cases:

| Chip | What you should see |
|---|---|
| The brief's JSON | The exact JSON input from the assignment, accepted as is |
| Vague | "I'm bored": the agent asks 1 or 2 questions with answer options |
| Unknown city | "Wakanda": the agent asks which real city you meant |
| ₹100 budget | The first draft goes over budget, the validator rejects it, and the agent revises it and names the trade-off |
| Off-topic | The agent steers back to planning |
| Reviewer tools → Simulate a map data outage | Every place source fails. The plan comes back marked unverified, with a banner |
| Reviewer tools → Simulate a Groq rate limit | The trace shows the switch from `gpt-oss-120b` to `gpt-oss-20b` |

The API takes the brief's JSON directly:

```bash
curl -N -X POST https://saturday-planner-dusky.vercel.app/api/plan -H "Content-Type: application/json" \
  -d '{"city":"Bangalore","budget":2000,"available_time":"4 hours","mood":"tired but wants to do something fun","interests":["food","music","walks"],"constraints":["vegetarian","avoid crowded places"]}'
```

It streams one JSON event per line: model turns, tool start and end, the brief, then the plan or clarifying questions, and finally run stats.

## How it works

```
request ─▶ Groq tool-calling loop (gpt-oss-120b → gpt-oss-20b → qwen3.8-27b on rate limits)
              │
              ├─ findOptions ──────────▶ parseUserPreferences   normalise window, budget, flags; state assumptions
              │                          getLocation            Nominatim (Open-Meteo geocoding as backup)
              │                          getWeather             Open-Meteo hourly rain + sunset for that Saturday
              │                          getActivityOptions  ┐  Photon (OSM search) + one Nominatim lookup for tags
              │                          getFoodOptions      ┘  (Overpass as backup)
              │
              ├─ generateFinalPlan ────▶ estimateCost          legs (walk or ride), fares, totals
              │                          validatePlan          rules below; errors go back to the model (≤2 revisions)
              │
              └─ askClarifyingQuestions  ends the run with option chips
```

**The model decides; code checks.** The model chooses whether to ask or plan, which neighbourhood suits the mood, what to search for, which stops to pick and in what order, and how to fix a rejected draft. Code does what code is better at: fetching data, maths, and rules. `validatePlan` ([lib/plan.ts](lib/plan.ts), unit-tested) rejects a plan when:

- a stop's id wasn't returned by the search (the model can't invent places)
- stops overlap, fall outside the time window, or leave less time than the computed travel between them
- a place is closed during its slot, according to its OpenStreetMap `opening_hours`
- an outdoor stop is scheduled when the rain chance is 70% or more
- a food stop is tagged non-vegetarian for a vegetarian user, or a place is crowd-prone for someone avoiding crowds
- the total, including rides, is over budget, unless it's within 15% and a trade-off says why
- a stop needs a ride but the fare is zero

Softer issues come back as heads-ups: no diet tag, hours not listed, a park after sunset, a long walk for a tired user.

**Why three coarse tools rather than many small ones.** Groq's free tier allows 8K tokens per minute per model, and gpt-oss can't call tools in parallel, so every model turn costs tokens and time. So:
- The model sees three tools. Each one runs several named functions, and each function shows up as its own trace step.
- Tool results come back as compact lines, not JSON.
- A typical plan takes 3 model turns, about 8K tokens and 7 to 10 seconds.
- When one model's quota runs out, the agent switches to the next model, which has its own quota bucket.

**Why Photon rather than Overpass.** The public Overpass server now answers automated requests with "at capacity… for automated use, run a local instance". Photon (komoot's OpenStreetMap search) returns nearby places for a set of OSM tags in under a second. One Nominatim lookup then adds opening hours, cuisine and diet tags. Overpass is still tried if Photon fails.

## Run locally

```bash
npm install
echo GROQ_API_KEY=your_key > .env.local   # free key from console.groq.com, no card
npm run dev                                # http://localhost:3000
npm test                                   # validator unit tests
npx tsx scripts/eval.mts                   # scenario evals against a running server (uses the free quota)
```

Everything the app uses is free and keyless apart from Groq: OpenStreetMap (Photon, Nominatim, Overpass, map tiles) and Open-Meteo.

## Evals

`scripts/eval.mts` runs six scenarios against the live deployment and checks invariants: a plan exists, every stop came from OSM, the total is within budget, food is veg-safe, no validator errors are left, questions are asked when they should be, and the model fallback fires.

| Scenario | Result | Model turns | Tokens | Time |
|---|---|---|---|---|
| Brief example (JSON) | pass | 3 | 8,622 | 4.9s |
| Vague input | pass | 1 | 1,777 | 1.3s |
| Unknown city | pass | 1 | 1,795 | 1.0s |
| Tiny budget (₹100) | pass | 4 | 11,103 | 8.2s |
| Family day, Mumbai | fail on the eval run, pass on re-run | 3 | 8,747 | 8.4s |
| Rate limit fallback | pass | 2 | 4,573 | 4.2s |

The Mumbai failure ended without a plan, during back-to-back runs on the free Groq quota. Re-run on its own, it passed: the validator rejected a crowd-prone museum and the agent swapped it out. Free-tier limits are the main source of flakiness; the model fallback absorbs most of it.

## Design

The interface follows one direction: "Saturday light". Character: unhurried, exact, a little warm. Quiet graphite surfaces, a single marigold accent, and one rich moment, which is the day strip and route map. The dashed route line is the signature, and it appears on the map, between stops and in the wordmark.

It deliberately avoids the look AI-built UIs default to: cream backgrounds, italic serif accent words, numbered section labels, monospace or uppercase labels, pill buttons, gradients and glows, and emoji. Token values are adapted from [unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky (CC BY 4.0).

## How I used AI

I built this with Claude Code. I used it to plan the architecture, research data sources (it found that public Overpass was at capacity and proposed Photon with a Nominatim lookup), write and test the code, and drive the browser to check the UI on desktop and mobile. Its design skills (unslop-ui, web-design-guidelines) shaped the interface. I made the product calls: Groq on free tiers only, the "Saturday light" direction, failure handling testable from the UI, and code-enforced validation over prompt-only rules.

## What I'd do next

- Real events for the music and shows interests, through a search tool, with source links
- Use the user's own location or neighbourhood as the starting point
- Cache the place search per area to stay well inside free-tier limits
