/**
 * @bounded-systems/auth — the credential capability.
 *
 * Auth is ambient authority — the most load-bearing hidden dependency of all.
 * A package that reads GITHUB_TOKEN out of the environment has silently
 * acquired the right to act as you. Routing token access through an explicit
 * import makes that authority a visible dependency edge: who can authenticate
 * is exactly who imports @bounded-systems/auth. (Tokens resolve via @bounded-systems/env, the one
 * sanctioned env reader; callers with their own env seam may inject it.)
 */
import { processEnv } from "@bounded-systems/env";

export type AuthService = "github" | "notion";

// Per-service token env keys, in precedence order. GitHub follows the
// conventional GH_TOKEN → GITHUB_TOKEN order (matching gh).
const TOKEN_KEYS: Record<AuthService, readonly string[]> = {
  github: ["GH_TOKEN", "GITHUB_TOKEN"],
  notion: ["NOTION_TOKEN"],
};

/**
 * Resolve a service credential, or null when none is configured. Reads the
 * ambient environment via @bounded-systems/env by default; callers that own an injectable
 * env seam (for hermetic tests) may pass one explicitly.
 */
export function authToken(
  service: AuthService,
  env: NodeJS.ProcessEnv = processEnv(),
): string | null {
  for (const key of TOKEN_KEYS[service]) {
    const value = env[key];
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/** Throwing variant for code paths that cannot proceed unauthenticated. */
export function requireAuthToken(
  service: AuthService,
  env: NodeJS.ProcessEnv = processEnv(),
): string {
  const token = authToken(service, env);
  if (token === null) {
    throw new Error(`no credential configured for service: ${service}`);
  }
  return token;
}
