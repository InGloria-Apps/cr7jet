# cr7jet-tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js/TypeScript bot that tracks LX-GOL (hex `4d0226`) via ADS-B and posts takeoff/landing notifications with map images to Bluesky.

**Architecture:** Pure state-machine core (`transition(state, obs, cfg) → { state, events }`) with a thin I/O shell: ADS-B poller (primary + fallback), SQLite persistence (state snapshot + pending-post ledger in one transaction), Bluesky dispatcher. Spec: `docs/superpowers/specs/2026-07-09-cr7jet-tracker-design.md`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), better-sqlite3, @atproto/api, staticmaps, pino, dotenv, vitest.

## Global Constraints

- TypeScript strict mode; `"type": "module"`; Node >= 20 (global `fetch`).
- All tunables live in `src/config.ts` with exactly these values: hex `4d0226`, poll 30 000 ms, debounce 2 readings, signal-loss landing alt 3 000 ft AGL, signal-loss confirm 5 min, near-airport radius 10 km, takeoff climb 300 fpm, takeoff detection ceiling 8 000 ft AGL, stale flight timeout 18 h, fuel burn 1 900 kg/h, stale post skip 30 min, max backoff 10 min.
- Dependencies are fixed: `@atproto/api`, `better-sqlite3`, `dotenv`, `pino`, `staticmaps` (dev: `typescript`, `vitest`, `tsx`, `@types/node`, `@types/better-sqlite3`). Add nothing else.
- API failure must NEVER reach the state machine (only `signal`/`absent` observations do). Failure ≠ absence.
- Execution constraint: subagents must be Haiku or Sonnet, max 3 total.
- Ponytail style: minimal code, no unrequested abstractions; deliberate ceilings get a `// ponytail:` comment.
- Commit after every task with the message given in its final step.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/config.ts`, `src/logger.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `config` object (shape below — later tasks import `config` and `MachineConfig` values from it), `logger` (pino instance)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "cr7jet-tracker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "update-airports": "curl -fSL https://davidmegginson.github.io/ourairports-data/airports.csv -o data/airports.csv"
  },
  "dependencies": {
    "@atproto/api": "^0.13.35",
    "better-sqlite3": "^11.8.0",
    "dotenv": "^16.4.7",
    "pino": "^9.6.0",
    "staticmaps": "^1.13.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

No `vitest.config.ts` — vitest defaults (`**/*.test.ts`) cover us.

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
dist/
.env
data/*.db*
.idea/
```

- [ ] **Step 4: Write `.env.example`**

```
BLUESKY_HANDLE=your-handle.bsky.social
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
# Optional overrides:
# LOG_LEVEL=debug
# DB_PATH=data/tracker.db
```

- [ ] **Step 5: Write `src/config.ts`**

```ts
export const config = {
  aircraftHex: '4d0226',
  aircraftLabel: 'LX-GOL',
  pollIntervalMs: 30_000,
  primaryApiUrl: 'https://api.airplanes.live/v2/hex/',
  fallbackApiUrl: 'https://api.adsb.lol/v2/hex/',
  maxBackoffMs: 600_000,
  machine: {
    debounceReadings: 2,
    signalLossLandingAltFt: 3_000,
    signalLossConfirmMs: 5 * 60_000,
    takeoffClimbFpm: 300,
    takeoffDetectionCeilingAglFt: 8_000,
    staleFlightTimeoutMs: 18 * 3_600_000,
  },
  nearAirportKm: 10,
  fuelBurnKgPerHour: 1_900,
  stalePostSkipMs: 30 * 60_000,
  dbPath: process.env.DB_PATH ?? 'data/tracker.db',
  airportsCsvPath: 'data/airports.csv',
  map: { width: 800, height: 500, zoom: 9 },
};
```

- [ ] **Step 6: Write `src/logger.ts`**

```ts
import { pino } from 'pino';

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
```

- [ ] **Step 7: Install and verify**

Run: `npm install && npx tsc && npx vitest run`
Expected: install succeeds; `tsc` exits 0; vitest reports "No test files found" (exit code may be 1 — that's fine at this stage).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example src/config.ts src/logger.ts
git commit -m "feat: scaffold cr7jet-tracker (config, logger, toolchain)"
```

---

### Task 2: Core types + geo

**Files:**
- Create: `src/core/types.ts`, `src/core/geo.ts`
- Test: `test/geo.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (used by every later task):
  - `Position { lat: number; lon: number }`
  - `SignalObs { kind: 'signal'; ts: number; lat: number; lon: number; altFt: number | 'ground'; aglFt: number | null; verticalRateFpm: number | null }`
  - `AbsentObs { kind: 'absent'; ts: number }`, `Observation = SignalObs | AbsentObs`
  - `Phase = 'unknown' | 'grounded' | 'airborne' | 'signal_lost'`
  - `TrackerState`, `initialState`, `FlightEvent`, `MachineConfig` (exact shapes below)
  - `haversineKm(a: Position, b: Position): number`

- [ ] **Step 1: Write `src/core/types.ts`**

```ts
export interface Position {
  lat: number;
  lon: number;
}

export interface SignalObs {
  kind: 'signal';
  ts: number; // ms epoch
  lat: number;
  lon: number;
  altFt: number | 'ground';
  aglFt: number | null; // computed by the shell (alt MSL − nearest airport elevation); null on ground
  verticalRateFpm: number | null;
}

export interface AbsentObs {
  kind: 'absent'; // API answered, aircraft not present — normal, NOT an error
  ts: number;
}

export type Observation = SignalObs | AbsentObs;

export type Phase = 'unknown' | 'grounded' | 'airborne' | 'signal_lost';

export interface OpenFlight {
  takeoffTs: number | null; // null = adopted mid-flight, takeoff never observed
  takeoffPos: Position | null;
}

export interface TrackerState {
  phase: Phase;
  flight: OpenFlight | null; // set while airborne / signal_lost
  lastSignal: SignalObs | null;
  lostSinceTs: number | null; // when phase became signal_lost
  candidate: { phase: 'grounded' | 'airborne'; count: number; firstObs: SignalObs } | null; // debounce
}

export const initialState: TrackerState = {
  phase: 'unknown',
  flight: null,
  lastSignal: null,
  lostSinceTs: null,
  candidate: null,
};

export type FlightEvent =
  | { type: 'takeoff'; ts: number; pos: Position }
  | {
      type: 'landing';
      ts: number;
      pos: Position;
      presumed: boolean;
      takeoffTs: number | null;
      takeoffPos: Position | null;
    }
  | { type: 'abandoned'; ts: number }; // stale flight closed out — never posted

export interface MachineConfig {
  debounceReadings: number;
  signalLossLandingAltFt: number;
  signalLossConfirmMs: number;
  takeoffClimbFpm: number;
  takeoffDetectionCeilingAglFt: number;
  staleFlightTimeoutMs: number;
}
```

- [ ] **Step 2: Write the failing test `test/geo.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { haversineKm } from '../src/core/geo.js';

describe('haversineKm', () => {
  it('Lisbon to Madrid is ~503 km', () => {
    const d = haversineKm({ lat: 38.7813, lon: -9.1359 }, { lat: 40.4722, lon: -3.5608 });
    expect(d).toBeGreaterThan(490);
    expect(d).toBeLessThan(520);
  });

  it('zero distance for identical points', () => {
    expect(haversineKm({ lat: 38.78, lon: -9.13 }, { lat: 38.78, lon: -9.13 })).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/geo.test.ts`
Expected: FAIL — cannot find module `../src/core/geo.js`

- [ ] **Step 4: Write `src/core/geo.ts`**

```ts
import type { Position } from './types.js';

export function haversineKm(a: Position, b: Position): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/geo.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/geo.ts test/geo.test.ts
git commit -m "feat: core types and haversine distance"
```

---

### Task 3: State machine — takeoff, landing, debounce

**Files:**
- Create: `src/core/stateMachine.ts`
- Test: `test/stateMachine.test.ts`

**Interfaces:**
- Consumes: everything from `src/core/types.ts`
- Produces: `transition(s: TrackerState, obs: Observation, cfg: MachineConfig): { state: TrackerState; events: FlightEvent[] }` — the ONLY export; Tasks 4 and 9 depend on this exact signature.

Behavior contract (from spec):
- 2 consecutive consistent readings commit a phase change; a reading matching the committed phase resets the candidate; event timestamps use the FIRST candidate reading.
- Takeoff event requires climbing (vertical rate > `takeoffClimbFpm` on either debounce reading, OR altitude increased between them) AND first reading below `takeoffDetectionCeilingAglFt` AGL. Otherwise: mid-flight adoption (`flight.takeoffTs = null`, no event).
- Takeoff position prefers the last known ground position (the actual airport) over the first airborne fix.
- Landing event: 2 ground readings while airborne (or signal_lost); ts/pos from the first ground reading; carries `takeoffTs`/`takeoffPos` for duration math.

- [ ] **Step 1: Write the failing tests `test/stateMachine.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { transition } from '../src/core/stateMachine.js';
import {
  initialState,
  type AbsentObs,
  type FlightEvent,
  type MachineConfig,
  type Observation,
  type SignalObs,
  type TrackerState,
} from '../src/core/types.js';

const cfg: MachineConfig = {
  debounceReadings: 2,
  signalLossLandingAltFt: 3_000,
  signalLossConfirmMs: 300_000,
  takeoffClimbFpm: 300,
  takeoffDetectionCeilingAglFt: 8_000,
  staleFlightTimeoutMs: 64_800_000,
};

const sig = (ts: number, altFt: number | 'ground', over: Partial<SignalObs> = {}): SignalObs => ({
  kind: 'signal',
  ts,
  lat: 38.77,
  lon: -9.13,
  altFt,
  aglFt: altFt === 'ground' ? null : (altFt as number) - 300,
  verticalRateFpm: null,
  ...over,
});

const absent = (ts: number): AbsentObs => ({ kind: 'absent', ts });

function feed(state: TrackerState, observations: Observation[]): { state: TrackerState; events: FlightEvent[] } {
  const events: FlightEvent[] = [];
  for (const o of observations) {
    const r = transition(state, o, cfg);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

// A committed grounded state to start flight scenarios from.
const grounded = (): TrackerState => feed(initialState, [sig(0, 'ground'), sig(30_000, 'ground')]).state;

describe('grounding from unknown', () => {
  it('commits grounded after 2 ground readings, no events', () => {
    const { state, events } = feed(initialState, [sig(0, 'ground'), sig(30_000, 'ground')]);
    expect(state.phase).toBe('grounded');
    expect(events).toEqual([]);
  });

  it('does not commit after a single reading', () => {
    const { state } = feed(initialState, [sig(0, 'ground')]);
    expect(state.phase).toBe('unknown');
  });
});

describe('takeoff', () => {
  it('emits takeoff after 2 climbing airborne readings, ts from first reading, pos from last ground fix', () => {
    const { state, events } = feed(grounded(), [
      sig(60_000, 800, { verticalRateFpm: 2000, lat: 38.8, lon: -9.1 }),
      sig(90_000, 1600, { verticalRateFpm: 2000, lat: 38.82, lon: -9.05 }),
    ]);
    expect(state.phase).toBe('airborne');
    expect(events).toEqual([{ type: 'takeoff', ts: 60_000, pos: { lat: 38.77, lon: -9.13 } }]);
    expect(state.flight).toEqual({ takeoffTs: 60_000, takeoffPos: { lat: 38.77, lon: -9.13 } });
  });

  it('detects climbing from altitude increase when vertical rate is missing', () => {
    const { events } = feed(grounded(), [sig(60_000, 800), sig(90_000, 1600)]);
    expect(events.map((e) => e.type)).toEqual(['takeoff']);
  });

  it('takeoff from cold start (never seen on ground): climbing + low = takeoff at first fix', () => {
    const { events } = feed(initialState, [
      sig(0, 1000, { verticalRateFpm: 2500, lat: 40.0, lon: -8.0 }),
      sig(30_000, 2000, { verticalRateFpm: 2500, lat: 40.02, lon: -8.0 }),
    ]);
    expect(events).toEqual([{ type: 'takeoff', ts: 0, pos: { lat: 40.0, lon: -8.0 } }]);
  });
});

describe('landing', () => {
  const airborne = (): TrackerState =>
    feed(grounded(), [
      sig(60_000, 800, { verticalRateFpm: 2000 }),
      sig(90_000, 1600, { verticalRateFpm: 2000 }),
    ]).state;

  it('emits landing after 2 ground readings with takeoff linkage', () => {
    const { state, events } = feed(airborne(), [
      sig(16_000_000, 'ground', { lat: 24.95, lon: 46.7 }),
      sig(16_030_000, 'ground', { lat: 24.95, lon: 46.7 }),
    ]);
    expect(state.phase).toBe('grounded');
    expect(state.flight).toBeNull();
    expect(events).toEqual([
      {
        type: 'landing',
        ts: 16_000_000,
        pos: { lat: 24.95, lon: 46.7 },
        presumed: false,
        takeoffTs: 60_000,
        takeoffPos: { lat: 38.77, lon: -9.13 },
      },
    ]);
  });
});

describe('debounce', () => {
  it('single spurious ground reading mid-flight causes no transition', () => {
    const airborne = feed(initialState, [sig(0, 38_000), sig(30_000, 38_000)]).state;
    const { state, events } = feed(airborne, [sig(60_000, 'ground'), sig(90_000, 37_000)]);
    expect(state.phase).toBe('airborne');
    expect(events).toEqual([]);
  });

  it('alternating readings never transition', () => {
    const airborne = feed(initialState, [sig(0, 38_000), sig(30_000, 38_000)]).state;
    const { state, events } = feed(airborne, [
      sig(60_000, 'ground'),
      sig(90_000, 37_000),
      sig(120_000, 'ground'),
      sig(150_000, 37_000),
    ]);
    expect(state.phase).toBe('airborne');
    expect(events).toEqual([]);
  });

  it('single airborne blip while grounded causes no takeoff', () => {
    const { state, events } = feed(grounded(), [sig(60_000, 500, { verticalRateFpm: 1000 }), sig(90_000, 'ground')]);
    expect(state.phase).toBe('grounded');
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/stateMachine.test.ts`
Expected: FAIL — cannot find module `../src/core/stateMachine.js`

- [ ] **Step 3: Write `src/core/stateMachine.ts`**

```ts
import {
  initialState,
  type FlightEvent,
  type MachineConfig,
  type Observation,
  type Position,
  type SignalObs,
  type TrackerState,
} from './types.js';

export interface Result {
  state: TrackerState;
  events: FlightEvent[];
}

// Pure: no clocks, no I/O. Time arrives on the observation.
export function transition(s: TrackerState, obs: Observation, cfg: MachineConfig): Result {
  return obs.kind === 'absent' ? onAbsent(s, obs.ts, cfg) : onSignal(s, obs, cfg);
}

function onAbsent(s: TrackerState, ts: number, cfg: MachineConfig): Result {
  if (s.phase === 'airborne') {
    // internal only — a coverage gap is not an event
    return { state: { ...s, phase: 'signal_lost', lostSinceTs: ts, candidate: null }, events: [] };
  }
  if (s.phase === 'signal_lost' && s.lostSinceTs !== null) {
    const silentMs = ts - s.lostSinceTs;
    const last = s.lastSignal;
    if (
      last &&
      last.aglFt !== null &&
      last.aglFt < cfg.signalLossLandingAltFt &&
      silentMs >= cfg.signalLossConfirmMs
    ) {
      // blocked jets drop off ADS-B near the ground: presume landed where last seen
      return {
        state: { ...initialState, phase: 'grounded', lastSignal: last },
        events: [landing(s, s.lostSinceTs, last, true)],
      };
    }
    if (silentMs >= cfg.staleFlightTimeoutMs) {
      return { state: { ...initialState }, events: [{ type: 'abandoned', ts }] };
    }
    return { state: { ...s, candidate: null }, events: [] };
  }
  // unknown / grounded: absence is normal (parked, out of coverage); it only breaks debounce runs
  return { state: { ...s, candidate: null }, events: [] };
}

function onSignal(s: TrackerState, obs: SignalObs, cfg: MachineConfig): Result {
  const obsPhase = obs.altFt === 'ground' ? 'grounded' : 'airborne';
  // reacquiring after signal loss is not a phase change
  const committed = s.phase === 'signal_lost' ? 'airborne' : s.phase;

  if (obsPhase === committed) {
    return {
      state: { ...s, phase: obsPhase, lastSignal: obs, lostSinceTs: null, candidate: null },
      events: [],
    };
  }

  const cand =
    s.candidate && s.candidate.phase === obsPhase
      ? { ...s.candidate, count: s.candidate.count + 1 }
      : { phase: obsPhase, count: 1, firstObs: obs };

  if (cand.count < cfg.debounceReadings) {
    return { state: { ...s, candidate: cand, lastSignal: obs }, events: [] };
  }

  // commit the phase change; event timestamps use the first candidate reading
  const first = cand.firstObs;

  if (obsPhase === 'airborne') {
    const climbing =
      (first.verticalRateFpm ?? 0) > cfg.takeoffClimbFpm ||
      (obs.verticalRateFpm ?? 0) > cfg.takeoffClimbFpm ||
      (typeof first.altFt === 'number' && typeof obs.altFt === 'number' && obs.altFt > first.altFt);
    const lowEnough = first.aglFt !== null && first.aglFt < cfg.takeoffDetectionCeilingAglFt;
    const isTakeoff = climbing && lowEnough;
    // prefer the last known ground fix (the actual airport) over the first airborne fix
    const pos: Position =
      s.phase === 'grounded' && s.lastSignal
        ? { lat: s.lastSignal.lat, lon: s.lastSignal.lon }
        : { lat: first.lat, lon: first.lon };
    return {
      state: {
        phase: 'airborne',
        flight: isTakeoff ? { takeoffTs: first.ts, takeoffPos: pos } : { takeoffTs: null, takeoffPos: null },
        lastSignal: obs,
        lostSinceTs: null,
        candidate: null,
      },
      events: isTakeoff ? [{ type: 'takeoff', ts: first.ts, pos }] : [],
    };
  }

  // committing to grounded
  const events: FlightEvent[] = committed === 'airborne' ? [landing(s, first.ts, first, false)] : [];
  return { state: { ...initialState, phase: 'grounded', lastSignal: obs }, events };
}

function landing(s: TrackerState, ts: number, at: SignalObs, presumed: boolean): FlightEvent {
  return {
    type: 'landing',
    ts,
    pos: { lat: at.lat, lon: at.lon },
    presumed,
    takeoffTs: s.flight?.takeoffTs ?? null,
    takeoffPos: s.flight?.takeoffPos ?? null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/stateMachine.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/stateMachine.ts test/stateMachine.test.ts
git commit -m "feat: state machine — takeoff, landing, debounce"
```

---

### Task 4: State machine — signal loss, presumed landing, stale flight, adoption

**Files:**
- Modify: `test/stateMachine.test.ts` (append; the implementation from Task 3 already covers these paths — these tests prove it)

**Interfaces:**
- Consumes: `transition`, helpers (`sig`, `absent`, `feed`, `cfg`, `grounded`) already defined in the test file
- Produces: verified behavior contract for Tasks 9's shell wiring

- [ ] **Step 1: Append these tests to `test/stateMachine.test.ts`**

```ts
describe('signal loss', () => {
  const airborneLow = (): TrackerState =>
    feed(grounded(), [
      sig(60_000, 800, { verticalRateFpm: 2000 }),
      sig(90_000, 1600, { verticalRateFpm: 2000 }),
      sig(120_000, 1200, { verticalRateFpm: -800, lat: 38.9, lon: -9.0 }), // descending, agl 900
    ]).state;

  it('going absent while airborne emits nothing (internal signal_lost)', () => {
    const r = transition(airborneLow(), absent(150_000), cfg);
    expect(r.state.phase).toBe('signal_lost');
    expect(r.events).toEqual([]);
  });

  it('presumed landing: last seen below 3000 ft AGL + 5 min silence', () => {
    let s = transition(airborneLow(), absent(150_000), cfg).state; // lostSince = 150_000
    const r = transition(s, absent(150_000 + 300_000), cfg);
    expect(r.state.phase).toBe('grounded');
    expect(r.events).toEqual([
      {
        type: 'landing',
        ts: 150_000,
        pos: { lat: 38.9, lon: -9.0 },
        presumed: true,
        takeoffTs: 60_000,
        takeoffPos: { lat: 38.77, lon: -9.13 },
      },
    ]);
  });

  it('no presumed landing if reacquired before 5 min', () => {
    let s = transition(airborneLow(), absent(150_000), cfg).state;
    s = transition(s, absent(300_000), cfg).state; // 2.5 min silent — under threshold
    const r = transition(s, sig(330_000, 1500), cfg);
    expect(r.state.phase).toBe('airborne');
    expect(r.events).toEqual([]);
  });

  it('high-altitude loss never presumes a landing', () => {
    const cruise = feed(initialState, [sig(0, 38_000), sig(30_000, 38_000)]).state;
    let s = transition(cruise, absent(60_000), cfg).state;
    const r = transition(s, absent(60_000 + 600_000), cfg); // 10 min silent
    expect(r.state.phase).toBe('signal_lost');
    expect(r.events).toEqual([]);
  });

  it('stale flight: 18 h silence resets to unknown with abandoned event, no landing', () => {
    const cruise = feed(initialState, [sig(0, 38_000), sig(30_000, 38_000)]).state;
    let s = transition(cruise, absent(60_000), cfg).state;
    const r = transition(s, absent(60_000 + cfg.staleFlightTimeoutMs), cfg);
    expect(r.state).toEqual(initialState);
    expect(r.events).toEqual([{ type: 'abandoned', ts: 60_000 + cfg.staleFlightTimeoutMs }]);
  });
});

describe('mid-flight adoption', () => {
  it('first seen at cruise: airborne with no takeoff event', () => {
    const { state, events } = feed(initialState, [sig(0, 38_000), sig(30_000, 38_000)]);
    expect(state.phase).toBe('airborne');
    expect(state.flight).toEqual({ takeoffTs: null, takeoffPos: null });
    expect(events).toEqual([]);
  });

  it('landing after adoption carries null takeoff info (post will omit duration/fuel)', () => {
    const adopted = feed(initialState, [sig(0, 38_000), sig(30_000, 38_000)]).state;
    const { events } = feed(adopted, [sig(60_000, 'ground'), sig(90_000, 'ground')]);
    expect(events).toEqual([
      { type: 'landing', ts: 60_000, pos: { lat: 38.77, lon: -9.13 }, presumed: false, takeoffTs: null, takeoffPos: null },
    ]);
  });
});

describe('absence and debounce interaction', () => {
  it('absence between candidate readings breaks the consecutive run', () => {
    const { state, events } = feed(grounded(), [
      sig(60_000, 800, { verticalRateFpm: 2000 }),
      absent(90_000),
      sig(120_000, 1600, { verticalRateFpm: 2000 }),
    ]);
    expect(state.phase).toBe('grounded'); // restarted candidate: only 1 consecutive airborne reading
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the full state machine suite**

Run: `npx vitest run test/stateMachine.test.ts`
Expected: PASS (16 tests). If any fail, the bug is in `src/core/stateMachine.ts` — fix it there; the tests encode the approved spec.

- [ ] **Step 3: Commit**

```bash
git add test/stateMachine.test.ts
git commit -m "test: signal-loss landing, stale flight, adoption, absence-debounce"
```

---

### Task 5: ADS-B client

**Files:**
- Create: `src/adsb/client.ts`
- Test: `test/client.test.ts`, `test/fixtures/airborne.json`, `test/fixtures/ground.json`, `test/fixtures/empty.json`

**Interfaces:**
- Consumes: `Observation` types, `config`, `logger`
- Produces:
  - `normalize(json: unknown, now: number): Observation | null` — null means "no usable aircraft data in this response" (caller falls through to the next source)
  - `fetchObservation(now: number): Promise<Observation>` — throws only when ALL sources fail; Task 9 treats that throw as a skipped cycle (backoff), never as absence

- [ ] **Step 1: Write fixtures (recorded airplanes.live `/v2/hex` response shapes)**

`test/fixtures/airborne.json`:

```json
{
  "ac": [
    {
      "hex": "4d0226",
      "type": "adsb_icao",
      "flight": "LXGOL   ",
      "alt_baro": 4200,
      "alt_geom": 4400,
      "gs": 210.5,
      "baro_rate": 1800,
      "lat": 38.812345,
      "lon": -9.101234,
      "seen": 0.2,
      "seen_pos": 0.3
    }
  ],
  "total": 1,
  "now": 1720000000000
}
```

`test/fixtures/ground.json`:

```json
{
  "ac": [
    {
      "hex": "4d0226",
      "type": "adsb_icao",
      "alt_baro": "ground",
      "gs": 8.2,
      "lat": 38.7742,
      "lon": -9.1342,
      "seen": 1.1,
      "seen_pos": 1.5
    }
  ],
  "total": 1,
  "now": 1720000000000
}
```

`test/fixtures/empty.json`:

```json
{ "ac": [], "total": 0, "now": 1720000000000 }
```

- [ ] **Step 2: Write the failing test `test/client.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/adsb/client.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('normalize', () => {
  it('airborne: prefers geometric altitude, carries vertical rate', () => {
    expect(normalize(fixture('airborne'), 1000)).toEqual({
      kind: 'signal',
      ts: 1000,
      lat: 38.812345,
      lon: -9.101234,
      altFt: 4400,
      aglFt: null,
      verticalRateFpm: 1800,
    });
  });

  it('on ground: altFt is "ground"', () => {
    const obs = normalize(fixture('ground'), 1000);
    expect(obs).toMatchObject({ kind: 'signal', altFt: 'ground', aglFt: null });
  });

  it('empty response: null (caller treats as no-data, tries fallback)', () => {
    expect(normalize(fixture('empty'), 1000)).toBeNull();
  });

  it('aircraft without position: null', () => {
    expect(normalize({ ac: [{ hex: '4d0226', alt_baro: 4200 }] }, 1000)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL — cannot find module `../src/adsb/client.js`

- [ ] **Step 4: Write `src/adsb/client.ts`**

```ts
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Observation } from '../core/types.js';

// Normalize one aggregator response (readsb /v2/hex shape) to an Observation.
// Returns null when the response holds no usable aircraft data.
export function normalize(json: unknown, now: number): Observation | null {
  const ac = (json as { ac?: Record<string, unknown>[] }).ac?.[0];
  if (!ac || typeof ac.lat !== 'number' || typeof ac.lon !== 'number') return null;
  if (ac.alt_baro === 'ground') {
    return { kind: 'signal', ts: now, lat: ac.lat, lon: ac.lon, altFt: 'ground', aglFt: null, verticalRateFpm: null };
  }
  const alt =
    typeof ac.alt_geom === 'number' ? ac.alt_geom : typeof ac.alt_baro === 'number' ? ac.alt_baro : null;
  if (alt === null) return null; // ponytail: a fix without altitude can't drive transitions — treat as no-data
  const vr =
    typeof ac.baro_rate === 'number' ? ac.baro_rate : typeof ac.geom_rate === 'number' ? ac.geom_rate : null;
  return { kind: 'signal', ts: now, lat: ac.lat, lon: ac.lon, altFt: alt, aglFt: null, verticalRateFpm: vr };
}

// Primary, then fallback (also when the primary answers but has no data, per spec).
// Throws only when no source answered at all — the caller backs off; the state
// machine never sees an API failure.
export async function fetchObservation(now: number): Promise<Observation> {
  let gotResponse = false;
  for (const base of [config.primaryApiUrl, config.fallbackApiUrl]) {
    try {
      const res = await fetch(base + config.aircraftHex, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      gotResponse = true;
      const obs = normalize(await res.json(), now);
      if (obs) return obs;
    } catch (err) {
      logger.warn({ err: String(err), base }, 'ADS-B source failed');
    }
  }
  if (gotResponse) return { kind: 'absent', ts: now }; // aircraft genuinely not visible — normal
  throw new Error('all ADS-B sources failed');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/client.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/adsb/client.ts test/client.test.ts test/fixtures
git commit -m "feat: ADS-B client with fallback and fixture-tested normalization"
```

---

### Task 6: Airports dataset + resolution

**Files:**
- Create: `src/airports/airports.ts`, `data/airports.csv` (vendored download)
- Test: `test/airports.test.ts`

**Interfaces:**
- Consumes: `haversineKm`, `Position`, `config.nearAirportKm`
- Produces (Task 9 depends on these exact signatures):
  - `loadAirports(csvPath: string): number` — parses the CSV into module state, returns row count
  - `elevationFtAt(pos: Position): number` — nearest airport's elevation (0 if none)
  - `resolvePlace(pos: Position, presumed: boolean): string` — post-ready place string:
    - medium/large airport within 10 km → `"Humberto Delgado Airport (LIS), Portugal"`
    - presumed landing beyond 10 km → `"near Humberto Delgado Airport (LIS), Portugal"`
    - otherwise → nearest municipality from the dataset → `"Cascais, Portugal"`

- [ ] **Step 1: Download the vendored dataset**

Run: `mkdir -p data && npm run update-airports && wc -l data/airports.csv`
Expected: file downloads (~13 MB); ~80 000 lines.

- [ ] **Step 2: Write the failing test `test/airports.test.ts`**

Uses a mini CSV (same header as OurAirports) written to a temp file — including a quoted comma and quoted field to prove the parser.

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { elevationFtAt, loadAirports, resolvePlace } from '../src/airports/airports.js';

const CSV = `"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","gps_code","iata_code","local_code","home_link","wikipedia_link","keywords"
2434,"LPPT","large_airport","Humberto Delgado Airport",38.7813,-9.13592,374,"EU","PT","PT-11","Lisbon","yes","LPPT","LIS",,,,"Lisboa, Portela"
333,"LPCS","small_airport","Cascais Airport",38.725,-9.35523,325,"EU","PT","PT-11","Cascais","yes","LPCS",,,,,
9999,"XXCL","closed","Old Field",38.70,-9.20,100,"EU","PT","PT-11","Nowhere","no",,,,,,
`;

beforeAll(() => {
  const path = join(mkdtempSync(join(tmpdir(), 'airports-')), 'airports.csv');
  writeFileSync(path, CSV);
  expect(loadAirports(path)).toBe(2); // closed airport excluded; quoted comma didn't break parsing
});

describe('resolvePlace', () => {
  it('medium/large airport within 10 km', () => {
    expect(resolvePlace({ lat: 38.78, lon: -9.135 }, false)).toBe(
      'Humberto Delgado Airport (LIS), Portugal',
    );
  });

  it('presumed landing beyond 10 km says "near"', () => {
    expect(resolvePlace({ lat: 39.5, lon: -8.0 }, true)).toBe(
      'near Humberto Delgado Airport (LIS), Portugal',
    );
  });

  it('no big airport within 10 km falls back to nearest municipality', () => {
    expect(resolvePlace({ lat: 38.72, lon: -9.36 }, false)).toBe('Cascais, Portugal');
  });
});

describe('elevationFtAt', () => {
  it('returns nearest airport elevation', () => {
    expect(elevationFtAt({ lat: 38.78, lon: -9.135 })).toBe(374);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/airports.test.ts`
Expected: FAIL — cannot find module `../src/airports/airports.js`

- [ ] **Step 4: Write `src/airports/airports.ts`**

```ts
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { haversineKm } from '../core/geo.js';
import type { Position } from '../core/types.js';

export interface Airport {
  ident: string;
  type: string;
  name: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
  country: string; // ISO 3166-1 alpha-2
  municipality: string | null;
  iata: string | null;
}

let airports: Airport[] = [];

export function loadAirports(csvPath: string): number {
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  const header = rows[0] ?? [];
  const c = (name: string): number => header.indexOf(name);
  const [cIdent, cType, cName, cLat, cLon, cElev, cCountry, cMuni, cIata] = [
    'ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'elevation_ft', 'iso_country', 'municipality', 'iata_code',
  ].map(c);
  airports = [];
  for (const f of rows.slice(1)) {
    if (f.length < header.length) continue;
    const lat = Number(f[cLat]);
    const lon = Number(f[cLon]);
    const type = f[cType] ?? '';
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || type === 'closed') continue;
    airports.push({
      ident: f[cIdent] ?? '',
      type,
      name: f[cName] ?? '',
      lat,
      lon,
      elevationFt: f[cElev] ? Number(f[cElev]) : null,
      country: f[cCountry] ?? '',
      municipality: f[cMuni] || null,
      iata: f[cIata] || null,
    });
  }
  return airports.length;
}

// Minimal RFC-4180 parser: quoted fields may contain commas, escaped quotes, and newlines.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

// ponytail: linear scan of ~80k rows per lookup (a few ms). Spatial index if this ever matters.
function nearest(pos: Position, filter: (a: Airport) => boolean): { airport: Airport; distKm: number } | null {
  let best: Airport | null = null;
  let bestD = Infinity;
  for (const a of airports) {
    if (!filter(a)) continue;
    const d = haversineKm(pos, a);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best ? { airport: best, distKm: bestD } : null;
}

export function elevationFtAt(pos: Position): number {
  return nearest(pos, (a) => a.elevationFt !== null)?.airport.elevationFt ?? 0;
}

const countryName = (code: string): string =>
  new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;

export function resolvePlace(pos: Position, presumed: boolean): string {
  const big = nearest(pos, (a) => a.type === 'large_airport' || a.type === 'medium_airport');
  if (big && big.distKm <= config.nearAirportKm) {
    return `${big.airport.name} (${big.airport.iata ?? big.airport.ident}), ${countryName(big.airport.country)}`;
  }
  if (presumed && big) {
    return `near ${big.airport.name} (${big.airport.iata ?? big.airport.ident}), ${countryName(big.airport.country)}`;
  }
  const any = nearest(pos, (a) => a.municipality !== null);
  if (any) return `${any.airport.municipality}, ${countryName(any.airport.country)}`;
  return `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/airports.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit** (the CSV is vendored deliberately — reproducible offline builds)

```bash
git add src/airports/airports.ts test/airports.test.ts data/airports.csv
git commit -m "feat: airports dataset (vendored OurAirports) and place resolution"
```

---

### Task 7: SQLite store

**Files:**
- Create: `src/store/db.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `TrackerState`, `initialState`
- Produces (Task 9 depends on these exact signatures):
  - `class Store { constructor(path: string) }`
  - `loadState(): TrackerState` — `initialState` on first run
  - `saveCycle(state: TrackerState, fn?: () => void): void` — state upsert + everything `fn` writes, one transaction
  - `openFlight(p: { takeoffTs: number; lat: number; lon: number; place: string }): void`
  - `closeFlight(p: { landingTs: number; lat: number; lon: number; place: string; durationS: number | null; presumed: boolean }): void`
  - `abandonOpenFlights(): void`
  - `addPost(p: NewPost): number` (`NewPost { type: 'takeoff' | 'landing'; text: string; lat: number; lon: number; createdTs: number }`)
  - `pendingPosts(): PostRow[]` (`PostRow { id, type, text, lat, lon, created_ts, status, uri }`)
  - `markPost(id: number, status: 'posted' | 'skipped' | 'dry_run', uri?: string): void`
  - `flights(): FlightRow[]`, `close(): void`

- [ ] **Step 1: Write the failing test `test/store.test.ts`**

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialState } from '../src/core/types.js';
import { Store } from '../src/store/db.js';

const freshStore = (): Store => new Store(join(mkdtempSync(join(tmpdir(), 'store-')), 'test.db'));

describe('Store', () => {
  it('loadState returns initialState on first run', () => {
    expect(freshStore().loadState()).toEqual(initialState);
  });

  it('saveCycle round-trips state', () => {
    const store = freshStore();
    const state = { ...initialState, phase: 'grounded' as const };
    store.saveCycle(state);
    expect(store.loadState()).toEqual(state);
  });

  it('post lifecycle: pending → posted', () => {
    const store = freshStore();
    let id = 0;
    store.saveCycle(initialState, () => {
      id = store.addPost({ type: 'takeoff', text: '🛫 test', lat: 1, lon: 2, createdTs: 123 });
    });
    expect(store.pendingPosts()).toHaveLength(1);
    store.markPost(id, 'posted', 'at://post/1');
    expect(store.pendingPosts()).toHaveLength(0);
  });

  it('flight lifecycle: open → closed with duration', () => {
    const store = freshStore();
    store.openFlight({ takeoffTs: 1000, lat: 38.77, lon: -9.13, place: 'LIS' });
    store.closeFlight({ landingTs: 16_381_000, lat: 24.95, lon: 46.7, place: 'RUH', durationS: 16_380, presumed: false });
    const flights = store.flights();
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ status: 'closed', duration_s: 16_380, takeoff_place: 'LIS', landing_place: 'RUH' });
  });

  it('closeFlight with no open flight records a closed landing-only row (mid-flight adoption)', () => {
    const store = freshStore();
    store.closeFlight({ landingTs: 5000, lat: 24.95, lon: 46.7, place: 'RUH', durationS: null, presumed: false });
    expect(store.flights()[0]).toMatchObject({ status: 'closed', takeoff_ts: null, duration_s: null });
  });

  it('abandonOpenFlights marks open flights abandoned', () => {
    const store = freshStore();
    store.openFlight({ takeoffTs: 1000, lat: 38.77, lon: -9.13, place: 'LIS' });
    store.abandonOpenFlights();
    expect(store.flights()[0]).toMatchObject({ status: 'abandoned' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — cannot find module `../src/store/db.js`

- [ ] **Step 3: Write `src/store/db.ts`**

```ts
import Database from 'better-sqlite3';
import { initialState, type TrackerState } from '../core/types.js';

export interface NewPost {
  type: 'takeoff' | 'landing';
  text: string;
  lat: number;
  lon: number;
  createdTs: number;
}

export interface PostRow {
  id: number;
  type: string;
  text: string;
  lat: number;
  lon: number;
  created_ts: number;
  status: string;
  uri: string | null;
}

export interface FlightRow {
  id: number;
  takeoff_ts: number | null;
  takeoff_place: string | null;
  landing_ts: number | null;
  landing_place: string | null;
  duration_s: number | null;
  presumed_landing: number;
  status: string;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracker_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        takeoff_ts INTEGER, takeoff_lat REAL, takeoff_lon REAL, takeoff_place TEXT,
        landing_ts INTEGER, landing_lat REAL, landing_lon REAL, landing_place TEXT,
        duration_s INTEGER,
        presumed_landing INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open'
      );
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        created_ts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        uri TEXT
      );
    `);
  }

  loadState(): TrackerState {
    const row = this.db.prepare('SELECT json FROM tracker_state WHERE id = 1').get() as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as TrackerState) : initialState;
  }

  /** Persist state and, atomically with it, any flight/post writes done in fn. */
  saveCycle(state: TrackerState, fn?: () => void): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tracker_state (id, json, updated_ts) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_ts = excluded.updated_ts`,
        )
        .run(JSON.stringify(state), Date.now());
      fn?.();
    })();
  }

  openFlight(p: { takeoffTs: number; lat: number; lon: number; place: string }): void {
    this.db
      .prepare('INSERT INTO flights (takeoff_ts, takeoff_lat, takeoff_lon, takeoff_place) VALUES (?, ?, ?, ?)')
      .run(p.takeoffTs, p.lat, p.lon, p.place);
  }

  closeFlight(p: {
    landingTs: number;
    lat: number;
    lon: number;
    place: string;
    durationS: number | null;
    presumed: boolean;
  }): void {
    const open = this.db
      .prepare("SELECT id FROM flights WHERE status = 'open' ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    if (open) {
      this.db
        .prepare(
          `UPDATE flights SET landing_ts = ?, landing_lat = ?, landing_lon = ?, landing_place = ?,
           duration_s = ?, presumed_landing = ?, status = 'closed' WHERE id = ?`,
        )
        .run(p.landingTs, p.lat, p.lon, p.place, p.durationS, p.presumed ? 1 : 0, open.id);
    } else {
      // mid-flight adoption: no takeoff row exists, record the landing on its own
      this.db
        .prepare(
          `INSERT INTO flights (landing_ts, landing_lat, landing_lon, landing_place, duration_s, presumed_landing, status)
           VALUES (?, ?, ?, ?, ?, ?, 'closed')`,
        )
        .run(p.landingTs, p.lat, p.lon, p.place, p.durationS, p.presumed ? 1 : 0);
    }
  }

  abandonOpenFlights(): void {
    this.db.prepare("UPDATE flights SET status = 'abandoned' WHERE status = 'open'").run();
  }

  addPost(p: NewPost): number {
    const r = this.db
      .prepare('INSERT INTO posts (type, text, lat, lon, created_ts) VALUES (?, ?, ?, ?, ?)')
      .run(p.type, p.text, p.lat, p.lon, p.createdTs);
    return Number(r.lastInsertRowid);
  }

  pendingPosts(): PostRow[] {
    return this.db.prepare("SELECT * FROM posts WHERE status = 'pending' ORDER BY id").all() as PostRow[];
  }

  markPost(id: number, status: 'posted' | 'skipped' | 'dry_run', uri?: string): void {
    this.db.prepare('UPDATE posts SET status = ?, uri = ? WHERE id = ?').run(status, uri ?? null, id);
  }

  flights(): FlightRow[] {
    return this.db.prepare('SELECT * FROM flights ORDER BY id').all() as FlightRow[];
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/store.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts test/store.test.ts
git commit -m "feat: SQLite store — state snapshot, flights, idempotent post ledger"
```

---

### Task 8: Bluesky messages, map render, poster

**Files:**
- Create: `src/bluesky/messages.ts`, `src/bluesky/poster.ts`, `src/map/staticMap.ts`
- Test: `test/messages.test.ts` (poster and map are thin network I/O — no unit tests)

**Interfaces:**
- Consumes: `config.fuelBurnKgPerHour`, `config.map`
- Produces (Task 9 depends on these exact signatures):
  - `takeoffText(place: string, ts: number): string`
  - `landingText(place: string, ts: number, durationMs: number | null): string`
  - `renderMap(lat: number, lon: number): Promise<Buffer>`
  - `class Poster { static login(handle: string, appPassword: string): Promise<Poster>; post(text: string, image: Buffer | null, alt: string): Promise<string> }` — returns the post URI

- [ ] **Step 1: Write the failing test `test/messages.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { landingText, takeoffText } from '../src/bluesky/messages.js';

// 2026-07-09 14:32:00 UTC
const TS = Date.UTC(2026, 6, 9, 14, 32, 0);

describe('messages', () => {
  it('takeoff', () => {
    expect(takeoffText('Humberto Delgado Airport (LIS), Portugal', TS)).toBe(
      '🛫 Took off from Humberto Delgado Airport (LIS), Portugal at 14:32 UTC',
    );
  });

  it('landing with duration and fuel (4h33m × 1900 kg/h ≈ 8,645 kg)', () => {
    const landTs = Date.UTC(2026, 6, 9, 19, 5, 0);
    const durationMs = (4 * 60 + 33) * 60_000;
    expect(landingText('King Khalid International Airport (RUH), Saudi Arabia', landTs, durationMs)).toBe(
      '🛬 Landed at King Khalid International Airport (RUH), Saudi Arabia at 19:05 UTC. Flight time: 4h 33m. Est. fuel burn: ~8,645 kg',
    );
  });

  it('landing without observed takeoff omits duration and fuel', () => {
    const landTs = Date.UTC(2026, 6, 9, 19, 5, 0);
    expect(landingText('King Khalid International Airport (RUH), Saudi Arabia', landTs, null)).toBe(
      '🛬 Landed at King Khalid International Airport (RUH), Saudi Arabia at 19:05 UTC',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/messages.test.ts`
Expected: FAIL — cannot find module `../src/bluesky/messages.js`

- [ ] **Step 3: Write `src/bluesky/messages.ts`**

```ts
import { config } from '../config.js';

const hhmm = (ts: number): string => new Date(ts).toISOString().slice(11, 16);

export function takeoffText(place: string, ts: number): string {
  return `🛫 Took off from ${place} at ${hhmm(ts)} UTC`;
}

export function landingText(place: string, ts: number, durationMs: number | null): string {
  let text = `🛬 Landed at ${place} at ${hhmm(ts)} UTC`;
  if (durationMs !== null) {
    const mins = Math.round(durationMs / 60_000);
    const fuelKg = Math.round((durationMs / 3_600_000) * config.fuelBurnKgPerHour);
    text += `. Flight time: ${Math.floor(mins / 60)}h ${mins % 60}m. Est. fuel burn: ~${fuelKg.toLocaleString('en-US')} kg`;
  }
  return text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/messages.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write `src/map/staticMap.ts`**

```ts
import StaticMaps from 'staticmaps';
import { config } from '../config.js';

export async function renderMap(lat: number, lon: number): Promise<Buffer> {
  const map = new StaticMaps({
    width: config.map.width,
    height: config.map.height,
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileRequestHeader: { 'User-Agent': 'cr7jet-tracker/1.0 (github.com/antoniogoulao)' }, // OSM tile policy
  });
  // ponytail: circle instead of a marker icon — no image asset to bundle
  map.addCircle({ coord: [lon, lat], radius: 900, color: '#c1121f', fill: '#c1121fbb', width: 3 });
  await map.render([lon, lat], config.map.zoom);
  return map.image.buffer('image/png');
}
```

If `npx tsc` fails here with TS7016 (no type declarations for `staticmaps`), create `src/types/staticmaps.d.ts` with exactly:

```ts
declare module 'staticmaps' {
  interface StaticMapsOptions {
    width: number;
    height: number;
    tileUrl?: string;
    tileRequestHeader?: Record<string, string>;
  }
  interface CircleOptions {
    coord: [number, number];
    radius: number;
    color?: string;
    fill?: string;
    width?: number;
  }
  export default class StaticMaps {
    constructor(options: StaticMapsOptions);
    image: { buffer(mime: string): Promise<Buffer> };
    addCircle(circle: CircleOptions): void;
    render(center?: [number, number], zoom?: number): Promise<void>;
  }
}
```

- [ ] **Step 6: Write `src/bluesky/poster.ts`**

```ts
import { AtpAgent } from '@atproto/api';

export class Poster {
  private constructor(private agent: AtpAgent) {}

  static async login(handle: string, appPassword: string): Promise<Poster> {
    const agent = new AtpAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: handle, password: appPassword });
    return new Poster(agent);
  }

  async post(text: string, image: Buffer | null, alt: string): Promise<string> {
    let embed;
    if (image) {
      const upload = await this.agent.uploadBlob(image, { encoding: 'image/png' });
      embed = { $type: 'app.bsky.embed.images' as const, images: [{ image: upload.data.blob, alt }] };
    }
    const res = await this.agent.post({ text, embed, createdAt: new Date().toISOString() });
    return res.uri;
  }
}
```

- [ ] **Step 7: Verify everything compiles and tests pass**

Run: `npx tsc && npx vitest run`
Expected: tsc exits 0; all suites pass (geo, stateMachine, client, airports, store, messages).

- [ ] **Step 8: Commit**

```bash
git add src/bluesky src/map test/messages.test.ts
git add src/types/staticmaps.d.ts 2>/dev/null || true
git commit -m "feat: Bluesky message formatting, static map render, poster"
```

---

### Task 9: Wiring — poll loop, dispatch, dry-run, shutdown

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: everything above (exact signatures from each task's Produces block)
- Produces: runnable entrypoint — `node dist/index.js [--dry-run]`

- [ ] **Step 1: Write `src/index.ts`**

```ts
import 'dotenv/config';
import { config } from './config.js';
import { logger } from './logger.js';
import { transition } from './core/stateMachine.js';
import type { FlightEvent, TrackerState } from './core/types.js';
import { fetchObservation } from './adsb/client.js';
import { elevationFtAt, loadAirports, resolvePlace } from './airports/airports.js';
import { Store, type PostRow } from './store/db.js';
import { landingText, takeoffText } from './bluesky/messages.js';
import { Poster } from './bluesky/poster.js';
import { renderMap } from './map/staticMap.js';

