# cr7jet-tracker

Tracks the private jet **LX-GOL** (ICAO24 `4d0226`) via ADS-B and posts takeoff/landing
notifications to Bluesky, with a map of the location attached.

- Polls [airplanes.live](https://airplanes.live) every 30 s, falling back to
  [adsb.lol](https://adsb.lol) automatically.
- A debounced state machine detects takeoffs and landings — including "blocked jet"
  landings where the transponder drops off ADS-B below 3,000 ft near an airport.
- State is persisted to SQLite, so restarts never duplicate or miss posts.
- Positions resolve to the nearest airport (or city) from the vendored
  [OurAirports](https://ourairports.com/data/) dataset.

Example posts:

> 🛫 Took off from Humberto Delgado Airport (LIS), Portugal at 14:32 UTC
>
> 🛬 Landed at King Khalid International Airport (RUH), Saudi Arabia at 19:05 UTC. Flight time: 4h 33m. Est. fuel burn: ~8,645 kg

## Setup

```bash
npm install
cp .env.example .env   # fill in your Bluesky credentials
npm test
npm run build
```

## .env

| Variable | Required | Description |
|---|---|---|
| `BLUESKY_HANDLE` | yes | e.g. `cr7jet.bsky.social` |
| `BLUESKY_APP_PASSWORD` | yes | An [app password](https://bsky.app/settings/app-passwords), not your account password |
| `LOG_LEVEL` | no | pino level, default `info` |
| `DB_PATH` | no | SQLite path, default `data/tracker.db` |

## Running

```bash
node dist/index.js            # live
node dist/index.js --dry-run  # logs would-be posts, never touches Bluesky
```

## Deployment (Docker)

```bash
docker compose up -d --build
docker compose logs -f
```

The SQLite database lives in the `tracker-data` volume, so state (and the
no-duplicate-post guarantee) survives container restarts and rebuilds.

## Tracking a different aircraft

Everything aircraft-specific lives in `src/config.ts`: hex code, label, poll
interval, detection thresholds, and the fuel burn rate (1,900 kg/h for the
Global Express XRS). Change those and redeploy.

## Refreshing the airports dataset

```bash
npm run update-airports && git add data/airports.csv && git commit -m "chore: refresh airports.csv"
```

## Project docs

- Design spec: [`docs/superpowers/specs/2026-07-09-cr7jet-tracker-design.md`](docs/superpowers/specs/2026-07-09-cr7jet-tracker-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-07-09-cr7jet-tracker.md`](docs/superpowers/plans/2026-07-09-cr7jet-tracker.md)
