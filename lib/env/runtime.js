// Runtime env schema. Replace this file with your project's real validation.
//
// The contract expected by `scripts/check-runtime-env.mjs`:
//
//   validateRuntimeEnv({ target, mode }) -> {
//     ok: boolean,
//     problems: Array<{ name: string, reason: string }>,
//   }
//
//   buildRuntimeEnvValidationMessage(result) -> string
//
// The example below uses no external dependencies so the template works out
// of the box. Swap it for Zod / Valibot / Yup / Standard Schema and your real
// variable set when you wire up the app.

const REQUIRED_KEYS = {
  production: ["DATABASE_URL", "NEXT_PUBLIC_APP_URL"],
  preview: ["DATABASE_URL", "NEXT_PUBLIC_APP_URL"],
  development: ["DATABASE_URL"],
  ci: ["DATABASE_URL"],
}

function looksLikeUrl(value) {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

export function validateRuntimeEnv({ target = "production" } = {}) {
  const required = REQUIRED_KEYS[target] ?? REQUIRED_KEYS.production
  const problems = []

  for (const name of required) {
    const value = process.env[name]

    if (!value) {
      problems.push({ name, reason: "missing or empty" })
      continue
    }

    if (name.endsWith("_URL") && !looksLikeUrl(value)) {
      problems.push({ name, reason: "must be a valid URL" })
    }
  }

  return { ok: problems.length === 0, problems, target }
}

export function buildRuntimeEnvValidationMessage(result) {
  if (result.ok) {
    return `Runtime env validation passed for target=${result.target}.`
  }

  return `Runtime env validation failed for target=${result.target} (${result.problems.length} problem(s)).`
}
