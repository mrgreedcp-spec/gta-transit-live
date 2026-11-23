import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sourceFor } from './sources.js';
import { openArchive, GtfsError, LIMITS } from './parse.js';

const TABLES = {
  'agency.txt': ['gtfs_feed_agencies',['agency_id','name','url','timezone']],
  'stops.txt': ['gtfs_stops',['stop_id','stop_code','stop_name','latitude','longitude','location_type','parent_station','wheelchair_boarding']],
  'routes.txt': ['gtfs_routes',['route_id','agency_id','short_name','long_name','route_type','color','text_color']],
  'calendar.txt': ['gtfs_calendar',['service_id','monday','tuesday','wednesday','thursday','friday','saturday','sunday','start_date','end_date']],
  'calendar_dates.txt': ['gtfs_calendar_dates',['service_id','service_date','exception_type']],
  'trips.txt': ['gtfs_trips',['trip_id','route_id','service_id','headsign','direction_id','shape_id','wheelchair_accessible']],
  'stop_times.txt': ['gtfs_stop_times',['trip_id','stop_sequence','stop_id','arrival_seconds','departure_seconds','pickup_type','drop_off_type','timepoint']],
};

async function insertBatch(client,feedId,table,columns,rows) {
  if (!rows.length) return;
  const values = [], width = columns.length + 1;
  const placeholders = rows.map((row,i) => {
    values.push(feedId,...row);
    return `(${Array.from({length:width},(_,j) => `$${i * width + j + 1}`).join(',')})`;
  });
  // Table and column names are compile-time constants; all feed values are bound.
  await client.query(`INSERT INTO ${table} (feed_id,${columns.join(',')}) VALUES ${placeholders.join(',')}`,values);
}

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadOfficial(agency) {
  const source = sourceFor(agency), directory = await mkdtemp(path.join(tmpdir(),'gta-gtfs-'));
  const file = path.join(directory,'feed.zip');
  try {
    // Redirects are deliberately rejected: an endpoint change needs source review.
    const response = await fetch(source.url,{
      redirect:'error', signal:AbortSignal.timeout(120000),
      headers:{'user-agent':'GTA-Transit-Live-static-import/1.0','accept':'application/zip, application/octet-stream'},
    });
    if (!response.ok || !response.body) throw new GtfsError('Official feed download failed.','SOURCE_HTTP');
    if (Number(response.headers.get('content-length')) > LIMITS.zipBytes) throw new GtfsError('Official archive exceeds size limit.','ZIP_LIMIT');
    let bytes = 0;
    const limit = new Transform({ transform(chunk,encoding,callback) {
      bytes += chunk.length;
      callback(bytes > LIMITS.zipBytes ? new GtfsError('Official archive exceeds size limit.','ZIP_LIMIT') : null,chunk);
    }});
    await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(file,{flags:'wx',mode:0o600}));
    const modified = response.headers.get('last-modified');
    const parsed = modified ? new Date(modified) : null;
    return {
      file, inputKind:'official_download', retrievedAt:new Date().toISOString(),
      sourceModifiedAt:parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null,
      cleanup:() => rm(directory,{recursive:true,force:true}),
    };
  } catch (error) { await rm(directory,{recursive:true,force:true}); throw error; }
}

