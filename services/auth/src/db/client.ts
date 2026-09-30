import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

const { Pool } = pg;

let dbInstance: Kysely<Database> | null = null;
let poolInstance: pg.Pool | null = null;

// node-pg only parses arrays of built-in types; auth.role[] (a custom enum) arrives as '{viewer,creator}'.
export async function registerArrayParsers(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ oid: number }>(
    `SELECT 'auth.role[]'::regtype::oid::int AS oid`,
  );
  if (rows[0]?.oid) {
    pg.types.setTypeParser(rows[0].oid, pg.types.getTypeParser(1009 as never)); // same parser as text[]
  }
}

export function getDb(
  databaseUrl?: string,
  customPool?: pg.Pool,
): { db: Kysely<Database>; pool: pg.Pool } {
  if (customPool) {
    const db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: customPool,
      }),
    });
    return { db, pool: customPool };
  }

  if (dbInstance && poolInstance) {
    return { db: dbInstance, pool: poolInstance };
  }

  const url = databaseUrl || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  poolInstance = new Pool({
    connectionString: url,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  dbInstance = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: poolInstance,
    }),
  });

  return { db: dbInstance, pool: poolInstance };
}

export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.destroy();
    dbInstance = null;
  }
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}
