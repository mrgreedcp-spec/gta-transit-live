import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { SOURCES } from './sources.js';

export async function migrate(client) {
  await client.query(await readFile(new URL('../../db/001_gtfs.sql', import.meta.url), 'utf8'));
  for (const [id, source] of Object.entries(SOURCES)) {
    await client.query(`INSERT INTO gtfs_agencies (id,name,source_url,source_page_url,license_url,attribution)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET
      name=EXCLUDED.name,source_url=EXCLUDED.source_url,source_page_url=EXCLUDED.source_page_url,
      license_url=EXCLUDED.license_url,attribution=EXCLUDED.attribution,updated_at=now()`,
    [id, source.name, source.url, source.page, source.license, source.attribution]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; no default or production database is assumed.');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await migrate(client);
    console.log('GTFS schema ready. Existing active feeds and account storage are unchanged.');
  } catch (error) {
    console.error('GTFS migration failed:', error.code || error.name);
    process.exitCode = 1;
  } finally { await client.end(); }
}
