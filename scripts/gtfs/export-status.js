import { mkdir,writeFile,rename,rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import pg from 'pg';

export async function exportStatus(client,output) {
  // Only the explicitly public provenance view is exported. No connection strings,
  // raw observations, account data or full feed contents go into the web build.
  const {rows} = await client.query(`SELECT agency_id,name,source_url,source_page_url,license_url,attribution,
    timezone,input_kind,imported_at,retrieved_at,source_modified_at,valid_from::text,valid_until::text,
    status,activated_at,route_count,stop_count,trip_count,stop_time_count
    FROM gtfs_feed_status ORDER BY agency_id`);
  const snapshot = { generated_at:new Date().toISOString(),rows };
  await mkdir(path.dirname(output),{recursive:true});
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary,JSON.stringify(snapshot,null,2) + '\n',{mode:0o644});
    await rename(temporary,output);
  } finally { await rm(temporary,{force:true}); }
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client;
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('USE_OPTIONAL_OUTPUT_FLAG');
    const output = args[1] ? path.resolve(args[1]) : fileURLToPath(new URL('../../web/generated/feed-status.json',import.meta.url));
    client = new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
    await client.connect();
    const snapshot = await exportStatus(client,output);
    console.log(`Exported ${snapshot.rows.length} public feed-status rows to ${output}`);
  } catch (error) {
    console.error('GTFS status export failed:',error.code || (['DATABASE_URL_REQUIRED','USE_OPTIONAL_OUTPUT_FLAG'].includes(error.message) ? error.message : error.name));
    process.exitCode = 1;
  } finally { await client?.end(); }
}
