import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import nextEnv from "@next/env"

import {
  buildRuntimeEnvValidationMessage,
  validateRuntimeEnv,
} from "../lib/env/runtime.js"

const { loadEnvConfig } = nextEnv

const VALID_MODES = new Set(["strict", "report-only"])
const VALID_TARGETS = new Set([
  "production",
  "preview",
  "development",
  "ci",
])

const VERCEL_SYSTEM_ENV_PREFIXES = ["VERCEL_", "NEXT_RUNTIME"]
const VERCEL_AUTH_KEYS = new Set([
  "VERCEL_TOKEN",
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
])

function printUsage() {
  console.log(`Usage: node scripts/check-runtime-env.mjs [--target=<target>] [--mode=<mode>] [--check-vercel] [--env-file=<path>]

Targets: production, preview, development, ci
Modes: strict, report-only
--check-vercel: also compare local env file keys against \`vercel env ls\` for the target environment.
--env-file: path to the env file whose keys are compared (defaults to none, only meaningful with --check-vercel).`)
}

function parseCliArgs(argv) {
  const options = {
    target: "production",
    mode: "strict",
    checkVercel: false,
    envFile: null,
  }

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage()
      process.exit(0)
    }

    if (arg === "--check-vercel") {
      options.checkVercel = true
      continue
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`)
    }

    const [flag, value] = arg.split("=", 2)

    if (!value) {
      throw new Error(`Missing value for ${flag}`)
    }

    if (flag === "--target") {
      if (!VALID_TARGETS.has(value)) {
        throw new Error(`Invalid target: ${value}`)
      }

      options.target = value
      continue
    }

    if (flag === "--mode") {
      if (!VALID_MODES.has(value)) {
        throw new Error(`Invalid mode: ${value}`)
      }

      options.mode = value
      continue
    }

    if (flag === "--env-file") {
      options.envFile = value
      continue
    }

    throw new Error(`Unknown option: ${flag}`)
  }

  return options
}

function getNextEnvDevFlag(target) {
  if (target === "development") {
    return true
  }

  return process.env.NODE_ENV === "development"
}

function buildCheckContext({ target, mode, loadedEnvFiles }) {
  return {
    target,
    mode,
    nodeEnv: process.env.NODE_ENV ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    gitRef:
      process.env.VERCEL_GIT_COMMIT_REF ?? process.env.GITHUB_REF_NAME ?? null,
    loadedEnvFiles: loadedEnvFiles.map((file) => file.path),
  }
}

function parseEnvFileKeys(path) {
  const content = readFileSync(path, "utf8")
  const keys = new Set()

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!match) continue
    keys.add(match[1])
  }

  return keys
}

function isSystemEnvKey(name) {
  if (VERCEL_AUTH_KEYS.has(name)) return true
  return VERCEL_SYSTEM_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function runVercelEnvLs(target) {
  const result = spawnSync(
    "npx",
    ["--yes", "vercel", "env", "ls", target, "--token", process.env.VERCEL_TOKEN ?? ""],
    {
      env: process.env,
      encoding: "utf8",
      shell: process.platform === "win32",
    }
  )

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? ""
    throw new Error(
      `vercel env ls failed (exit ${result.status}): ${stderr.trim() || "no stderr"}`
    )
  }

  return parseVercelEnvLsOutput(result.stdout ?? "")
}

function parseVercelEnvLsOutput(stdout) {
  const keys = new Set()
  const lines = stdout.split(/\r?\n/)

  for (const rawLine of lines) {
    const line = rawLine.replace(/\[[0-9;]*m/g, "").trim()
    if (!line) continue
    const match = line.match(/^([A-Z][A-Z0-9_]+)\s+/)
    if (!match) continue
    const name = match[1]
    if (isSystemEnvKey(name)) continue
    keys.add(name)
  }

  return keys
}

function compareKeySets({ localKeys, vercelKeys }) {
  const localOnly = []
  const vercelOnly = []

  for (const key of localKeys) {
    if (isSystemEnvKey(key)) continue
    if (!vercelKeys.has(key)) localOnly.push(key)
  }

  for (const key of vercelKeys) {
    if (!localKeys.has(key)) vercelOnly.push(key)
  }

  localOnly.sort()
  vercelOnly.sort()

  return { localOnly, vercelOnly }
}

function runVercelParityCheck({ target, envFile, mode }) {
  if (!process.env.VERCEL_TOKEN) {
    console.warn(
      "Skipping Vercel parity check: VERCEL_TOKEN is not set. Add it to the env file or export it."
    )
    return { skipped: true, ok: true }
  }

  if (!envFile) {
    console.warn(
      "Skipping Vercel parity check: --env-file is required to list local keys."
    )
    return { skipped: true, ok: true }
  }

  let localKeys
  try {
    localKeys = parseEnvFileKeys(envFile)
  } catch (error) {
    throw new Error(`Failed to read env file ${envFile}: ${error.message}`)
  }

  const vercelKeys = runVercelEnvLs(target)
  const { localOnly, vercelOnly } = compareKeySets({ localKeys, vercelKeys })
  const hasDrift = localOnly.length > 0 || vercelOnly.length > 0

  if (hasDrift) {
    console.error(
      `Vercel parity drift detected for ${target}: ${localOnly.length} local-only, ${vercelOnly.length} vercel-only.`
    )
    if (localOnly.length > 0) {
      console.error("- Keys in local file but missing in Vercel:")
      for (const name of localOnly) console.error(`  - ${name}`)
    }
    if (vercelOnly.length > 0) {
      console.error("- Keys in Vercel but missing in local file:")
      for (const name of vercelOnly) console.error(`  - ${name}`)
    }
    return { skipped: false, ok: mode !== "strict" }
  }

  console.log(
    `Vercel parity check passed for ${target}: ${vercelKeys.size} keys matched.`
  )
  return { skipped: false, ok: true }
}

try {
  const options = parseCliArgs(process.argv.slice(2))
  const { loadedEnvFiles = [] } = loadEnvConfig(
    process.cwd(),
    getNextEnvDevFlag(options.target),
    console,
    true
  )
  const validationResult = validateRuntimeEnv(options)
  const message = buildRuntimeEnvValidationMessage(validationResult)
  const context = buildCheckContext({
    target: options.target,
    mode: options.mode,
    loadedEnvFiles,
  })

  console.log(`Runtime env check context: ${JSON.stringify(context)}`)

  let parityOk = true
  if (options.checkVercel) {
    const parity = runVercelParityCheck({
      target: options.target,
      envFile: options.envFile,
      mode: options.mode,
    })
    parityOk = parity.ok
  }

  if (validationResult.ok && parityOk) {
    console.log(message)
    process.exit(0)
  }

  if (!validationResult.ok) {
    console.error(message)
    for (const problem of validationResult.problems) {
      console.error(`- ${problem.name}: ${problem.reason}`)
    }
  }

  process.exit(1)
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message)
  } else {
    console.error("Unexpected runtime env check error.")
  }

  printUsage()
  process.exit(1)
}
