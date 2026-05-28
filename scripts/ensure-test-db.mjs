import { Client } from "pg"

function getTargetDatabaseConfig() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required to prepare the test database."
    )
  }

  const parsedUrl = new URL(connectionString)
  const databaseName = parsedUrl.pathname.replace(/^\//, "")

  if (!databaseName) {
    throw new Error("DATABASE_URL must include a database name.")
  }

  if (!/^[A-Za-z0-9_-]+$/.test(databaseName)) {
    throw new Error(
      `Unsupported test database name "${databaseName}". Use letters, numbers, "_" or "-".`
    )
  }

  parsedUrl.pathname = "/postgres"

  return {
    adminConnectionString: parsedUrl.toString(),
    databaseName,
  }
}

async function ensureTestDatabase() {
  const { adminConnectionString, databaseName } = getTargetDatabaseConfig()
  const client = new Client({ connectionString: adminConnectionString })

  await client.connect()

  try {
    const existing = await client.query(
      "select 1 from pg_database where datname = $1 limit 1",
      [databaseName]
    )

    if (existing.rowCount && existing.rowCount > 0) {
      console.log(`[test-db] Database "${databaseName}" already exists.`)
      return
    }

    await client.query(`create database "${databaseName}"`)
    console.log(`[test-db] Created database "${databaseName}".`)
  } finally {
    await client.end()
  }
}

ensureTestDatabase().catch((error) => {
  console.error("[test-db] Failed to prepare the test database.")
  console.error(error)
  process.exitCode = 1
})
