/**
 * Self-operator resolver (GH-1874, contract corrected by GH-2012).
 *
 * `prx delegate assign --self <id>` and (future) `prx delegate next --claim`
 * need a single canonical answer to "who is the operator running this
 * process?". The identity is the operator's **GitHub login** — that is the
 * shape bd's `assignee` column must hold for the bd→GH mirror's `push()`
 * (GH-2011) to project onto a real GitHub user. A display-name string
 * (the old `git config user.name` fallback) silently no-ops or 422s on the
 * mirror push, which is the bug GH-2012 closed.
 *
 * Resolution: `gh api user --jq .login`, cached per process, refusing on
 * `gh auth status` failure with no fallback. See `./gh_login.ts` for the
 * subprocess wrappers and cache. `PRX_OPERATOR` env, `$USER`, and
 * `git config user.name` are intentionally never consulted.
 */
import { resolveGhLogin as defaultResolveGhLogin } from "./gh_login.ts";

export type ResolveSelfOperatorDeps = {
  resolveGhLogin?: typeof defaultResolveGhLogin;
};

export type ResolveSelfOperatorResult =
  | { ok: true; agent: string }
  | { ok: false; message: string };

export function resolveSelfOperator(
  deps: ResolveSelfOperatorDeps = {},
): ResolveSelfOperatorResult {
  const resolve = deps.resolveGhLogin ?? defaultResolveGhLogin;
  const result = resolve();
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  return { ok: true, agent: result.login };
}
