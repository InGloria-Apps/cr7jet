# cr7jet-tracker — Design

**Date:** 2026-07-09
**Status:** Approved by user (structure, state machine, data flow, error handling, posting, testing)

## Purpose

A Node.js/TypeScript bot that monitors the private jet **LX-GOL** (ICAO24 hex `4d0226`) via public ADS-B aggregators and posts takeoff/landing notifications to Bluesky, with a static map image attached. Config is centralized so the bot is reusable for other aircraft.

## Architecture

**Pure-function state machine core + thin I/O shell.** The detection logic is a single pure function:

```ts
transition(state: TrackerState, obs: Observation, config: Config): { state: TrackerState; events: FlightEvent[] }
```

The core knows nothing about HTTP, SQLite, or Bluesky. The shell polls the APIs, feeds observations in, persists the returned state, and dispatches emitted events. Time is always an explicit parameter — no hidden clocks.

## Project structure

```
cr7jet-tracker/
├── src/
│   ├── index.ts               # entrypoint: wiring, --dry-run flag, graceful shutdown
│   ├── config.ts              # ALL tunables (see Config section)
│   ├── logger.ts              # pino, timestamped structured logs
│   ├── core/                  # pure, zero I/O, fully unit-tested
│   │   ├── types.ts           # Observation, TrackerState, FlightEvent
│   │   ├── stateMachine.ts    # transition()
│   │   └── geo.ts             # haversine distance
│   ├── adsb/
│   │   └── client.ts          # primary → fallback fetch, normalize to Observation, backoff
│   ├── airports/
│   │   └── airports.ts        # load vendored airports.csv; nearest airport/city; elevation
│   ├── store/
│   │   └── db.ts              # better-sqlite3: tracker_state, flights, posts
│   ├── bluesky/
│   │   ├── poster.ts          # @atproto/api login, uploadBlob → embed, post
│   │   └── messages.ts        # 🛫/🛬 text formatting, fuel-burn math
│   └── map/
│       └── staticMap.ts       # staticmaps → PNG buffer, OSM tiles, marker
├── data/airports.csv          # vendored OurAirports dataset
├── test/
│   ├── fixtures/              # recorded airplanes.live-shaped JSON
│   └── stateMachine.test.ts
├── Dockerfile                 # multi-stage
├── docker-compose.yml         # SQLite volume, env_file, restart: unless-stopped
├── .env.example
├── package.json, tsconfig.json (strict), vitest.config.ts
└── README.md
```

`airports.csv` is **vendored** (checked in), not downloaded at build time: reproducible, offline-capable builds. An `npm run update-airports` script refreshes it on demand.

## Data source

- Primary: `https://api.airplanes.live/v2/hex/4d0226`, polled every 30 s.
- Fallback: `https://api.adsb.lol/v2/hex/4d0226`, tried within the same cycle if the primary fails or returns no data.
- An empty `ac` array is **normal** (out of coverage), normalized to an `absent` observation — not an error.

### Observation normalization (in the ADS-B client)

Each poll cycle yields one of:

- `signal` — `{ ts, lat, lon, altFt: number | "ground", verticalRateFpm, groundSpeedKt }`
- `absent` — API responded, aircraft not present (normal)
- *poll failure* — network/API error. **Never reaches the state machine.** A failed poll is not evidence the jet vanished, so it must not advance signal-loss timers; the shell backs off and retries.

On-ground is detected via `alt_baro === "ground"`. Geometric altitude is preferred when present, barometric as fallback.

## State machine

States: `UNKNOWN`, `GROUNDED`, `AIRBORNE`, `SIGNAL_LOST`. The full state (including open-flight data and debounce candidate) is one serializable JSON snapshot.

```
UNKNOWN ──2× ground readings──▶ GROUNDED                     (no event)
UNKNOWN ──2× airborne readings──▶ AIRBORNE
    climbing & low  → TAKEOFF event
    at cruise       → mid-flight adoption, no event

GROUNDED ──2× airborne + climbing──▶ AIRBORNE                🛫 TAKEOFF
AIRBORNE ──2× ground readings──────▶ GROUNDED                🛬 LANDING
AIRBORNE ──absent──────────────────▶ SIGNAL_LOST             (internal, no event)
SIGNAL_LOST ──signal reacquired────▶ AIRBORNE / GROUNDED     (debounced as usual)
SIGNAL_LOST ──last AGL < 3,000 ft AND ≥ 5 min silent──▶ GROUNDED   🛬 presumed LANDING
SIGNAL_LOST ──≥ 18 h silent────────▶ UNKNOWN                 flight abandoned, no post
```

### Rules

- **Debounce:** a `candidate` (proposed phase + consecutive count) is tracked; 2 consecutive consistent readings commit a transition; a reading matching the committed phase resets the candidate. Event timestamps use the *first* of the two readings.
- **Takeoff detection:** grounded/absent → airborne emits TAKEOFF only when climbing (vertical rate > +300 fpm) **and** below the detection ceiling (8,000 ft AGL). Otherwise it is mid-flight adoption (open flight with unknown takeoff).
- **AGL:** ADS-B altitude is MSL. AGL = altitude − elevation of the nearest airport (elevation from OurAirports). Accurate exactly where it matters: near airports.
- **Presumed landing:** last seen below 3,000 ft AGL + 5 min of silence → LANDING at the nearest airport to the last position, regardless of the 10 km radius; worded "near \<airport\>" when beyond 10 km. Landing time = moment of signal loss. If the jet later reappears airborne: no correction post — climbing → new TAKEOFF; at cruise → silent mid-flight adoption.
- **Mid-flight adoption:** landing posts omit flight time and fuel burn when takeoff was not observed.
- **Stale flight:** signal lost above 3,000 ft AGL and never reacquired → after 18 h, silently reset to UNKNOWN and mark the flight `abandoned`. No post.

