#!/usr/bin/env node
// Bootstrap script: replaces template placeholders across the repo with
// values you provide, prompts to keep or drop optional features, then
// deletes itself. Run once after cloning.
//
//   node scripts/init-template.mjs
//
// Placeholders replaced:
//   {{PROJECT_NAME}}    Human-readable name (e.g. "Acme Booking")
//   {{PROJECT_SLUG}}    npm/repo slug (e.g. "acme-booking")
//   {{TAG_PREFIX}}      Release-please tag prefix (e.g. "acme-booking-v")
//   {{SENTRY_PROJECT}}  Sentry project slug used in release name (e.g. "acme-booking")
//   {{DB_NAME_TEST}}    Test database name in CI (e.g. "acme_booking_test")
//
// Optional features (asked yes/no):
//   sentry-release      Tag Vercel deploys with SENTRY_RELEASE for source-map uploads.
//   db-backup           Nightly Postgres -> Cloudflare R2 backup workflow.
//
// Marker convention for opt-out blocks:
//   # >>> feature:NAME
//   ...lines to strip if user opts out...
//   # <<< feature:NAME

import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import {
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".vercel", "dist", "build"])
const TEXT_EXTENSIONS = new Set([
  ".md", ".json", ".yml", ".yaml", ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".jsx", ".html", ".css", ".env", ".example", ".gitignore",
])

function isTextFile(filePath) {
  if (TEXT_EXTENSIONS.has(path.extname(filePath))) return true
  const base = path.basename(filePath)
  if (base.startsWith(".env")) return true
  return false
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, files)
    } else if (stat.isFile() && isTextFile(full)) {
      files.push(full)
    }
  }
  return files
}

function defaultsFromDir() {
  const dirName = path.basename(ROOT)
  const slug = dirName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  const dbName = slug.replace(/-/g, "_") + "_test"
  return {
    PROJECT_NAME: dirName,
    PROJECT_SLUG: slug || "my-app",
    TAG_PREFIX: (slug || "my-app") + "-v",
    SENTRY_PROJECT: slug || "my-app",
    DB_NAME_TEST: dbName,
  }
}

async function prompt(rl, label, fallback) {
  const answer = (await rl.question(`${label} [${fallback}]: `)).trim()
  return answer || fallback
}

async function confirm(rl, label, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N"
  const answer = (await rl.question(`${label} (${hint}): `)).trim().toLowerCase()
  if (!answer) return defaultYes
  if (["y", "yes", "s", "si", "sí"].includes(answer)) return true
  if (["n", "no"].includes(answer)) return false
  console.log(`  Unrecognized answer "${answer}", using default.`)
  return defaultYes
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Removes lines starting with `>>> feature:NAME` through the matching
// `<<< feature:NAME`, inclusive. Always strips the marker lines themselves —
// even when the feature is kept — so the final repo has no leftover markers.
function stripFeatureBlock(content, feature, { keepInner }) {
  const escaped = escapeRegex(feature)
  const pattern = new RegExp(
    `^[^\\n]*>>> feature:${escaped}[^\\n]*\\n([\\s\\S]*?)^[^\\n]*<<< feature:${escaped}[^\\n]*\\n`,
    "gm"
  )
  return content.replace(pattern, keepInner ? "$1" : "")
}

async function main() {
  const defaults = defaultsFromDir()
  const rl = createInterface({ input, output })

  console.log("\nInitializing template. Press enter to accept defaults.\n")

  const values = {}
  for (const key of Object.keys(defaults)) {
    values[key] = await prompt(rl, key, defaults[key])
  }

  console.log("\nOptional features:")
  const includeSentry = await confirm(
    rl,
    "Include Sentry release tagging on production deploys?",
    true
  )
  const includeBackup = await confirm(
    rl,
    "Include nightly Postgres -> Cloudflare R2 backup workflow?",
    true
  )

  rl.close()

  const features = {
    "sentry-release": includeSentry,
    "db-backup": includeBackup,
  }

  const files = walk(ROOT)
  let changedFiles = 0

  for (const file of files) {
    const original = readFileSync(file, "utf8")
    let next = original

    for (const [key, value] of Object.entries(values)) {
      next = next.replaceAll(`{{${key}}}`, value)
    }

    for (const [feature, keepInner] of Object.entries(features)) {
      next = stripFeatureBlock(next, feature, { keepInner })
    }

    if (next !== original) {
      writeFileSync(file, next)
      changedFiles += 1
    }
  }

  if (!includeBackup) {
    const backupPath = path.join(ROOT, ".github", "workflows", "db-backup.yml")
    if (existsSync(backupPath)) {
      unlinkSync(backupPath)
      console.log("Removed .github/workflows/db-backup.yml")
    }
  }

  // Self-destruct.
  try {
    unlinkSync(fileURLToPath(import.meta.url))
  } catch {}

  console.log(`\nReplaced placeholders / stripped markers in ${changedFiles} file(s).`)
  console.log("Removed scripts/init-template.mjs.")
  console.log("\nNext steps:")
  console.log("  1. Edit lib/env/runtime.js to match your real env schema.")
  console.log("  2. Edit .env.ci.example with placeholder values for every required var.")
  console.log("  3. Configure GitHub secrets/vars (see README).")
  console.log("  4. Commit and push.\n")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
