import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Default PR template section list. The actual template at
// `.github/pull_request_template.md` is the source of truth — these are only
// used when that file is missing or empty.
export const PR_TEMPLATE_SECTIONS = [
  "Summary",
  "User Impact",
  "Technical Approach",
  "Observability / Release Impact",
  "Env / Config Impact",
  "Validation",
  "Preview Notes",
]

export const RELEASE_PR_LABEL = "autorelease: pending"

const CONVENTIONAL_TITLE_PATTERN =
  /^(build|chore|ci|deps|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9][a-z0-9./_-]*\))?(!)?: .+\S$/i
const RELEASE_PR_TITLE_PATTERN = /^chore(\([^)]+\))?: release\b.+/i
const INVALID_SECTION_VALUE_PATTERN =
  /^(?:tbd|todo|n\/a|na|pending|placeholder|fill me in)$/i
const MARKDOWN_SECTION_HEADING_PATTERN = /^\s{0,3}##\s+(.+?)\s*$/

// File-path prefixes that affect the release/deploy pipeline. Extend with
// project-specific paths (e.g. `lib/release.ts`) when you add custom wiring.
const RELEASE_AUTOMATION_PATHS = [
  ".github/",
  ".release-please-manifest.json",
  "release-please-config.json",
  "scripts/ship.mjs",
  "scripts/lib/release-automation.js",
  "vercel.json",
]

// File-path prefixes whose changes should be called out under
// "Observability / Release Impact" in the PR body. Replace these with your
// project's observability surfaces (logger, instrumentation, Sentry config).
const OBSERVABILITY_PATHS = [
  "instrumentation",
  "next.config.mjs",
  "package.json",
]

// File-path prefixes whose changes should be called out under
// "Env / Config Impact" in the PR body.
const ENV_IMPACT_PATHS = [
  ".github/workflows/",
  ".env.example",
  ".env.ci.example",
  "scripts/check-runtime-env.mjs",
  "vercel.json",
  "package.json",
]

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, "\n")
}

function extractTemplateSections(template) {
  const headings = normalizeNewlines(template)
    .split("\n")
    .map((line) => line.match(MARKDOWN_SECTION_HEADING_PATTERN)?.[1] ?? null)
    .filter(Boolean)

  return headings.length > 0 ? headings : PR_TEMPLATE_SECTIONS
}

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function runJsonCommand(command, args, options = {}) {
  const output = runCommand(command, args, options)
  return output ? JSON.parse(output) : null
}

function summarizePaths(paths) {
  return Array.from(
    new Set(
      paths.map((filePath) => {
        const [rootSegment, secondSegment] = filePath.split("/")

        if (rootSegment === ".github" && secondSegment) {
          return `${rootSegment}/${secondSegment}`
        }

        return rootSegment
      })
    )
  )
}

function hasReleaseAutomationFiles(paths) {
  return paths.some((filePath) =>
    RELEASE_AUTOMATION_PATHS.some(
      (prefix) => filePath === prefix || filePath.startsWith(prefix)
    )
  )
}

function classifyObservabilityImpact(paths) {
  return paths.filter((filePath) =>
    OBSERVABILITY_PATHS.some((prefix) => filePath.startsWith(prefix))
  )
}

function classifyEnvImpact(paths) {
  return paths.filter((filePath) =>
    ENV_IMPACT_PATHS.some(
      (prefix) => filePath.startsWith(prefix) || filePath === prefix
    )
  )
}

function parseMarkdownSections(body) {
  const sections = new Map()

  if (!body) {
    return sections
  }

  let activeHeading = null
  const lines = normalizeNewlines(body).split("\n")

  for (const line of lines) {
    const headingMatch = line.match(MARKDOWN_SECTION_HEADING_PATTERN)

    if (headingMatch) {
      activeHeading = headingMatch[1]
      sections.set(activeHeading, [])
      continue
    }

    if (activeHeading) {
      sections.get(activeHeading)?.push(line)
    }
  }

  return new Map(
    Array.from(sections.entries()).map(([heading, sectionLines]) => [
      heading,
      sectionLines.join("\n").trim(),
    ])
  )
}

function sanitizeListValue(value) {
  return value.replace(/\s+/g, " ").trim()
}

export function isReleasePleasePullRequest(input = {}) {
  const labels = input.labels ?? []

  return labels.some((label) =>
    typeof label === "string"
      ? label === RELEASE_PR_LABEL
      : label?.name === RELEASE_PR_LABEL
  )
}

