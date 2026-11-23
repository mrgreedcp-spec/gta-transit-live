import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openArchive,seconds,date,validateRow,LIMITS } from '../scripts/gtfs/parse.js';
import { sourceFor } from '../scripts/gtfs/sources.js';
import { migrate } from '../scripts/gtfs/migrate.js';
import { importGtfs } from '../scripts/gtfs/import.js';
import { exportStatus } from '../scripts/gtfs/export-status.js';

// Tiny fictional feed. No fixture values are shipped as passenger information.
function files(overrides = {}) {
  return {
    'agency.txt':'agency_id,agency_name,agency_url,agency_timezone\na,Fixture Transit,https://example.invalid,America/Toronto\n',
    'stops.txt':'\uFEFFstop_id,stop_name,stop_lat,stop_lon\ns1,"Terminal,\nEast",43.6,-79.6\ns2,West Stop,43.61,-79.61\n',
    'routes.txt':'route_id,agency_id,route_short_name,route_long_name,route_type\nr1,a,TEST,Fixture Route,3\n',
    'calendar.txt':'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,1,1,1,1,0,0,20261101,20261130\n',
    'trips.txt':'route_id,service_id,trip_id,trip_headsign\nr1,weekday,t1,Fixture terminal\n',
    'stop_times.txt':'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,24:10:00,24:10:00,s1,1\nt1,24:20:00,24:20:00,s2,2\n',
    ...overrides,
  };
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i=0;i<8;i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const chunks = [], directory = []; let offset = 0;
  for (const [filename,text] of entries) {
    const name = Buffer.from(filename), body = Buffer.from(text), crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt32LE(crc,14);
    local.writeUInt32LE(body.length,18); local.writeUInt32LE(body.length,22); local.writeUInt16LE(name.length,26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6);
    central.writeUInt32LE(crc,16); central.writeUInt32LE(body.length,20); central.writeUInt32LE(body.length,24);
    central.writeUInt16LE(name.length,28); central.writeUInt32LE(offset,42);
    chunks.push(local,name,body); directory.push(central,name); offset += local.length + name.length + body.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(central.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,central,end]);
}
async function fixture(t,contents = files()) {
  const dir = await mkdtemp(path.join(tmpdir(),'gtfs-test-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'fixture.zip');
  await writeFile(file,zip(Array.isArray(contents) ? contents : Object.entries(contents)));
  return file;
}
async function collect(archive,name) { const rows=[]; for await (const row of archive.rows(name)) rows.push(row); return rows; }

test('GTFS time preserves after-midnight service-day seconds',() => {
  assert.equal(seconds('25:10:00'),90600);
  assert.equal(seconds('00:00:00'),0);
  assert.equal(seconds(''),null);
  for (const value of ['24:61:00','24:00:60','-01:00:00','12:00','NaN']) assert.throws(() => seconds(value));
});
test('GTFS dates reject impossible dates and handle leap days',() => {
  assert.equal(date('20240229'),'2024-02-29');
  for (const value of ['20260229','20261131','20261301','2026-11-23']) assert.throws(() => date(value));
});
test('official source registry rejects arbitrary agency/URL input',() => {
  assert.equal(new URL(sourceFor('miway').url).hostname,'www.miapp.ca');
  assert.throws(() => sourceFor('https://127.0.0.1/secret'));
  assert.throws(() => sourceFor('__proto__'));
});
test('streaming ZIP/CSV parser supports BOM, quoted commas/newlines and 24+ hour times',async t => {
  const archive = await openArchive(await fixture(t)); t.after(() => archive.close());
  const stops = await collect(archive,'stops.txt');
  assert.equal(stops.length,2); assert.equal(stops[0][2],'Terminal,\nEast');
  assert.equal((await collect(archive,'stop_times.txt'))[0][3],87000);
});
test('calendar_dates-only feeds are valid archives',async t => {
  const contents = files({'calendar_dates.txt':'service_id,date,exception_type\nweekday,20261123,1\n'});
  delete contents['calendar.txt'];
  const archive = await openArchive(await fixture(t,contents)); t.after(() => archive.close());
  assert.deepEqual(await collect(archive,'calendar_dates.txt'),[['weekday','2026-11-23',1]]);
});
test('malformed CSV headers, coordinates and exact timepoints fail closed',async t => {
  const archive = await openArchive(await fixture(t,files({'stops.txt':'stop_id,stop_id,stop_name\na,a,X\n'})));
  t.after(() => archive.close()); await assert.rejects(collect(archive,'stops.txt'),/Duplicate column/);
  assert.throws(() => validateRow('stops.txt',{stop_id:'x',stop_name:'x',stop_lat:'91',stop_lon:'-79'}),/Out-of-range/);
  assert.throws(() => validateRow('stop_times.txt',{trip_id:'x',stop_id:'x',stop_sequence:'1',arrival_time:'',departure_time:''}),/Exact timepoint/);
  assert.throws(() => validateRow('calendar_dates.txt',{service_id:'x',date:'20261123',exception_type:'3'}),/Out-of-range/);
});
test('unsafe ZIP paths, duplicate tables and excessive expansion are rejected',async t => {
  await assert.rejects(openArchive(await fixture(t,[...Object.entries(files()),['../stops.txt','x']])),/path/i);
  await assert.rejects(openArchive(await fixture(t,[...Object.entries(files()),['nested/stops.txt',files()['stops.txt']]])),/Duplicate/);
  await assert.rejects(openArchive(await fixture(t),{...LIMITS,expandedBytes:100}),/expanded size/);
});

const testUrl = process.env.GTFS_TEST_DATABASE_URL;
test('PostgreSQL import atomically retains the previous feed after an invalid replacement',{skip:!testUrl},async t => {
  const parsed = new URL(testUrl);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'Integration tests require a local database.');
  assert.ok(parsed.pathname.endsWith('_test'),'Integration database name must end in _test.');
  const {default:pg} = await import('pg');
  const client = new pg.Client({connectionString:testUrl}); await client.connect();
  const schema = `gtfs_test_${Date.now()}_${process.pid}`;
  t.after(async () => { await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); });
  await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
  await verifyDatabase(t,client);
});

