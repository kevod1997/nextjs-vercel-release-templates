import { readFileSync } from "node:fs"
import path from "node:path"

import { Client } from "pg"

// Assumes Drizzle migrations live in `drizzle/` with a `meta/_journal.json`
// index. If you use a different migration tool (Prisma, node-pg-migrate,
// Knex), replace this script with that tool's reset+apply equivalent.
const ROOT_DIR = process.cwd()
const JOURNAL_PATH = path.join(ROOT_DIR, "drizzle", "meta", "_journal.json")
const MIGRATIONS_DIR = path.join(ROOT_DIR, "drizzle")

function loadJournalEntries() {
  const rawJournal = readFileSync(JOURNAL_PATH, "utf8")
  const parsed = JSON.parse(rawJournal)

  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error(`Invalid Drizzle journal at ${JOURNAL_PATH}.`)
  }

  return parsed.entries
}

async function applyMigrations() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error("DATABASE_URL is required to apply test migrations.")
  }

  const client = new Client({ connectionString })
  const journalEntries = loadJournalEntries()

  await client.connect()

  try {
    await client.query(`
      drop schema if exists public cascade;
      create schema public;
      drop schema if exists drizzle cascade;
      create schema drizzle;
      create table drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint not null
      );
    `)

    for (const entry of journalEntries) {
      if (
        typeof entry?.tag !== "string" ||
        typeof entry.when !== "number"
      ) {
        throw new Error(`Invalid Drizzle journal entry in ${JOURNAL_PATH}.`)
      }

      const migrationPath = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`)
      const sql = readFileSync(migrationPath, "utf8")

      await client.query(sql)
      await client.query(
        `insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)`,
        [entry.tag, entry.when]
      )
    }

    console.log(
      `[test-db] Applied ${journalEntries.length} migration files to the test database.`
    )
  } finally {
    await client.end()
  }
}

applyMigrations().catch((error) => {
  console.error("[test-db] Failed to apply test migrations.")
  console.error(error)
  process.exitCode = 1
})
