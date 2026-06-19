/**
 * GH-login identity resolver (GH-2012).
 *
 * The one chokepoint that answers "which GitHub login is the operator running
 * this process?". `prx delegate assign --self <id>` writes the result into
 * bd's `assignee` column; the bd→GH mirror (GH-2011) then projects that
 * value through the canonical adapter. The column must be GH-login-shaped
 * for the projection to land on a real GitHub user — display-name strings
 * silently no-op or 422 on the mirror push.
 *
 * Contract:
 *   1. `gh auth status` non-zero → refuse with a named message. No fallback
 *      to env (`PRX_OPERATOR`/`$USER`) or `git config user.name`. The bug
 *      that motivated this resolver (GH-2012) reads strictest on no-fallback:
 *      a display-name slipping through is the failure mode being eliminated.
 *   2. `gh api user --jq .login` empty/null → refuse with a named message.
 *   3. Otherwise return the trimmed login.
 *
 * Caching: per-process. The first successful resolve caches; subsequent
 * calls in the same process return the cached login without re-spawning
 * `gh`. Cross-process caching is intentionally absent (no on-disk cache):
 * an operator who re-`gh auth login`s as a different user should be picked
 * up on the next invocation.
 *
 * Kept out of `src/tools/gh.ts`'s `execGh` allowlist: that surface admits
 * only the `pr` and `issue` groups under a tightly reviewed policy (GH-874).
 * Adding `api`/`auth` groups for two read-only identity calls would enlarge
 * the policy surface unnecessarily.
 */
import { spawnCapture } from "@bounded-systems/proc";

export type GhLoginResult = { ok: true; login: string } | { ok: false; message: string };

export type ResolveGhLoginDeps = {
  runGhAuthStatus?: () => { ok: boolean };
  runGhApiUserLogin?: () => string | null;
};

let cachedLogin: string | null = null;

export function resetGhLoginCacheForTests(): void {
  cachedLogin = null;
}

// `spawn` is injectable (defaults to the real proc) so the gh-output handling
// is testable without spawning a live gh / hitting the GitHub API.
export function runGhAuthStatus(spawn: typeof spawnCapture = spawnCapture): { ok: boolean } {
  const result = spawn(["gh", "auth", "status"]);
  if (result.error || result.signal) return { ok: false };
  return { ok: (result.status ?? 1) === 0 };
}

export function runGhApiUserLogin(spawn: typeof spawnCapture = spawnCapture): string | null {
  const result = spawn(["gh", "api", "user", "--jq", ".login"]);
  if (result.error || result.signal) return null;
  if ((result.status ?? 1) !== 0) return null;
  const trimmed = (result.stdout ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveGhLogin(deps: ResolveGhLoginDeps = {}): GhLoginResult {
  if (cachedLogin !== null) {
    return { ok: true, login: cachedLogin };
  }
  const auth = (deps.runGhAuthStatus ?? runGhAuthStatus)();
  if (!auth.ok) {
    return {
      ok: false,
      message: "gh auth status failed — run `gh auth login` (no fallback to env or git config)",
    };
  }
  const login = (deps.runGhApiUserLogin ?? runGhApiUserLogin)();
  if (login === null || login.length === 0) {
    return {
      ok: false,
      message: "gh api user --jq .login returned no login",
    };
  }
  cachedLogin = login;
  return { ok: true, login };
}
