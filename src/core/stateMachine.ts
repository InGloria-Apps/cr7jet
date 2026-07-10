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
    // lastSignal deliberately not updated: it stays the last reading consistent with the
    // committed phase, so a takeoff can use the real ground fix as its position
    return { state: { ...s, candidate: cand }, events: [] };
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
