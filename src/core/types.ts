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