const dryRun = process.argv.includes('--dry-run');

// Resolve places, format texts, and write flights + pending posts atomically with the state.
function recordEvents(store: Store, state: TrackerState, events: FlightEvent[], now: number): void {
  store.saveCycle(state, () => {
    for (const e of events) {
      if (e.type === 'abandoned') {
        store.abandonOpenFlights();
        logger.warn({ ts: e.ts }, 'flight abandoned (stale signal loss)');
        continue;
      }
      const place = resolvePlace(e.pos, e.type === 'landing' && e.presumed);
      if (e.type === 'takeoff') {
        store.openFlight({ takeoffTs: e.ts, lat: e.pos.lat, lon: e.pos.lon, place });
        store.addPost({ type: 'takeoff', text: takeoffText(place, e.ts), lat: e.pos.lat, lon: e.pos.lon, createdTs: now });
      } else {
        const durationMs = e.takeoffTs === null ? null : e.ts - e.takeoffTs;
        store.closeFlight({
          landingTs: e.ts,
          lat: e.pos.lat,
          lon: e.pos.lon,
          place,
          durationS: durationMs === null ? null : Math.round(durationMs / 1000),
          presumed: e.presumed,
        });
        store.addPost({ type: 'landing', text: landingText(place, e.ts, durationMs), lat: e.pos.lat, lon: e.pos.lon, createdTs: now });
      }
    }
  });
}

