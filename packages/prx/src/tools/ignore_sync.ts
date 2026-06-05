/**
 * ensure-prx-excludes — idempotently maintain prx-relevant entries in
 * the per-clone `.git/info/exclude` file.
 *
 * Background: Worktrunk's nix-managed config (nix/home-manager/worktrunk.nix)
 * runs `wtctl sync` and `wtctl ignore sync` at multiple lifecycle points;
 * those overwrite `info/exclude` from `.wt.ignore.toml` (or a hardcoded
 * fallback) and drop any rules wtctl does not know about. Historically a
 * standalone bash hook (`~/.config/worktrunk/hooks/ensure-pr-exclude.sh`)
 * remediated `.pr/` after wtctl ran but ignored `.prx/`. This module is the
 * in-tree replacement that handles both, mirroring the prx workspace.track
 * semantics:
 *
 *   - workspace.track = true (default, ai-home posture):
 *       `.prx/` is allowlist-tracked via .prx/.gitignore, so it must NOT be
 *       in info/exclude. Strip any legacy `.prx/` line. Always ensure `.pr/`.
 *   - workspace.track = false (target-repo / opt-in):
 *       `.prx/` is ephemeral worktree state. Ensure both `.pr/` and `.prx/`
 *       are present in info/exclude.
 *
 * Same helper is invoked from `prx init` (so its existing `excludeRules`/
 * `excludeUpdatedRules`/`excludeRemovedRules` reporting stays intact) and
 * from `prx tools wt ensure-prx-excludes` (the worktrunk hook entry-point).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { spawnCapture } from "@bounded-systems/proc";

export type EnsurePrxExcludesOptions = {
  /** Resolved repo root (`git rev-parse --show-toplevel`). */
  repoRoot: string;
  /**
   * When true (default), `.prx/` is expected to be allowlist-tracked in the
   * working tree — strip any `.prx/` from info/exclude. When false, `.prx/`
   * is ephemeral — keep it in info/exclude.
   */
  workspaceTrack: boolean;
};

export type EnsurePrxExcludesResult = {
  excludePath: string | null;
  excludeRules: string[];
  excludeUpdatedRules: string[];
  excludeRemovedRules: string[];
};

function resolveCommonDir(repoRoot: string): string | null {
  const result = spawnCapture(["git", "rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
  });
  if (result.status !== 0) return null;
  const out = result.stdout.trim();
  if (!out) return null;
  // git emits a relative path when invoked inside the working tree; resolve
  // against repoRoot so callers always get an absolute path.
  return out.startsWith("/") ? out : join(repoRoot, out);
}

export function ensurePrxExcludes(opts: EnsurePrxExcludesOptions): EnsurePrxExcludesResult {
  const { repoRoot, workspaceTrack } = opts;
  const excludeRules = workspaceTrack ? [".pr/"] : [".pr/", ".prx/"];
  const excludeUpdatedRules: string[] = [];
  const excludeRemovedRules: string[] = [];

  const commonDir = resolveCommonDir(repoRoot);
  if (!commonDir) {
    return { excludePath: null, excludeRules, excludeUpdatedRules, excludeRemovedRules };
  }

  const excludePath = join(commonDir, "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });

  // Read once (empty on missing) instead of existsSync-then-read, so the
  // writeFileSync below isn't racing an existence check (CodeQL
  // js/file-system-race).
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    existing = "";
  }
  let lines = existing.split(/\r?\n/);

  if (workspaceTrack) {
    const filteredLines = lines.filter((line) => line.trim() !== ".prx/");
    if (filteredLines.length !== lines.length) {
      excludeRemovedRules.push(".prx/");
      lines = filteredLines;
    }
  }

  const missingRules = excludeRules.filter(
    (rule) => !lines.some((line) => line.trim() === rule),
  );

  if (missingRules.length > 0 || excludeRemovedRules.length > 0) {
    const body = lines.filter((line) => line.length > 0);
    const trailing = body.length > 0 ? "\n" : "";
    const append = missingRules.length > 0 ? `${missingRules.join("\n")}\n` : "";
    writeFileSync(excludePath, `${body.join("\n")}${trailing}${append}`);
    excludeUpdatedRules.push(...missingRules);
  }

  return { excludePath, excludeRules, excludeUpdatedRules, excludeRemovedRules };
}
