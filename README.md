# nextjs-vercel-release-templates

Secretless PR CI + release-please + Vercel on-release deploy + nightly Postgres → R2 backups, in one template.

A working extract of the delivery pipeline I run on my Next.js apps. The pattern is well-known piece by piece, but the wiring (especially the secret boundaries and the `on: release` deploy trigger) takes a while to get right — this repo is that wiring, parametrized.

## The flow

```
  PR  ──►  secretless PR CI  ──►  squash merge to main
                                       │
                                       ▼
                          release-please maintains release PR
                                       │
                                       ▼
                            merge release PR
                                       │
                                       ▼
                      GitHub Release (tag published)
                                       │
                                       ▼
                  on: release ──► production-deploy ──► Vercel + Sentry release
```

A separate scheduled job dumps Postgres to Cloudflare R2 every night.

## Why these choices

**Secretless PR CI.** `pull_request` jobs run with no `VERCEL_*`, no production credentials, no remote env pulls. CI validates a tracked `.env.ci.example` contract, runs tests against a Postgres service container, typechecks, and builds. Real secrets live in protected GitHub Environments and Vercel.

**Deploy on `release`, not on `push: main`.** Merging to `main` does not deploy. A deploy only happens when release-please publishes a GitHub Release — at that point the published tag is known-good, the version in `package.json` is verified, and the `production` environment's secrets are accessed directly by a job that declares `environment: production`. Vercel's git auto-deploy is disabled by `vercel.json` so the only path to prod is the released tag.

**`production-deploy.yml` is a top-level workflow, not `workflow_call`.** `workflow_call` jobs cannot declare `environment: production`, so environment secrets would have to be moved to repo-level (less secure) or passed with `secrets: inherit` (circular). The `on: release` trigger lets the job declare the environment directly.

**Two-step env drift check.** The CI contract check (`env:check:production`) is structural — it validates the tracked `.env.ci.example` against your schema. The local check (`env:check:prod:local --check-vercel`) compares your gitignored `.env.production.local` values against `vercel env ls production` for *name* drift. This is the only setup that works for Sensitive Vercel vars (which can't be retrieved remotely).

## Setup

### 1. Clone and initialize

```bash
gh repo create my-app --template kevod1997/nextjs-vercel-release-templates --private --clone
cd my-app
node scripts/init-template.mjs   # replaces placeholders, then self-destructs
```

The init script asks for `PROJECT_NAME`, `PROJECT_SLUG`, `TAG_PREFIX`, `SENTRY_PROJECT`, `DB_NAME_TEST`. Defaults are derived from the folder name. If you prefer manual setup, grep for `{{` and replace each placeholder, then delete `scripts/init-template.mjs`.

### 2. Replace the env schema stub

`lib/env/runtime.js` is a minimal stub that only checks `DATABASE_URL` and `NEXT_PUBLIC_APP_URL`. Replace it with your real schema (Zod / Valibot / Standard Schema). It must export:

```js
validateRuntimeEnv({ target, mode }) -> { ok, problems: [{ name, reason }] }
buildRuntimeEnvValidationMessage(result) -> string
```

Then fill `.env.ci.example` with placeholder values that pass that schema (URL-shaped strings, secrets that meet your minLength, etc).

### 3. Configure GitHub secrets and vars

Required for **production-deploy** (in `production` environment):

| Name | Type | Where it comes from |
| --- | --- | --- |
| `VERCEL_TOKEN` | secret | Vercel → Settings → Tokens |
| `VERCEL_ORG_ID` | secret | `.vercel/project.json` after `vercel link` |
| `VERCEL_PROJECT_ID` | secret | same as above |

Required for **release-please** (repo-level):

| Name | Type | Where it comes from |
| --- | --- | --- |
| `RELEASE_PLEASE_APP_CLIENT_ID` | var | Your release-please GitHub App's client ID |
| `RELEASE_PLEASE_APP_PRIVATE_KEY` | secret | Private key from the App's settings |

Using a GitHub App (instead of the default `GITHUB_TOKEN`) lets release-please's PR re-trigger workflows. The default token can't.

Required for **db-backup** (repo-level, optional — delete the workflow if not used):

| Name | Type | Where it comes from |
| --- | --- | --- |
| `DATABASE_URL_BACKUP` | secret | Your Postgres connection string. Use a publicly reachable host (Railway: `DATABASE_PUBLIC_URL`, not `*.railway.internal`) |
| `R2_ACCOUNT_ID` | secret | Cloudflare → R2 dashboard |
| `R2_BUCKET` | secret | Bucket name |
| `R2_ACCESS_KEY_ID` | secret | R2 API token |
| `R2_SECRET_ACCESS_KEY` | secret | R2 API token |

### 4. Wire Vercel

```bash
vercel link
vercel env add DATABASE_URL production
# ...repeat for every var your schema requires
```

`vercel.json` already disables git deploys on `main` — don't re-enable them. Production deploys must come from the released tag, not from a git push.

### 5. Create the `production` environment in GitHub

Settings → Environments → New environment → `production`. Add the three `VERCEL_*` secrets there (not at repo level). Add required reviewers if you want manual approval before deploys.

## Anatomy

```
.github/
├── pull_request_template.md     Required PR structure (validated in CI)
└── workflows/
    ├── pr-ci.yml                Secretless PR CI: validate metadata, typecheck, test, build
    ├── release-please.yml       Maintain release PR + tag + GitHub Release
    ├── production-deploy.yml    on: release → vercel deploy --prod + Sentry release
    └── db-backup.yml            Nightly Postgres → Cloudflare R2 (optional)

scripts/
├── ship.mjs                     PR helper + validators called by CI
├── lib/release-automation.js    Conventional-commit, PR-body, env-patch helpers
├── check-runtime-env.mjs        Schema check + Vercel name-drift check
├── ensure-test-db.mjs           Create test DB if missing
├── apply-test-migrations.mjs    Reset schema + replay Drizzle migrations
├── create-secret.mjs            32-byte base64 secret generator
└── init-template.mjs            One-shot template bootstrap (deletes itself)

lib/env/runtime.js               Env schema stub — REPLACE with your real one

vercel.json                      Disable Vercel git auto-deploy on main
release-please-config.json       Release-please package config
.release-please-manifest.json    Tracks current version (auto-updated)
.env.ci.example                  Tracked, non-secret CI env baseline
```

## Local workflow

```bash
# Make changes, commit using conventional commit messages.
npm run env:check:prod:local      # validate values + check Vercel name drift (only when env vars changed)
git push
node scripts/ship.mjs pr --ready  # create or update the PR from the template
# Let PR CI pass, squash-merge to main.
# release-please opens/updates a release PR. Merge it when ready.
# GitHub Release fires → production-deploy.yml runs.
```

## Customization checklist

- [ ] Replace `lib/env/runtime.js` with your real schema.
- [ ] Fill `.env.ci.example` with every required var.
- [ ] If you don't use Drizzle, replace `scripts/apply-test-migrations.mjs` with your migration tool's reset+apply.
- [ ] If you don't need encrypted backups, delete `.github/workflows/db-backup.yml`.
- [ ] In `scripts/lib/release-automation.js`, extend `OBSERVABILITY_PATHS` and `ENV_IMPACT_PATHS` with your project's surfaces.
- [ ] Adjust `pr-ci.yml`'s Postgres image / version if needed.

## License

MIT. See [LICENSE](./LICENSE).
