import Database from 'better-sqlite3';
import { initialState, type TrackerState } from '../core/types.js';

export interface NewPost {
  type: 'takeoff' | 'landing';
  text: string;
  lat: number;
  lon: number;
  createdTs: number;
}

export interface PostRow {
  id: number;
  type: string;
  text: string;
  lat: number;
  lon: number;
  created_ts: number;
  status: string;
  uri: string | null;
}

export interface FlightRow {
  id: number;
  takeoff_ts: number | null;
  takeoff_place: string | null;
  landing_ts: number | null;
  landing_place: string | null;
  duration_s: number | null;
  presumed_landing: number;
  status: string;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracker_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        takeoff_ts INTEGER, takeoff_lat REAL, takeoff_lon REAL, takeoff_place TEXT,
        landing_ts INTEGER, landing_lat REAL, landing_lon REAL, landing_place TEXT,
        duration_s INTEGER,
        presumed_landing INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open'
      );
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        created_ts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        uri TEXT
      );
    `);
  }

  loadState(): TrackerState {
    const row = this.db.prepare('SELECT json FROM tracker_state WHERE id = 1').get() as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as TrackerState) : initialState;
  }

  /** Persist state and, atomically with it, any flight/post writes done in fn. */
  saveCycle(state: TrackerState, fn?: () => void): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tracker_state (id, json, updated_ts) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_ts = excluded.updated_ts`,
        )
        .run(JSON.stringify(state), Date.now());
      fn?.();
    })();
  }

  openFlight(p: { takeoffTs: number; lat: number; lon: number; place: string }): void {
    this.db
      .prepare('INSERT INTO flights (takeoff_ts, takeoff_lat, takeoff_lon, takeoff_place) VALUES (?, ?, ?, ?)')
      .run(p.takeoffTs, p.lat, p.lon, p.place);
  }

  closeFlight(p: {
    landingTs: number;
    lat: number;
    lon: number;
    place: string;
    durationS: number | null;
    presumed: boolean;
  }): void {
    const open = this.db
      .prepare("SELECT id FROM flights WHERE status = 'open' ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    if (open) {
      this.db
        .prepare(
          `UPDATE flights SET landing_ts = ?, landing_lat = ?, landing_lon = ?, landing_place = ?,
           duration_s = ?, presumed_landing = ?, status = 'closed' WHERE id = ?`,
        )
        .run(p.landingTs, p.lat, p.lon, p.place, p.durationS, p.presumed ? 1 : 0, open.id);
    } else {
      // mid-flight adoption: no takeoff row exists, record the landing on its own
      this.db
        .prepare(
          `INSERT INTO flights (landing_ts, landing_lat, landing_lon, landing_place, duration_s, presumed_landing, status)
           VALUES (?, ?, ?, ?, ?, ?, 'closed')`,
        )
        .run(p.landingTs, p.lat, p.lon, p.place, p.durationS, p.presumed ? 1 : 0);
    }
  }

  abandonOpenFlights(): void {
    this.db.prepare("UPDATE flights SET status = 'abandoned' WHERE status = 'open'").run();
  }

  addPost(p: NewPost): number {
    const r = this.db
      .prepare('INSERT INTO posts (type, text, lat, lon, created_ts) VALUES (?, ?, ?, ?, ?)')
      .run(p.type, p.text, p.lat, p.lon, p.createdTs);
    return Number(r.lastInsertRowid);
  }

  pendingPosts(): PostRow[] {
    return this.db.prepare("SELECT * FROM posts WHERE status = 'pending' ORDER BY id").all() as PostRow[];
  }

  markPost(id: number, status: 'posted' | 'skipped' | 'dry_run', uri?: string): void {
    this.db.prepare('UPDATE posts SET status = ?, uri = ? WHERE id = ?').run(status, uri ?? null, id);
  }

  flights(): FlightRow[] {
    return this.db.prepare('SELECT * FROM flights ORDER BY id').all() as FlightRow[];
  }

  close(): void {
    this.db.close();
  }
}
