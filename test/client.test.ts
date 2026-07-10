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
