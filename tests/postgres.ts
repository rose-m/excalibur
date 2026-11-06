import { randomUUID } from "node:crypto";
import { after } from "node:test";
import { Pool, type PoolConfig } from "pg";
import { PostgresCanvasRepository } from "../src/server/persistence/postgres.js";

const connection: PoolConfig = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 55432),
  user: process.env.PGUSER ?? "excalibur",
  password: process.env.PGPASSWORD ?? "excalibur",
  database: "excalibur_test",
  connectionString: process.env.TEST_DATABASE_URL,
};
const databases = new WeakMap<PostgresCanvasRepository, { config: PoolConfig; raw: Pool; repositories: PostgresCanvasRepository[] }>();

export async function createTestRepository(migrationsDirectory?: string) {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 10_000 });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); }
  finally { await admin.end(); }
  const config = { ...connection, options: `-c search_path=${schema}`, max: 2, connectionTimeoutMillis: 10_000 };
  const database = { config, raw: new Pool({ ...config, max: 1 }), repositories: [] as PostgresCanvasRepository[] };
  after(async () => {
    try {
      await Promise.all(database.repositories.map(repository => repository.close()));
      await database.raw.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await database.raw.end(); }
  });
  const repository = await PostgresCanvasRepository.open(config, migrationsDirectory);
  register(repository, database);
  return repository;
}

function register(repository: PostgresCanvasRepository, database: NonNullable<ReturnType<typeof databases.get>>) {
  const close = repository.close.bind(repository);
  let closed: Promise<void> | undefined;
  repository.close = () => closed ??= close();
  database.repositories.push(repository);
  databases.set(repository, database);
}

export async function reopenTestRepository(previous: PostgresCanvasRepository, migrationsDirectory?: string) {
  const database = databases.get(previous)!;
  const repository = await PostgresCanvasRepository.open(database.config, migrationsDirectory);
  register(repository, database);
  return repository;
}

export function testDatabase(repository: PostgresCanvasRepository) { return databases.get(repository)!.raw; }
