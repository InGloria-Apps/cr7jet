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
    const s = transition(airborneLow(), absent(150_000), cfg).state; // lostSince = 150_000
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
    const s = transition(cruise, absent(60_000), cfg).state;
    const r = transition(s, absent(60_000 + 600_000), cfg); // 10 min silent
    expect(r.state.phase).toBe('signal_lost');
    expect(r.events).toEqual([]);
  });

  it('stale flight: 18 h silence resets to unknown with abandoned event, no landing', () => {
    const cruise = feed(initialState, [sig(0, 38_000), sig(30_000, 38_000)]).state;
    const s = transition(cruise, absent(60_000), cfg).state;
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