## Persistence (SQLite via better-sqlite3)

- **`tracker_state`** — single row, full state snapshot as JSON, written in a transaction with any emitted events.
- **`flights`** — takeoff/landing time, position, resolved airport, duration, `status` (`open`/`closed`/`abandoned`), `presumed_landing` flag.
- **`posts`** — idempotency ledger. Events are inserted as `pending` rows *in the same transaction* as the state update; the shell then posts to Bluesky and marks them `posted` (with URI). On restart, `pending` rows are retried unless older than 30 min, in which case they are marked `skipped`. This guarantees restarts cause neither duplicate nor missed posts.

## Airport resolution

At event-dispatch time (not in the core): nearest **medium or large** airport from OurAirports within 10 km → name, IATA/ICAO, municipality, country. If none within 10 km, show the nearest listed place from the same dataset. Presumed landings use "near \<airport\>" wording beyond 10 km.

## Bluesky posting

- `@atproto/api` `BskyAgent`; credentials from `.env` (`BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`) via dotenv.
- Takeoff: `🛫 Took off from Lisbon Humberto Delgado Airport (LIS), Portugal at 14:32 UTC`
- Landing: `🛬 Landed at Riyadh King Khalid Intl (RUH), Saudi Arabia at 19:05 UTC. Flight time: 4h 33m. Est. fuel burn: ~8,645 kg`
- Fuel burn = duration × 1,900 kg/h (config constant), thousands-separated; shown only when takeoff was observed.
- Map: `staticmaps` package, OSM tiles, zoom 9, marker at the event position, 800×500 PNG → `uploadBlob` → `app.bsky.embed.images` with descriptive alt text.

## Error handling & operations

- **ADS-B:** primary → fallback within one cycle; both failing = skipped cycle with exponential backoff (30 s → 1 m → 2 m → … cap 10 min), reset on success. Failures never masquerade as absence.
- **Bluesky:** 3 retries with backoff; if image upload fails but text works, post text-only. Persistent failure leaves the post `pending` for restart retry.
- **`--dry-run`:** full pipeline including map render; posts logged instead of sent, marked `dry_run` in the ledger.
- **Graceful shutdown:** SIGTERM/SIGINT → stop poll timer, finish in-flight cycle, close DB. Matching Docker `stop_grace_period`.
- **Logging:** pino, structured, timestamped; state transitions and dispatch outcomes logged at info, poll details at debug.

## Config (`src/config.ts`)

| Key | Default | Purpose |
|---|---|---|
| `aircraftHex` | `4d0226` | Target ICAO24 |
| `aircraftLabel` | `LX-GOL` | Display name |
| `pollIntervalMs` | 30 000 | Poll cadence |
| `primaryApiUrl` / `fallbackApiUrl` | airplanes.live / adsb.lol | Data sources |
| `debounceReadings` | 2 | Consecutive readings to commit a transition |
| `signalLossLandingAltFt` | 3 000 | AGL threshold for presumed landing |
| `signalLossConfirmMs` | 5 min | Silence required to confirm presumed landing |
| `nearAirportKm` | 10 | Airport resolution radius |
| `takeoffClimbFpm` | 300 | Min vertical rate for takeoff detection |
| `takeoffDetectionCeilingAglFt` | 8 000 | Above this, airborne appearance = mid-flight adoption |
| `staleFlightTimeoutMs` | 18 h | Abandon unresolved flights |
| `fuelBurnKgPerHour` | 1 900 | Global Express XRS estimate |
| `stalePostSkipMs` | 30 min | Pending posts older than this are skipped on restart |

## Testing (vitest, pure core only)

Fixture JSON shaped like real airplanes.live responses drives scenario tests:

1. Normal takeoff — grounded → climbing readings → TAKEOFF with timestamp from first reading.
2. Normal landing — airborne → ground readings → LANDING with correct duration.
3. Signal-loss landing — descent below 3,000 ft AGL → silence → presumed LANDING after 5 min; counter-case: reacquired at minute 4 → no event.
4. Flap debounce — single spurious ground reading mid-flight → no transition; alternating readings → no transition.
5. Mid-flight adoption — first seen at cruise → AIRBORNE, no takeoff event; later landing omits duration/fuel.
6. Stale flight — 18 h silence → reset to UNKNOWN, flight abandoned, no event.
7. Absence vs. failure — absent readings advance signal-loss timers; skipped (failed) cycles do not.

## Deployment

Multi-stage Dockerfile (build TS → slim runtime with `dist/` + `data/`). `docker-compose.yml` with a named volume for the SQLite file, `env_file: .env`, `restart: unless-stopped`. README covers setup, `.env` format, dry-run usage, and deployment.

## Implementation constraints

- TypeScript strict mode throughout.
- Any subagents used during implementation must be Haiku or Sonnet, max 3 total.