async function dispatch(store: Store, poster: Poster | null, post: PostRow): Promise<void> {
  if (dryRun || !poster) {
    logger.info({ text: post.text }, 'dry-run: would post');
    store.markPost(post.id, 'dry_run');
    return;
  }
  let image: Buffer | null = null;
  try {
    image = await renderMap(post.lat, post.lon);
  } catch (err) {
    logger.warn({ err: String(err) }, 'map render failed; posting text-only');
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const uri = await poster.post(post.text, image, `Map of the ${post.type} location of ${config.aircraftLabel}`);
      store.markPost(post.id, 'posted', uri);
      logger.info({ uri, text: post.text }, 'posted to Bluesky');
      return;
    } catch (err) {
      logger.warn({ err: String(err), attempt }, 'Bluesky post failed');
      await new Promise((r) => setTimeout(r, attempt * 5_000));
    }
  }
  logger.error({ id: post.id }, 'post still pending after 3 attempts; will retry on restart');
}

async function main(): Promise<void> {
  const airportCount = loadAirports(config.airportsCsvPath);
  logger.info({ airportCount, hex: config.aircraftHex, dryRun }, 'starting cr7jet-tracker');

  const store = new Store(config.dbPath);
  let state = store.loadState();

  let poster: Poster | null = null;
  if (!dryRun) {
    const handle = process.env.BLUESKY_HANDLE;
    const password = process.env.BLUESKY_APP_PASSWORD;
    if (!handle || !password) throw new Error('BLUESKY_HANDLE and BLUESKY_APP_PASSWORD are required (see .env.example)');
    poster = await Poster.login(handle, password);
    logger.info({ handle }, 'logged in to Bluesky');
  }

  // Retry posts left pending by a previous run; skip stale ones instead of posting old news.
  for (const p of store.pendingPosts()) {
    if (Date.now() - p.created_ts > config.stalePostSkipMs) {
      store.markPost(p.id, 'skipped');
      logger.warn({ text: p.text }, 'skipped stale pending post');
    } else {
      await dispatch(store, poster, p);
    }
  }

  let failures = 0;
  let stopped = false;
  let inCycle = false;
  let timer: NodeJS.Timeout | undefined;

  const shutdown = (): void => {
    logger.info('shutting down');
    stopped = true;
    clearTimeout(timer);
    if (!inCycle) {
      store.close();
      process.exit(0);
    } // else the running cycle finishes and exits in its finally block
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const cycle = async (): Promise<void> => {
    inCycle = true;
    try {
      const now = Date.now();
      const obs = await fetchObservation(now);
      if (obs.kind === 'signal' && typeof obs.altFt === 'number') {
        obs.aglFt = obs.altFt - elevationFtAt(obs);
      }
      logger.debug({ phase: state.phase, obs }, 'poll');
      const { state: next, events } = transition(state, obs, config.machine);
      if (next.phase !== state.phase) logger.info({ from: state.phase, to: next.phase }, 'phase change');
      recordEvents(store, next, events, now);
      state = next;
      for (const p of store.pendingPosts()) await dispatch(store, poster, p);
      failures = 0;
    } catch (err) {
      // API failure ≠ absence: the state machine was not called this cycle
      failures++;
      logger.warn({ err: String(err), failures }, 'poll cycle failed; backing off');
    } finally {
      inCycle = false;
      if (stopped) {
        store.close();
        process.exit(0);
      } else {
        const delay =
          failures === 0 ? config.pollIntervalMs : Math.min(config.pollIntervalMs * 2 ** failures, config.maxBackoffMs);
        timer = setTimeout(() => void cycle(), delay);
      }
    }
  };

  void cycle();
}

void main();
```

- [ ] **Step 2: Build and run the full test suite**

Run: `npx tsc && npx vitest run`
Expected: tsc exits 0; all tests pass.

- [ ] **Step 3: Dry-run smoke test**

Run: `timeout 70 node dist/index.js --dry-run; echo "exit: $?"`
Expected: startup log with `airportCount` ≈ 80 000, `dryRun: true`; at least two poll cycles 30 s apart (set `LOG_LEVEL=debug` to see them); no crash. `exit: 124` (timeout kill) is fine. Then verify Ctrl-C handling: `node dist/index.js --dry-run`, press Ctrl-C, expect "shutting down" and clean exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire poll loop, event dispatch, dry-run, graceful shutdown"
```

---

### Task 10: Docker, README, final verification

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`
- Modify: `README.md` (replace the stub)

**Interfaces:**
- Consumes: `dist/index.js`, `data/airports.csv`, `DB_PATH` env override from `src/config.ts`
- Produces: deployable container; user-facing docs

- [ ] **Step 1: Write `Dockerfile`** (node:22-slim, not alpine — better-sqlite3 ships glibc prebuilds, so no toolchain needed)

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY data/airports.csv ./data/airports.csv
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Write `docker-compose.yml`**

```yaml
services:
  cr7jet-tracker:
    build: .
    env_file: .env
    environment:
      DB_PATH: /data/tracker.db
    volumes:
      - tracker-data:/data
    restart: unless-stopped
    stop_grace_period: 45s

volumes:
  tracker-data:
```

- [ ] **Step 3: Replace `README.md`**

```markdown
# cr7jet-tracker

Tracks the private jet **LX-GOL** (ICAO24 `4d0226`) via ADS-B and posts takeoff/landing
notifications to Bluesky, with a map of the location attached.

- Polls [airplanes.live](https://airplanes.live) every 30 s, falling back to
  [adsb.lol](https://adsb.lol) automatically.
- A debounced state machine detects takeoffs and landings — including "blocked jet"
  landings where the transponder drops off ADS-B below 3,000 ft near an airport.
- State is persisted to SQLite, so restarts never duplicate or miss posts.
- Positions resolve to the nearest airport (or city) from the vendored
  [OurAirports](https://ourairports.com/data/) dataset.

## Setup

```bash
npm install
cp .env.example .env   # fill in your Bluesky credentials
npm test
npm run build
```

## .env

| Variable | Required | Description |
|---|---|---|
| `BLUESKY_HANDLE` | yes | e.g. `cr7jet.bsky.social` |
| `BLUESKY_APP_PASSWORD` | yes | An [app password](https://bsky.app/settings/app-passwords), not your account password |
| `LOG_LEVEL` | no | pino level, default `info` |
| `DB_PATH` | no | SQLite path, default `data/tracker.db` |

## Running

```bash
node dist/index.js            # live
node dist/index.js --dry-run  # logs would-be posts, never touches Bluesky
```

## Deployment (Docker)

```bash
docker compose up -d --build
docker compose logs -f
```

The SQLite database lives in the `tracker-data` volume, so state (and the
no-duplicate-post guarantee) survives container restarts and rebuilds.

## Tracking a different aircraft

Everything aircraft-specific lives in `src/config.ts`: hex code, label, poll
interval, detection thresholds, and the fuel burn rate (1,900 kg/h for the
Global Express XRS). Change those and redeploy.

## Refreshing the airports dataset

```bash
npm run update-airports && git add data/airports.csv && git commit -m "chore: refresh airports.csv"
```
```

- [ ] **Step 4: Final verification**

Run: `npx tsc && npx vitest run`
Expected: everything green.
Optional (if Docker is running): `docker compose build` — expect a successful image build.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml README.md
git commit -m "feat: Dockerfile, compose, README"
```
