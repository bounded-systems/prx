// GH-1423: validator — pure-function assertions over rendered markdown.
//
// Each assertion takes `(markdown, file, inputs) → AssertionResult[]` so the
// caller can fail-loudly with the offending file/line and the suggested
// follow-up. The output shape lines up with `RULES_ASSERTION_FAILED` events
// (see `../events.ts`) — the machine wrapping these functions emits one
// event per result.
//
// Fence convention (per `docs/prx/rules-build-substrate.md` §3.6):
//
//   <!-- assert:alias -->
//   ...prose mentioning `za` / `zb` / `zc`...
//   <!-- /assert:alias -->
//
//   <!-- assert:worktree-gesture -->
//   ...prose mentioning a worktree-switching gesture...
//   <!-- /assert:worktree-gesture -->
//
//   <!-- assert:none -->
//   ...prose the validator should skip entirely...
//   <!-- /assert:none -->
//
// `verb-exists` is the one assertion that runs *outside* fences too — every
// backticked `prx <verb>` token in the document is checked unless it falls
// inside an `<!-- assert:none -->` fence.

import type {
  AliasSupply,
  VerbSupply,
  WorktreeGestures,
} from "../schemas/inputs.ts";

export type AssertionRule =
  | "verb-exists"
  | "alias-exists"
  | "worktree-gesture-resolves";

export type AssertionFailure = {
  rule: AssertionRule;
  subject: string;
  file: string;
  line: number;
};

/**
 * Non-prx commands that legitimately appear in rule prose. Anything outside
 * this set + `VerbSupply` triggers a `verb-exists` failure.
 */
export const NON_PRX_VERB_ALLOWLIST: ReadonlySet<string> = new Set([
  "bd",
  "gh",
  "git",
  "home-manager",
  "nix",
  "node",
  "npm",
  "bun",
  "tmux",
  "claude",
  "ls",
]);

type Fence =
  | { kind: "alias"; startLine: number; endLine: number }
  | { kind: "worktree-gesture"; startLine: number; endLine: number }
  | { kind: "none"; startLine: number; endLine: number };

function scanFences(markdown: string): Fence[] {
  const fences: Fence[] = [];
  const lines = markdown.split("\n");
  type OpenKind = "alias" | "worktree-gesture" | "none";
  const open: { kind: OpenKind; startLine: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const oneIndexed = i + 1;
    const openMatch = line.match(
      /<!--\s*assert:(alias|worktree-gesture|none)\s*-->/,
    );
    if (openMatch) {
      open.push({ kind: openMatch[1] as OpenKind, startLine: oneIndexed });
      continue;
    }
    const closeMatch = line.match(
      /<!--\s*\/assert:(alias|worktree-gesture|none)\s*-->/,
    );
    if (closeMatch) {
      const kind = closeMatch[1] as OpenKind;
      for (let j = open.length - 1; j >= 0; j--) {
        if (open[j]!.kind === kind) {
          const [popped] = open.splice(j, 1);
          fences.push({
            kind: popped!.kind,
            startLine: popped!.startLine,
            endLine: oneIndexed,
          });
          break;
        }
      }
    }
  }
  return fences;
}

function lineFallsInFence(line: number, fences: Fence[], kind: Fence["kind"]): boolean {
  for (const f of fences) {
    if (f.kind !== kind) continue;
    if (line >= f.startLine && line <= f.endLine) return true;
  }
  return false;
}