const pgliteModule = process.env.GTFS_TEST_PGLITE_MODULE;
test('isolated embedded PostgreSQL validates migration, replacement and rollback',{skip:!pgliteModule},async t => {
  const {PGlite} = await import(pgliteModule);
  const database = new PGlite();
  t.after(() => database.close());
  const client = {query:async (sql,values) => {
    if (!values && sql.includes('CREATE TABLE')) return (await database.exec(sql)).at(-1);
    return database.query(sql,values);
  }};
  await verifyDatabase(t,client);
});

// Exported to permit an isolated PostgreSQL/PGlite smoke run without a network DB.
export async function verifyDatabase(t,client) {
  await migrate(client); await migrate(client); // idempotence also preserves data
  const valid = await fixture(t);
  const first = await importGtfs(client,{agency:'miway',file:valid});
  const status = await client.query("SELECT * FROM gtfs_feed_status WHERE agency_id='miway'");
  assert.equal(status.rows[0].active_feed_id,first.feedId);
  assert.equal(status.rows[0].input_kind,'local_file'); assert.equal(status.rows[0].retrieved_at,null);
  assert.equal(status.rows[0].stop_count,2); assert.equal(status.rows[0].trip_count,1);
  assert.equal((await client.query('SELECT min(arrival_seconds) AS time FROM gtfs_stop_times')).rows[0].time,87000);
  const broken = files({'stop_times.txt':'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,24:10:00,24:10:00,missing-stop,1\n'});
  await assert.rejects(importGtfs(client,{agency:'miway',file:await fixture(t,broken)}));
  assert.equal((await client.query("SELECT active_feed_id FROM gtfs_agencies WHERE id='miway'")).rows[0].active_feed_id,first.feedId);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM gtfs_feeds WHERE status='failed'")).rows[0].n,1);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM gtfs_stop_times')).rows[0].n,2);
  const backwards = files({'stop_times.txt':'trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint\nt1,24:10:00,24:10:00,s1,1,1\nt1,,,s1,2,0\nt1,24:05:00,24:05:00,s2,3,1\n'});
  await assert.rejects(importGtfs(client,{agency:'miway',file:await fixture(t,backwards)}),/out of sequence/);
  assert.equal((await client.query("SELECT active_feed_id FROM gtfs_agencies WHERE id='miway'")).rows[0].active_feed_id,first.feedId);
  const second = await importGtfs(client,{agency:'miway',file:valid});
  assert.equal((await client.query("SELECT active_feed_id FROM gtfs_agencies WHERE id='miway'")).rows[0].active_feed_id,second.feedId);
  assert.equal((await client.query('SELECT status FROM gtfs_feeds WHERE id=$1',[first.feedId])).rows[0].status,'superseded');
  const output = path.join(path.dirname(valid),'status.json');
  const snapshot = await exportStatus(client,output);
  assert.equal(snapshot.rows.length,3);
  assert.equal(JSON.parse(await readFile(output,'utf8')).rows.find(row => row.agency_id === 'miway').status,'active');
  assert.equal(snapshot.rows.find(row => row.agency_id === 'ttc').status,'not_imported');
  assert.ok(!JSON.stringify(snapshot).includes('DATABASE_URL'));
}
