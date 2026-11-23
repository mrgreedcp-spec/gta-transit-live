# Static transit data

This PostgreSQL module supplements the existing live-map application. It does **not** move account, favourite, feedback or push data out of the existing storage. The public guide can run with no database; it must say that schedule data has not been imported instead of fabricating departures.

## Run locally or against a database you administer

Use PostgreSQL 14 or newer. Set `DATABASE_URL` in your shell or deployment secret manager; do not commit it. The scripts never choose a default database.

```bash
npm ci
node scripts/gtfs/migrate.js
node scripts/gtfs/import.js --agency miway --download
node scripts/gtfs/import.js --agency ttc --download
node scripts/gtfs/import.js --agency go --download
```

For a previously downloaded ZIP:

```bash
node scripts/gtfs/import.js --agency miway --file /absolute/path/google_transit.zip
```

A local file is labelled `local_file`; its `retrieved_at` and `source_modified_at` are **NULL**. File modification time and import time do not establish when the operator published the data. An official download records the actual completed download time, HTTP `Last-Modified` if supplied, source and licence links, attribution and SHA-256. GTFS `feed_info` dates/version are stored separately from the download timestamp.

## Read contract

`gtfs_feed_status` returns one row per configured agency, including `status = 'not_imported'` until a valid feed is active. It includes source URLs, attribution, provenance, service validity and row counts. Cache this administrative status rather than fetching feeds on passenger page requests. Never claim that static GTFS is real-time data.

Join every static table through `gtfs_agencies.active_feed_id`; never select arbitrary rows across snapshots:

```sql
SELECT r.route_id, r.short_name, r.long_name
FROM gtfs_agencies a
JOIN gtfs_routes r ON r.feed_id = a.active_feed_id
WHERE a.id = 'miway';
```

The SEO guide can use a build-time public status snapshot, avoiding database calls on every page view:

```bash
node scripts/gtfs/export-status.js
```

This writes `web/generated/feed-status.json` atomically with `generated_at` and `rows`. It contains only the explicit public status fields, not credentials or feed observations. A failed export leaves the prior file untouched; display both snapshot age and retrieval age, and rebuild the guide after a successful export. No default snapshot claims a feed has been imported.

Departure seconds are offsets within the **agency service day**, and can exceed 86,400. Resolve the service date in `America/Toronto`, apply weekday calendars and `calendar_dates` exceptions, and handle daylight saving explicitly before presenting scheduled timestamps. The importer does not provide a journey planner or an arrival-prediction algorithm. It retains optional intermediate stop times as NULL instead of interpolating unverified times.

`gtfs_realtime_observations` is a future adapter boundary, deliberately separate from schedules. The existing live-map real-time implementation continues to operate independently. A future adapter must verify matching GTFS IDs, service date, feed timestamps, cancellation/relationship flags and expiry before exposing predictions. TTC SurfaceGTFS is used because it matches the BusTime feed; it must not be advertised as complete subway coverage.

## Failure and update behaviour

Imports stream ZIP entries and CSV records, inserting batches of 500 rows. Archive size/count limits, safe paths, duplicate-table rejection, required columns, coordinates, dates, chronology and foreign keys are validated. A per-agency advisory lock prevents overlapping imports. The new snapshot is inserted and checked in one transaction; only its final commit switches the active pointer. A failure leaves the prior active snapshot intact and records a failed attempt without retaining partially loaded rows. Historical snapshots remain available; choose a retention policy before scheduling frequent updates.

Redirected downloads are rejected, and only reviewed TTC, MiWay and GO endpoints in `scripts/gtfs/sources.js` can be downloaded. Update the registry if an agency moves a feed. A working endpoint is not a promise of fresh service coverage: inspect `valid_until`, actual retrieval age and operator notices. This importer intentionally excludes shapes, fare files, frequencies, pathways and flexible service; it stores no fabricated equivalents. Agency licences remain controlling, especially Metrolinx attribution, endorsement and redistribution restrictions.

## Tests

```bash
node --test test/gtfs.test.js
```

Parser tests use explicitly fictional in-memory ZIP/CSV fixtures. The database transaction test runs only when `GTFS_TEST_DATABASE_URL` points to localhost and a database name ending in `_test`; it creates and removes its own temporary schema. Never use production credentials for tests.

```bash
GTFS_TEST_DATABASE_URL=postgresql://localhost/gta_transit_test node --test test/gtfs.test.js
```

For a disposable embedded PostgreSQL test without a network database, install PGlite outside the repository (this is not a runtime dependency):

```bash
npm install --prefix /tmp/gta-gtfs-pgtest --no-save @electric-sql/pglite@0.6.0
GTFS_TEST_PGLITE_MODULE=file:///tmp/gta-gtfs-pgtest/node_modules/@electric-sql/pglite/dist/index.js node --test test/gtfs.test.js
```

This executes the real SQL migration and fixture imports in memory, verifies a failed replacement cannot displace the active feed, checks successful supersession and validates the public status export. A hosted PostgreSQL deployment should still run its own migration verification with the chosen provider.

The schema is additive. To disable scheduled-data use, stop the importer and omit `DATABASE_URL` from the guide; live-map credentials and existing data remain unaffected. No migration drops the legacy application's tables or changes its access control.
