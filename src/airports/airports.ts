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
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

// ponytail: linear scan of ~80k rows per lookup (a few ms). Spatial index if this ever matters.
function nearest(pos: Position, filter: (a: Airport) => boolean): { airport: Airport; distKm: number } | null {
  let best: Airport | null = null;
  let bestD = Infinity;
  for (const a of airports) {
    if (!filter(a)) continue;
    const d = haversineKm(pos, a);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
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
