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
