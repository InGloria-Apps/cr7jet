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