const BACKTICK_TOKEN_RE = /`([^`\n]+)`/g;

/**
 * `verb-exists` assertion (PR-1).
 *
 * Every backticked `prx <verb>` (and optionally `prx <parent> <verb>`) must
 * resolve against `VerbSupply` or the non-prx allowlist. Tokens inside
 * `<!-- assert:none -->` fences are skipped — that fence is the renderer's
 * escape hatch for example/illustrative prose.
 */
export function verbExists(
  markdown: string,
  file: string,
  supply: VerbSupply,
): AssertionFailure[] {
  const fences = scanFences(markdown);
  const allowed = new Set<string>([
    ...supply.map((v) => v.name),
    ...NON_PRX_VERB_ALLOWLIST,
  ]);

  const failures: AssertionFailure[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const oneIndexed = i + 1;
    if (lineFallsInFence(oneIndexed, fences, "none")) continue;
    const line = lines[i]!;
    BACKTICK_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BACKTICK_TOKEN_RE.exec(line)) !== null) {
      const token = m[1]!.trim();
      const parts = token.split(/\s+/);
      if (parts[0] !== "prx") {
        // Non-prx tokens are checked against the allowlist only; an
        // unfamiliar single token does not fail the assertion (would be
        // far too noisy on backticked code expressions).
        continue;
      }
      // Placeholder tokens like `prx <verb>` or `prx [GH-NNN]` are
      // illustrative meta-syntax, not real verb claims — skip them.
      if (parts.slice(1).some((p) => /^[<\[]/.test(p))) {
        continue;
      }
      // Try longest match first: `prx a b c` → `prx a b` → `prx a`.
      let candidate: string | null = null;
      for (let n = parts.length - 1; n >= 1; n--) {
        const slice = parts.slice(1, n + 1).join(" ");
        if (allowed.has(slice)) {
          candidate = slice;
          break;
        }
      }
      if (candidate === null) {
        failures.push({
          rule: "verb-exists",
          subject: token,
          file,
          line: oneIndexed,
        });
      }
    }
  }
  return failures;
}

/**
 * `alias-exists` assertion (PR-1, fence-gated).
 *
 * Backticked tokens inside `<!-- assert:alias -->` fences must appear in
 * `AliasSupply`. PR-1 ships with an empty supply so every aliased token
 * inside such a fence fails — by design. The canonical drift case
 * (`za`/`zb`/`zc` at `claude/rules/core.md:96`) is the spike's red test.
 */
export function aliasExists(
  markdown: string,
  file: string,
  supply: AliasSupply,
): AssertionFailure[] {
  const fences = scanFences(markdown).filter((f) => f.kind === "alias");
  if (fences.length === 0) return [];
  const known = new Set<string>(supply.map((a) => a.name));

  const failures: AssertionFailure[] = [];
  const lines = markdown.split("\n");
  for (const f of fences) {
    for (let i = f.startLine; i <= f.endLine; i++) {
      const line = lines[i - 1] ?? "";
      BACKTICK_TOKEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = BACKTICK_TOKEN_RE.exec(line)) !== null) {
        const token = m[1]!.trim();
        // Skip multi-word tokens — alias tokens are single shell symbols.
        if (/\s/.test(token)) continue;
        if (known.has(token)) continue;
        failures.push({
          rule: "alias-exists",
          subject: token,
          file,
          line: i,
        });
      }
    }
  }
  return failures;
}

/**
 * `worktree-gesture-resolves` assertion (PR-1, fence-gated).
 *
 * Same structure as `aliasExists` but draws against `WorktreeGestures`.
 */
export function worktreeGestureResolves(
  markdown: string,
  file: string,
  gestures: WorktreeGestures,
): AssertionFailure[] {
  const fences = scanFences(markdown).filter(
    (f) => f.kind === "worktree-gesture",
  );
  if (fences.length === 0) return [];
  const known = new Set<string>(gestures.map((g) => g.name));

  const failures: AssertionFailure[] = [];
  const lines = markdown.split("\n");
  for (const f of fences) {
    for (let i = f.startLine; i <= f.endLine; i++) {
      const line = lines[i - 1] ?? "";
      BACKTICK_TOKEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = BACKTICK_TOKEN_RE.exec(line)) !== null) {
        const token = m[1]!.trim();
        if (/\s/.test(token)) continue;
        if (known.has(token)) continue;
        failures.push({
          rule: "worktree-gesture-resolves",
          subject: token,
          file,
          line: i,
        });
      }
    }
  }
  return failures;
}