export function validatePullRequestTitle(title) {
  const trimmedTitle = sanitizeListValue(title ?? "")

  if (!trimmedTitle) {
    return {
      ok: false,
      reason: "PR title is required.",
    }
  }

  if (
    CONVENTIONAL_TITLE_PATTERN.test(trimmedTitle) ||
    RELEASE_PR_TITLE_PATTERN.test(trimmedTitle)
  ) {
    return { ok: true }
  }

  return {
    ok: false,
    reason:
      "PR title must use conventional commit format, for example `feat(ci): automate releases and production deploys`.",
  }
}

export function validatePullRequestBody(body) {
  return validatePullRequestBodyAgainstSections(body, PR_TEMPLATE_SECTIONS)
}

export function validatePullRequestBodyAgainstSections(
  body,
  templateSections = PR_TEMPLATE_SECTIONS
) {
  const sections = parseMarkdownSections(body)
  /** @type {string[]} */
  const errors = []

  for (const heading of templateSections) {
    const content = sections.get(heading)

    if (content === undefined) {
      errors.push(`Missing required section: ${heading}.`)
      continue
    }

    if (!content) {
      errors.push(`Section "${heading}" cannot be blank.`)
      continue
    }

    if (content !== "None" && INVALID_SECTION_VALUE_PATTERN.test(content)) {
      errors.push(
        `Section "${heading}" must contain concrete content or the exact literal None.`
      )
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  }
}

export function readPullRequestTemplate(
  templatePath = path.resolve(".github/pull_request_template.md")
) {
  return readFileSync(templatePath, "utf8")
}

export function patchEnvFile(filePath, nextDatabaseUrl) {
  const rawContents = readFileSync(filePath, "utf8")
  const lines = normalizeNewlines(rawContents).split("\n")
  let replaced = false

  const updatedLines = lines.map((line) => {
    if (!line.startsWith("DATABASE_URL=")) {
      return line
    }

    replaced = true
    return `DATABASE_URL=${nextDatabaseUrl}`
  })

  if (!replaced) {
    updatedLines.push(`DATABASE_URL=${nextDatabaseUrl}`)
  }

  writeFileSync(filePath, updatedLines.join("\n"))
}

export function verifyPackageVersion(filePath, expectedVersion) {
  const packageJson = JSON.parse(readFileSync(filePath, "utf8"))

  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `package.json version ${packageJson.version} does not match expected release version ${expectedVersion}.`
    )
  }
}

export function getCurrentBranch(options = {}) {
  return runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], options)
}

