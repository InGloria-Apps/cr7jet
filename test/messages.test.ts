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
