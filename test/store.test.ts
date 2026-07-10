import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialState } from '../src/core/types.js';
import { Store } from '../src/store/db.js';

const freshStore = (): Store => new Store(join(mkdtempSync(join(tmpdir(), 'store-')), 'test.db'));

describe('Store', () => {
  it('loadState returns initialState on first run', () => {
    expect(freshStore().loadState()).toEqual(initialState);
  });

  it('saveCycle round-trips state', () => {
    const store = freshStore();
    const state = { ...initialState, phase: 'grounded' as const };
    store.saveCycle(state);
    expect(store.loadState()).toEqual(state);
  });

  it('post lifecycle: pending → posted', () => {
    const store = freshStore();
    let id = 0;
    store.saveCycle(initialState, () => {
      id = store.addPost({ type: 'takeoff', text: '🛫 test', lat: 1, lon: 2, createdTs: 123 });
    });
    expect(store.pendingPosts()).toHaveLength(1);
    store.markPost(id, 'posted', 'at://post/1');
    expect(store.pendingPosts()).toHaveLength(0);
  });

  it('flight lifecycle: open → closed with duration', () => {
    const store = freshStore();
    store.openFlight({ takeoffTs: 1000, lat: 38.77, lon: -9.13, place: 'LIS' });
    store.closeFlight({ landingTs: 16_381_000, lat: 24.95, lon: 46.7, place: 'RUH', durationS: 16_380, presumed: false });
    const flights = store.flights();
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ status: 'closed', duration_s: 16_380, takeoff_place: 'LIS', landing_place: 'RUH' });
  });

  it('closeFlight with no open flight records a closed landing-only row (mid-flight adoption)', () => {
    const store = freshStore();
    store.closeFlight({ landingTs: 5000, lat: 24.95, lon: 46.7, place: 'RUH', durationS: null, presumed: false });
    expect(store.flights()[0]).toMatchObject({ status: 'closed', takeoff_ts: null, duration_s: null });
  });

  it('abandonOpenFlights marks open flights abandoned', () => {
    const store = freshStore();
    store.openFlight({ takeoffTs: 1000, lat: 38.77, lon: -9.13, place: 'LIS' });
    store.abandonOpenFlights();
    expect(store.flights()[0]).toMatchObject({ status: 'abandoned' });
  });
});
