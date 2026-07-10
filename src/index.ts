import 'dotenv/config';
import { config } from './config.js';
import { logger } from './logger.js';
import { transition } from './core/stateMachine.js';
import type { FlightEvent, TrackerState } from './core/types.js';
import { fetchObservation } from './adsb/client.js';
import { elevationFtAt, loadAirports, resolvePlace } from './airports/airports.js';
import { Store, type PostRow } from './store/db.js';
import { landingText, takeoffText } from './bluesky/messages.js';
import { Poster } from './bluesky/poster.js';
import { renderMap } from './map/staticMap.js';

const dryRun = process.argv.includes('--dry-run');

// Resolve places, format texts, and write flights + pending posts atomically with the state.
function recordEvents(store: Store, state: TrackerState, events: FlightEvent[], now: number): void {
  store.saveCycle(state, () => {
    for (const e of events) {
      if (e.type === 'abandoned') {
        store.abandonOpenFlights();
        logger.warn({ ts: e.ts }, 'flight abandoned (stale signal loss)');
        continue;
      }
      const place = resolvePlace(e.pos, e.type === 'landing' && e.presumed);
      if (e.type === 'takeoff') {
        store.openFlight({ takeoffTs: e.ts, lat: e.pos.lat, lon: e.pos.lon, place });
        store.addPost({ type: 'takeoff', text: takeoffText(place, e.ts), lat: e.pos.lat, lon: e.pos.lon, createdTs: now });
      } else {
        const durationMs = e.takeoffTs === null ? null : e.ts - e.takeoffTs;
        store.closeFlight({
          landingTs: e.ts,
          lat: e.pos.lat,
          lon: e.pos.lon,
          place,
          durationS: durationMs === null ? null : Math.round(durationMs / 1000),
          presumed: e.presumed,
        });
        store.addPost({ type: 'landing', text: landingText(place, e.ts, durationMs), lat: e.pos.lat, lon: e.pos.lon, createdTs: now });
      }
    }
  });
}

async function dispatch(store: Store, poster: Poster | null, post: PostRow): Promise<void> {
  if (dryRun || !poster) {
    logger.info({ text: post.text }, 'dry-run: would post');
    store.markPost(post.id, 'dry_run');
    return;
  }
  let image: Buffer | null = null;
  try {
    image = await renderMap(post.lat, post.lon);
  } catch (err) {
    logger.warn({ err: String(err) }, 'map render failed; posting text-only');
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const uri = await poster.post(post.text, image, `Map of the ${post.type} location of ${config.aircraftLabel}`);
      store.markPost(post.id, 'posted', uri);
      logger.info({ uri, text: post.text }, 'posted to Bluesky');
      return;
    } catch (err) {
      logger.warn({ err: String(err), attempt }, 'Bluesky post failed');
      await new Promise((r) => setTimeout(r, attempt * 5_000));
    }
  }
  logger.error({ id: post.id }, 'post still pending after 3 attempts; will retry on restart');
}

async function main(): Promise<void> {
  const airportCount = loadAirports(config.airportsCsvPath);
  logger.info({ airportCount, hex: config.aircraftHex, dryRun }, 'starting cr7jet-tracker');

  const store = new Store(config.dbPath);
  let state = store.loadState();

  let poster: Poster | null = null;
  if (!dryRun) {
    const handle = process.env.BLUESKY_HANDLE;
    const password = process.env.BLUESKY_APP_PASSWORD;
    if (!handle || !password) throw new Error('BLUESKY_HANDLE and BLUESKY_APP_PASSWORD are required (see .env.example)');
    poster = await Poster.login(handle, password);
    logger.info({ handle }, 'logged in to Bluesky');
  }

  // Retry posts left pending by a previous run; skip stale ones instead of posting old news.
  for (const p of store.pendingPosts()) {
    if (Date.now() - p.created_ts > config.stalePostSkipMs) {
      store.markPost(p.id, 'skipped');
      logger.warn({ text: p.text }, 'skipped stale pending post');
    } else {
      await dispatch(store, poster, p);
    }
  }

  let failures = 0;
  let stopped = false;
  let inCycle = false;
  let timer: NodeJS.Timeout | undefined;

  const shutdown = (): void => {
    logger.info('shutting down');
    stopped = true;
    clearTimeout(timer);
    if (!inCycle) {
      store.close();
      process.exit(0);
    } // else the running cycle finishes and exits in its finally block
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const cycle = async (): Promise<void> => {
    inCycle = true;
    try {
      const now = Date.now();
      const obs = await fetchObservation(now);
      if (obs.kind === 'signal' && typeof obs.altFt === 'number') {
        obs.aglFt = obs.altFt - elevationFtAt(obs);
      }
      logger.debug({ phase: state.phase, obs }, 'poll');
      const { state: next, events } = transition(state, obs, config.machine);
      if (next.phase !== state.phase) logger.info({ from: state.phase, to: next.phase }, 'phase change');
      recordEvents(store, next, events, now);
      state = next;
      for (const p of store.pendingPosts()) await dispatch(store, poster, p);
      failures = 0;
    } catch (err) {
      // API failure ≠ absence: the state machine was not called this cycle
      failures++;
      logger.warn({ err: String(err), failures }, 'poll cycle failed; backing off');
    } finally {
      inCycle = false;
      if (stopped) {
        store.close();
        process.exit(0);
      } else {
        const delay =
          failures === 0 ? config.pollIntervalMs : Math.min(config.pollIntervalMs * 2 ** failures, config.maxBackoffMs);
        timer = setTimeout(() => void cycle(), delay);
      }
    }
  };

  void cycle();
}

void main();
