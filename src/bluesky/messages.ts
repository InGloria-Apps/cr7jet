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