export async function importGtfs(client,{ agency,file,inputKind = 'local_file',retrievedAt = null,sourceModifiedAt = null }) {
  const source = sourceFor(agency), feedId = randomUUID();
  if (!['official_download','local_file'].includes(inputKind)) throw new GtfsError('Invalid import provenance.');
  if (inputKind === 'official_download' && !retrievedAt) throw new GtfsError('Official download needs an actual retrieval timestamp.');
  if (inputKind === 'local_file') { retrievedAt = null; sourceModifiedAt = null; }
  const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[`gta-gtfs:${agency}`]);
  if (!lock.rows[0]?.acquired) throw new GtfsError('Another import for this agency is running.','IMPORT_BUSY');
  let archive = null, began = false, recorded = false;
  const counts = {};
  try {
    await client.query(`INSERT INTO gtfs_feeds
      (id,agency_id,status,input_kind,source_url,source_page_url,license_url,attribution,retrieved_at,source_modified_at)
      VALUES ($1,$2,'importing',$3,$4,$5,$6,$7,$8,$9)`,
    [feedId,agency,inputKind,source.url,source.page,source.license,source.attribution,retrievedAt,sourceModifiedAt]);
    recorded = true;
    archive = await openArchive(file);
    const sha = await fileHash(file);
    await client.query('BEGIN'); began = true;
    // Foreign keys enforce every route, service, trip and stop reference.
    for (const [name,[table,columns]] of Object.entries(TABLES)) {
      if (!archive.has(name)) continue;
      let batch = [], count = 0;
      const flush = async () => {
        if (name === 'calendar.txt' || name === 'calendar_dates.txt') {
          const ids = [...new Set(batch.map(row => row[0]))];
          if (ids.length) await client.query(`INSERT INTO gtfs_services(feed_id,service_id)
            SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING`,[feedId,ids]);
        }
        await insertBatch(client,feedId,table,columns,batch); batch = [];
      };
      for await (const row of archive.rows(name)) {
        batch.push(row); count++;
        if (batch.length >= 500) await flush();
      }
      await flush(); counts[name] = count;
    }
    for (const required of ['agency.txt','routes.txt','stops.txt','trips.txt','stop_times.txt']) {
      if (!counts[required]) throw new GtfsError(`${required} contains no usable rows.`);
    }
    const validation = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM gtfs_trips t WHERE t.feed_id=$1
        AND NOT EXISTS (SELECT 1 FROM gtfs_stop_times st WHERE st.feed_id=t.feed_id AND st.trip_id=t.trip_id)
      ) AS empty_trip,
      EXISTS (
        SELECT 1 FROM (
          SELECT arrival_seconds,departure_seconds,
            max(departure_seconds) OVER (PARTITION BY trip_id ORDER BY stop_sequence
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_departure,
            row_number() OVER (PARTITION BY trip_id ORDER BY stop_sequence) AS first_stop,
            row_number() OVER (PARTITION BY trip_id ORDER BY stop_sequence DESC) AS last_stop
          FROM gtfs_stop_times WHERE feed_id=$1
        ) s WHERE arrival_seconds < previous_departure
        OR ((first_stop=1 OR last_stop=1) AND (arrival_seconds IS NULL OR departure_seconds IS NULL))
      ) AS invalid_times`,[feedId]);
    if (validation.rows[0].empty_trip || validation.rows[0].invalid_times) throw new GtfsError('Trip times are missing or out of sequence.');
    let info = null;
    if (archive.has('feed_info.txt')) {
      for await (const row of archive.rows('feed_info.txt')) {
        if (info) throw new GtfsError('Multiple feed_info records are unsupported.');
        info = row;
      }
    }
    const coverage = await client.query(`SELECT min(start_date)::text AS first_date,max(end_date)::text AS last_date FROM (
      SELECT start_date,end_date FROM gtfs_calendar WHERE feed_id=$1
      UNION ALL SELECT service_date,service_date FROM gtfs_calendar_dates WHERE feed_id=$1 AND exception_type=1
    ) dates`,[feedId]);
    if (!coverage.rows[0].first_date) throw new GtfsError('No scheduled service dates in feed.');
    await client.query(`UPDATE gtfs_feeds SET content_sha256=$2,publisher_name=$3,publisher_url=$4,feed_version=$5,
      valid_from=$6,valid_until=$7,route_count=$8,stop_count=$9,trip_count=$10,stop_time_count=$11 WHERE id=$1`,
    [feedId,sha,info?.publisherName || null,info?.publisherUrl || null,info?.version || null,
      info?.validFrom || coverage.rows[0].first_date,info?.validUntil || coverage.rows[0].last_date,
      counts['routes.txt'],counts['stops.txt'],counts['trips.txt'],counts['stop_times.txt']]);
    // These three writes commit together. Readers see either complete old or complete new data.
    await client.query("UPDATE gtfs_feeds SET status='superseded' WHERE agency_id=$1 AND status='active'",[agency]);
    await client.query("UPDATE gtfs_feeds SET status='active',activated_at=now() WHERE id=$1",[feedId]);
    await client.query('UPDATE gtfs_agencies SET active_feed_id=$2,updated_at=now() WHERE id=$1',[agency,feedId]);
    await client.query('COMMIT'); began = false;
    return { feedId,agency,inputKind,retrievedAt,counts };
  } catch (error) {
    if (began) await client.query('ROLLBACK').catch(() => {});
    if (recorded) {
      const safeCode = String(error.code || 'IMPORT_FAILED').replace(/[^A-Za-z0-9_]/g,'').slice(0,80);
      await client.query("UPDATE gtfs_feeds SET status='failed',error_code=$2 WHERE id=$1 AND status='importing'",[feedId,safeCode]).catch(() => {});
    }
    throw error;
  } finally {
    archive?.close();
    await client.query('SELECT pg_advisory_unlock(hashtext($1))',[`gta-gtfs:${agency}`]).catch(() => {});
  }
}

function options(args) {
  const result = {};
  for (let i=0;i<args.length;i++) {
    const arg = args[i];
    if (arg === '--download') result.download = true;
    else if (arg === '--agency' || arg === '--file') {
      if (!args[i+1] || args[i+1].startsWith('--')) throw new GtfsError(`Value required for ${arg}.`);
      result[arg.slice(2)] = args[++i];
    } else throw new GtfsError(`Unknown option. Use --agency ttc|miway|go and exactly one of --download or --file <zip>.`);
  }
  sourceFor(result.agency);
  if (!!result.file === !!result.download) throw new GtfsError('Choose exactly one of --download and --file <zip>.');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client, download;
  try {
    const args = options(process.argv.slice(2));
    if (!process.env.DATABASE_URL) throw new GtfsError('DATABASE_URL is required. Run the migration first.');
    download = args.download ? await downloadOfficial(args.agency) : null;
    client = new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
    await client.connect();
    const result = await importGtfs(client,{ agency:args.agency,file:download?.file || args.file,
      inputKind:download?.inputKind || 'local_file',retrievedAt:download?.retrievedAt,sourceModifiedAt:download?.sourceModifiedAt });
    console.log(JSON.stringify(result,null,2));
  } catch (error) {
    // Never print connection strings, tokens, upstream bodies or database row data.
    console.error('GTFS import failed:',error instanceof GtfsError ? error.message : (error.code || error.name));
    process.exitCode = 1;
  } finally { await client?.end(); await download?.cleanup(); }
}