export function getChangedFiles(base, options = {}) {
  const output = runCommand(
    "git",
    ["diff", "--name-only", `${base}...HEAD`],
    options
  )

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

export function getCommitSubjects(base, options = {}) {
  const output = runCommand("git", ["log", "--format=%s", `${base}..HEAD`], options)

  return output
    .split("\n")
    .map((line) => sanitizeListValue(line))
    .filter(Boolean)
}

export function suggestPullRequestTitle(input = {}) {
  const changedFiles = input.changedFiles ?? []
  const commitSubjects = input.commitSubjects ?? []

  if (hasReleaseAutomationFiles(changedFiles)) {
    return "feat(ci): automate releases and production deploys"
  }

  const latestConventionalCommit = commitSubjects.find((subject) =>
    CONVENTIONAL_TITLE_PATTERN.test(subject)
  )

  if (latestConventionalCommit) {
    return latestConventionalCommit
  }

  if (changedFiles.length > 0 && changedFiles.every((filePath) => filePath.startsWith("docs/"))) {
    return "docs(repo): update documentation"
  }

  if (changedFiles.some((filePath) => filePath.startsWith(".github/"))) {
    return "ci(repo): update automation"
  }

  return "chore(repo): update branch"
}

export function renderPullRequestBody(input = {}) {
  const templateSections = input.template
    ? extractTemplateSections(input.template)
    : PR_TEMPLATE_SECTIONS
  const branch = input.branch
  const base = input.base
  const changedFiles = input.changedFiles ?? []
  const commitSubjects = input.commitSubjects ?? []
  const changedAreas = summarizePaths(changedFiles)
  const observabilityImpact = classifyObservabilityImpact(changedFiles)
  const envImpact = classifyEnvImpact(changedFiles)

  const summaryLines = [
    branch && base ? `- Sync \`${branch}\` into \`${base}\`.` : null,
    commitSubjects.length > 0
      ? `- Commits in scope: ${commitSubjects.slice(0, 5).join("; ")}.`
      : null,
  ].filter(Boolean)

  const technicalLines = [
    changedAreas.length > 0
      ? `- Touches: ${changedAreas.map((area) => `\`${area}\``).join(", ")}.`
      : null,
    changedFiles.length > 0
      ? `- Changed files: ${changedFiles
          .slice(0, 12)
          .map((filePath) => `\`${filePath}\``)
          .join(", ")}.`
      : null,
  ].filter(Boolean)

  const observabilityLines =
    observabilityImpact.length > 0
      ? [
          `- Adjusts release or observability wiring in ${observabilityImpact
            .map((filePath) => `\`${filePath}\``)
            .join(", ")}.`,
        ]
      : ["None"]

  const envLines =
    envImpact.length > 0
      ? [
          `- Updates CI, deployment, or config surfaces in ${envImpact
            .map((filePath) => `\`${filePath}\``)
            .join(", ")}.`,
        ]
      : ["None"]

  const validationLines = [
    "- `npm run typecheck`",
    "- `npm test`",
    "- `npm run build`",
  ]

  const sections = new Map([
    ["Summary", summaryLines.length > 0 ? summaryLines.join("\n") : "None"],
    ["User Impact", "None"],
    [
      "Technical Approach",
      technicalLines.length > 0 ? technicalLines.join("\n") : "None",
    ],
    [
      "Observability / Release Impact",
      observabilityLines.join("\n"),
    ],
    ["Env / Config Impact", envLines.join("\n")],
    ["Validation", validationLines.join("\n")],
    ["Preview Notes", "None"],
  ])

  return templateSections.map((heading) => `## ${heading}\n${sections.get(heading) ?? "None"}`)
    .join("\n\n")
    .trim()
}

export function readPullRequestEvent(eventPath = process.env.GITHUB_EVENT_PATH) {
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required to read pull request metadata.")
  }

  return JSON.parse(readFileSync(eventPath, "utf8"))
}

export function readPullRequestMetadata(eventPayload) {
  const pullRequest = eventPayload?.pull_request

  if (!pullRequest) {
    throw new Error("Pull request payload is missing from the GitHub event.")
  }

  return {
    body: pullRequest.body ?? "",
    labels: pullRequest.labels ?? [],
    title: pullRequest.title ?? "",
  }
}

export function createOrUpdatePullRequest(input = {}) {
  const base = input.base ?? "main"
  const branch = input.branch ?? getCurrentBranch()
  const template = input.template ?? readPullRequestTemplate()
  const changedFiles = input.changedFiles ?? getChangedFiles(base)
  const commitSubjects = input.commitSubjects ?? getCommitSubjects(base)
  const title = input.title ?? suggestPullRequestTitle({ changedFiles, commitSubjects })
  const body = input.body ?? renderPullRequestBody({
    base,
    branch,
    changedFiles,
    commitSubjects,
    template,
  })
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), "ship-pr-"))
  const bodyFile = path.join(tempDirectory, "body.md")

  writeFileSync(bodyFile, `${body}\n`)

  const existingPullRequests = runJsonCommand("gh", [
    "pr",
    "list",
    "--base",
    base,
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number,isDraft,url",
  ])

  if (Array.isArray(existingPullRequests) && existingPullRequests.length > 0) {
    const existingPullRequest = existingPullRequests[0]

    runCommand("gh", [
      "pr",
      "edit",
      String(existingPullRequest.number),
      "--title",
      title,
      "--body-file",
      bodyFile,
    ])

    if (input.ready === true && existingPullRequest.isDraft) {
      runCommand("gh", ["pr", "ready", String(existingPullRequest.number)])
    }

    return {
      action: "updated",
      body,
      number: existingPullRequest.number,
      title,
      url: existingPullRequest.url,
    }
  }

  const createArgs = [
    "pr",
    "create",
    "--base",
    base,
    "--head",
    branch,
    "--title",
    title,
    "--body-file",
    bodyFile,
  ]

  if (input.ready !== true) {
    createArgs.push("--draft")
  }

  const url = runCommand("gh", createArgs)

  return {
    action: "created",
    body,
    title,
    url,
  }
}
