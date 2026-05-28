import path from "node:path"
import process from "node:process"

import {
  createOrUpdatePullRequest,
  patchEnvFile,
  readPullRequestEvent,
  readPullRequestMetadata,
  readPullRequestTemplate,
  validatePullRequestBody,
  validatePullRequestBodyAgainstSections,
  validatePullRequestTitle,
  verifyPackageVersion,
  isReleasePleasePullRequest,
} from "./lib/release-automation.js"

function readOption(args, name, fallback = null) {
  const index = args.indexOf(name)

  if (index === -1) {
    return fallback
  }

  const value = args[index + 1]

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`)
  }

  return value
}

function hasFlag(args, name) {
  return args.includes(name)
}

function fail(message, details = []) {
  console.error(message)

  for (const detail of details) {
    console.error(`- ${detail}`)
  }

  process.exit(1)
}

function printUsage() {
  console.log(`Usage:
  node scripts/ship.mjs pr [--base main] [--ready]
  node scripts/ship.mjs validate-pr-title
  node scripts/ship.mjs validate-pr-body
  node scripts/ship.mjs patch-test-env --file .env.test.local --database-url <url>
  node scripts/ship.mjs verify-package-version --expected <version>`)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  if (!command || command === "--help" || command === "help") {
    printUsage()
    return
  }

  if (command === "pr") {
    const base = readOption(args, "--base", "main")
    const ready = hasFlag(args, "--ready")
    const result = createOrUpdatePullRequest({ base, ready })

    console.log(`${result.action === "created" ? "Created" : "Updated"} PR: ${result.url}`)
    return
  }

  if (command === "validate-pr-title" || command === "validate-pr-body") {
    const eventPayload = readPullRequestEvent()
    const metadata = readPullRequestMetadata(eventPayload)

    if (command === "validate-pr-title") {
      const result = validatePullRequestTitle(metadata.title)

      if (!result.ok) {
        fail(result.reason)
      }

      console.log("PR title validation passed.")
      return
    }

    if (isReleasePleasePullRequest(metadata)) {
      console.log("Skipping manual body template validation for the release-please PR.")
      return
    }

    const template = readPullRequestTemplate()
    const templateSections = template
      .split(/\r?\n/)
      .map((line) => line.match(/^##\s+(.+?)\s*$/)?.[1] ?? null)
      .filter(Boolean)
    const result =
      templateSections.length > 0
        ? validatePullRequestBodyAgainstSections(metadata.body, templateSections)
        : validatePullRequestBody(metadata.body)

    if (!result.ok) {
      fail("PR body validation failed.", result.errors)
    }

    console.log("PR body validation passed.")
    return
  }

  if (command === "patch-test-env") {
    const filePath = readOption(args, "--file")
    const databaseUrl = readOption(args, "--database-url")

    patchEnvFile(path.resolve(filePath), databaseUrl)
    console.log(`Updated DATABASE_URL in ${filePath}.`)
    return
  }

  if (command === "verify-package-version") {
    const expectedVersion = readOption(args, "--expected")

    verifyPackageVersion(path.resolve("package.json"), expectedVersion)
    console.log(`package.json matches expected version ${expectedVersion}.`)
    return
  }

  fail(`Unknown command: ${command}`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
