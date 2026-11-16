import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (!process.env.MIGRATION_DB_URL) throw Error('MIGRATION_DB_URL is required');
const client = new pg.Client({ connectionString: process.env.MIGRATION_DB_URL });
const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(987654321)');
  await client.query('CREATE SCHEMA IF NOT EXISTS industry');
  await client.query('CREATE TABLE IF NOT EXISTS industry.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(folder)).filter(n => /^\d+_.*\.sql$/.test(n)).sort()) {
    const done = await client.query('SELECT 1 FROM industry.schema_migrations WHERE name=$1',[name]);
    if (done.rowCount) continue;
    await client.query(await readFile(join(folder, name), 'utf8'));
    await client.query('INSERT INTO industry.schema_migrations(name) VALUES($1)', [name]);
    process.stdout.write('Applied '+name+'\n');
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
