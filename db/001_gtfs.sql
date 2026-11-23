-- Versioned GTFS snapshots. This database is independent of account/push Redis data.
-- Run with scripts/gtfs/migrate.js; PostgreSQL 14+; no PostGIS extension required.
BEGIN;

CREATE TABLE IF NOT EXISTS gtfs_agencies (
  id text PRIMARY KEY CHECK (id IN ('ttc', 'miway', 'go')),
  name text NOT NULL,
  source_url text NOT NULL,
  source_page_url text NOT NULL,
  license_url text NOT NULL,
  attribution text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Toronto',
  active_feed_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gtfs_feeds (
  id uuid PRIMARY KEY,
  agency_id text NOT NULL REFERENCES gtfs_agencies(id),
  status text NOT NULL CHECK (status IN ('importing','active','superseded','failed')),
  input_kind text NOT NULL CHECK (input_kind IN ('official_download','local_file')),
  source_url text NOT NULL,
  source_page_url text NOT NULL,
  license_url text NOT NULL,
  attribution text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  retrieved_at timestamptz,
  source_modified_at timestamptz,
  activated_at timestamptz,
  content_sha256 text,
  publisher_name text,
  publisher_url text,
  feed_version text,
  valid_from date,
  valid_until date,
  route_count integer NOT NULL DEFAULT 0,
  stop_count integer NOT NULL DEFAULT 0,
  trip_count integer NOT NULL DEFAULT 0,
  stop_time_count integer NOT NULL DEFAULT 0,
  error_code text,
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  UNIQUE (agency_id, id)
);

-- A composite FK prevents one agency pointing at another agency's snapshot.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gtfs_active_feed_fk' AND conrelid = 'gtfs_agencies'::regclass) THEN
    ALTER TABLE gtfs_agencies ADD CONSTRAINT gtfs_active_feed_fk
      FOREIGN KEY (id, active_feed_id) REFERENCES gtfs_feeds(agency_id, id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS gtfs_one_active_feed ON gtfs_feeds(agency_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS gtfs_feed_history ON gtfs_feeds(agency_id, imported_at DESC);

CREATE TABLE IF NOT EXISTS gtfs_feed_agencies (
  feed_id uuid NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  agency_id text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  timezone text NOT NULL,
  PRIMARY KEY (feed_id, agency_id)
);

CREATE TABLE IF NOT EXISTS gtfs_stops (
  feed_id uuid NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  stop_id text NOT NULL,
  stop_code text,
  stop_name text NOT NULL,
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  location_type smallint NOT NULL DEFAULT 0 CHECK (location_type BETWEEN 0 AND 4),
  parent_station text,
  wheelchair_boarding smallint NOT NULL DEFAULT 0 CHECK (wheelchair_boarding BETWEEN 0 AND 2),
  PRIMARY KEY (feed_id, stop_id)
);
CREATE INDEX IF NOT EXISTS gtfs_stops_location ON gtfs_stops(feed_id, latitude, longitude);

CREATE TABLE IF NOT EXISTS gtfs_routes (
  feed_id uuid NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  route_id text NOT NULL,
  agency_id text,
  short_name text NOT NULL DEFAULT '',
  long_name text NOT NULL DEFAULT '',
  route_type integer NOT NULL CHECK (route_type >= 0),
  color text,
  text_color text,
  PRIMARY KEY (feed_id, route_id),
  CHECK (length(short_name) > 0 OR length(long_name) > 0)
);

CREATE TABLE IF NOT EXISTS gtfs_services (
  feed_id uuid NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  PRIMARY KEY (feed_id, service_id)
);
CREATE TABLE IF NOT EXISTS gtfs_calendar (
  feed_id uuid NOT NULL,
  service_id text NOT NULL,
  monday boolean NOT NULL,
  tuesday boolean NOT NULL,
  wednesday boolean NOT NULL,
  thursday boolean NOT NULL,
  friday boolean NOT NULL,
  saturday boolean NOT NULL,
  sunday boolean NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  PRIMARY KEY (feed_id, service_id),
  FOREIGN KEY (feed_id, service_id) REFERENCES gtfs_services(feed_id, service_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
  feed_id uuid NOT NULL,
  service_id text NOT NULL,
  service_date date NOT NULL,
  exception_type smallint NOT NULL CHECK (exception_type IN (1,2)),
  PRIMARY KEY (feed_id, service_id, service_date),
  FOREIGN KEY (feed_id, service_id) REFERENCES gtfs_services(feed_id, service_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gtfs_trips (
  feed_id uuid NOT NULL,
  trip_id text NOT NULL,
  route_id text NOT NULL,
  service_id text NOT NULL,
  headsign text,
  direction_id smallint CHECK (direction_id IN (0,1)),
  shape_id text,
  wheelchair_accessible smallint NOT NULL DEFAULT 0 CHECK (wheelchair_accessible BETWEEN 0 AND 2),
  PRIMARY KEY (feed_id, trip_id),
  FOREIGN KEY (feed_id, route_id) REFERENCES gtfs_routes(feed_id, route_id) ON DELETE CASCADE,
  FOREIGN KEY (feed_id, service_id) REFERENCES gtfs_services(feed_id, service_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS gtfs_trips_route ON gtfs_trips(feed_id, route_id, service_id);

CREATE TABLE IF NOT EXISTS gtfs_stop_times (
  feed_id uuid NOT NULL,
  trip_id text NOT NULL,
  stop_sequence integer NOT NULL CHECK (stop_sequence >= 0),
  stop_id text NOT NULL,
  -- GTFS service-day seconds, NOT SQL time: 25:10:00 is valid.
  arrival_seconds integer CHECK (arrival_seconds >= 0),
  departure_seconds integer CHECK (departure_seconds >= 0),
  pickup_type smallint NOT NULL DEFAULT 0 CHECK (pickup_type BETWEEN 0 AND 3),
  drop_off_type smallint NOT NULL DEFAULT 0 CHECK (drop_off_type BETWEEN 0 AND 3),
  timepoint smallint NOT NULL DEFAULT 1 CHECK (timepoint IN (0,1)),
  PRIMARY KEY (feed_id, trip_id, stop_sequence),
  FOREIGN KEY (feed_id, trip_id) REFERENCES gtfs_trips(feed_id, trip_id) ON DELETE CASCADE,
  FOREIGN KEY (feed_id, stop_id) REFERENCES gtfs_stops(feed_id, stop_id) ON DELETE CASCADE,
  CHECK (arrival_seconds IS NULL OR departure_seconds IS NULL OR departure_seconds >= arrival_seconds)
);
CREATE INDEX IF NOT EXISTS gtfs_stop_departures ON gtfs_stop_times(feed_id, stop_id, departure_seconds);

-- Future GTFS-Realtime ingestion writes here, never overwriting scheduled stop_times.
-- An observation alone does not imply a usable prediction: adapters must validate
-- feed identity, service date, freshness, cancellation and schedule_relationship.
CREATE TABLE IF NOT EXISTS gtfs_realtime_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agency_id text NOT NULL REFERENCES gtfs_agencies(id),
  static_feed_id uuid,
  source_url text NOT NULL,
  entity_id text NOT NULL,
  entity_kind text NOT NULL CHECK (entity_kind IN ('trip_update','vehicle_position','alert')),
  retrieved_at timestamptz NOT NULL,
  source_timestamp timestamptz,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  CHECK (expires_at >= retrieved_at),
  FOREIGN KEY (agency_id, static_feed_id) REFERENCES gtfs_feeds(agency_id, id)
);
CREATE INDEX IF NOT EXISTS gtfs_realtime_freshness ON gtfs_realtime_observations(agency_id, expires_at);

CREATE OR REPLACE VIEW gtfs_feed_status AS
SELECT a.id AS agency_id, a.name, a.active_feed_id,
  COALESCE(f.source_url,a.source_url) AS source_url,
  COALESCE(f.source_page_url,a.source_page_url) AS source_page_url,
  COALESCE(f.license_url,a.license_url) AS license_url,
  COALESCE(f.attribution,a.attribution) AS attribution,
  a.timezone, f.input_kind, f.imported_at, f.retrieved_at, f.source_modified_at,
  f.valid_from, f.valid_until, COALESCE(f.status,'not_imported') AS status,
  f.activated_at, f.route_count, f.stop_count, f.trip_count, f.stop_time_count
FROM gtfs_agencies a LEFT JOIN gtfs_feeds f ON f.id = a.active_feed_id;

COMMIT;
