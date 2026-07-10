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
