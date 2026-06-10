/**
 * prx capabilities — the OCAP self-report surface.
 *
 * The Chinese-Room problem: an agent launched inside a sealed box (claude-box)
 * will happily *attempt* `prx next`, `prx beads ready`, … because it assumes it
 * can — then discovers, one opaque `Executable not found` / `not a git
 * repository` at a time, that it can't. The room (claude-box) enforces the
 * capability boundary; this command is the room *telling the man how to
 * translate*: an honest, up-front map of what the agent CAN do, what it CANNOT,
 * and — for each missing capability — how to obtain it.
 *
 * Design constraints:
 *   - Zero-dependency. Every probe degrades gracefully; nothing here throws when
 *     a binary is absent or the cwd is not a repo. That is the whole point — the
 *     report has to work in exactly the bare box where everything else fails.
 *   - Pure-ish + injectable. All ambient reads (PATH probe, fs, cwd, home) come
 *     through `CapabilityDeps` so the mapping is unit-testable without a real
 *     box.
 */

import { existsSync as realExistsSync, readFileSync as realReadFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getEnv } from "@bounded-systems/env";
import { homeDir as osHomeDir } from "@bounded-systems/host";
import { localProcExecutor } from "@bounded-systems/proc";

const proc = localProcExecutor();

export type CapabilityStatus = "available" | "unavailable";

export type Capability = {
  /** Stable machine id (`git`, `git-repo`, `bd`, `gh`, `repos`, `claude-lsp`). */
  id: string;
  /** Human-readable label. */
  label: string;
  status: CapabilityStatus;
  /** What the probe found (resolved path, repo root, count, or the miss reason). */
  detail: string;
  /** prx verb families this capability unlocks. */
  grants: string[];
  /** How to obtain it — the "translation" the room hands the man. `null` when present. */
  enable: string | null;
};

export type CapabilityReport = {
  capabilities: Capability[];
  available: string[];
  unavailable: string[];
};

/** PATH-resolution seam — `command -v <bin>` via /bin/sh, never throws. */
export type CapabilityExec = (req: {
  command: string;
  args: string[];
}) => Promise<{ status: number; stdout: string }>;

export type CapabilityDeps = {
  exec: CapabilityExec;
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  cwd: string;
  homeDir: string | null;
};

export function defaultCapabilityDeps(): CapabilityDeps {
  return {
    exec: (req) => proc.exec(req),
    existsSync: realExistsSync,
    readFileSync: (p) => realReadFileSync(p, "utf8"),
    cwd: process.cwd(),
    homeDir: getEnv("HOME") ?? osHomeDir(),
  };
}

async function onPath(binary: string, exec: CapabilityExec): Promise<string | null> {
  // `command -v` is a shell builtin; the binary names are fixed constants, so
  // the interpolation is safe. A miss returns nonzero — it never throws, which
  // is what keeps the whole report safe inside a bare box.
  try {
    const result = await exec({ command: "/bin/sh", args: ["-c", `command -v ${binary}`] });
    if (result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * fs-only git-working-tree detection: walk up from cwd looking for a `.git`
 * marker. Deliberately does NOT shell out to `git rev-parse` — in a box where
 * git itself is absent we still want an honest answer, and a directory walk has
 * no external dependency.
 */
function gitRepoRoot(cwd: string, existsSync: (p: string) => boolean): string | null {
  let dir = cwd;
  // Bounded walk to the filesystem root.
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Count registered repos from the prx inventory index, if one is reachable. */
function reposConfigured(deps: CapabilityDeps): { count: number; indexPath: string } | null {
  const candidates: string[] = [];
  const repoRoot = gitRepoRoot(deps.cwd, deps.existsSync);
  if (repoRoot) candidates.push(join(repoRoot, ".prx", "repos", "index.json"));
  if (deps.homeDir) {
    candidates.push(join(deps.homeDir, ".local", "state", "prx", "repos", "index.json"));
  }
  for (const indexPath of candidates) {
    if (!deps.existsSync(indexPath)) continue;
    try {
      const parsed = JSON.parse(deps.readFileSync(indexPath)) as { repos?: unknown[] };
      const count = Array.isArray(parsed.repos) ? parsed.repos.length : 0;
      return { count, indexPath };
    } catch {
      // Unreadable/corrupt index → treat as not-configured rather than throw.
      return { count: 0, indexPath };
    }
  }
  return null;
}

export async function probeCapabilities(
  deps: CapabilityDeps = defaultCapabilityDeps(),
): Promise<CapabilityReport> {
  const [git, bd, gh, tsls, tsserver] = await Promise.all([
    onPath("git", deps.exec),
    onPath("bd", deps.exec),
    onPath("gh", deps.exec),
    onPath("typescript-language-server", deps.exec),
    onPath("tsserver", deps.exec),
  ]);

  const repoRoot = gitRepoRoot(deps.cwd, deps.existsSync);
  const repos = reposConfigured(deps);

  const capabilities: Capability[] = [
    {
      id: "git",
      label: "git CLI",
      status: git ? "available" : "unavailable",
      detail: git ? `resolved ${git}` : "no `git` on PATH",
      grants: ["repo materialization", "branch/worktree ops", "prx repo add/adopt"],
      enable: git ? null : "Install git (e.g. `nix profile install nixpkgs#git` or your OS package manager).",
    },
    {
      id: "git-repo",
      label: "git working tree (cwd is inside a repo)",
      status: repoRoot ? "available" : "unavailable",
      detail: repoRoot ? `repo root ${repoRoot}` : `cwd is not inside a git repo (${deps.cwd})`,
      grants: ["prx next", "prx do", "prx derive *", "prx plan session", "prx status"],
      enable: repoRoot
        ? null
        : "cd into a repo worktree, or add one with `prx repo add <git-url>` then cd into it.",
    },
    {
      id: "bd",
      label: "beads CLI (bd)",
      status: bd ? "available" : "unavailable",
      detail: bd ? `resolved ${bd}` : "no `bd` on PATH",
      grants: ["prx beads *", "prx derive ready", "work-graph reads (bd ready/list/show)"],
      enable: bd
        ? null
        : "Install the beads CLI (`bd`) and ensure a `.beads/*.db` is reachable, or provision via `prx beads provision`.",
    },
    {
      id: "gh",
      label: "GitHub CLI (gh)",
      status: gh ? "available" : "unavailable",
      detail: gh ? `resolved ${gh}` : "no `gh` on PATH",
      grants: ["prx scout * (issues/ci/checks/logs/comments)", "GitHub-backed reads"],
      enable: gh
        ? null
        : "Install + authenticate the GitHub CLI (`gh auth login`). Note: presence only; auth is not probed here.",
    },
    {
      id: "repos",
      label: "registered repos (prx inventory)",
      status: repos && repos.count > 0 ? "available" : "unavailable",
      detail: repos
        ? `${repos.count} repo(s) in ${repos.indexPath}`
        : "no prx repo index found",
      grants: ["repo routing", "cross-repo sync", "prx next portfolio mode"],
      enable: repos && repos.count > 0
        ? null
        : "Register a repo with `prx repo add <git-url>`. `prx repo list` shows what's known.",
    },
    {
      id: "claude-lsp",
      label: "Claude runtime LSP (typescript-language-server, tsserver)",
      status: tsls && tsserver ? "available" : "unavailable",
      detail: tsls && tsserver
        ? "both LSP binaries resolved"
        : `missing: ${[!tsls && "typescript-language-server", !tsserver && "tsserver"].filter(Boolean).join(", ")}`,
      grants: ["non-interactive `claude` sessions (prx claude / implement / plan agent)"],
      enable: tsls && tsserver
        ? null
        : "Install via home-manager (programs.claude-runtime.enable = true) or `npm i -g typescript typescript-language-server`.",
    },
  ];

  return {
    capabilities,
    available: capabilities.filter((c) => c.status === "available").map((c) => c.id),
    unavailable: capabilities.filter((c) => c.status === "unavailable").map((c) => c.id),
  };
}

export function formatCapabilities(
  report: CapabilityReport,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(report);
  }

  const lines: string[] = ["prx capabilities — what this box can and cannot do", "=================================================="];

  const available = report.capabilities.filter((c) => c.status === "available");
  const unavailable = report.capabilities.filter((c) => c.status === "unavailable");

  lines.push("", "✓ Available");
  if (available.length === 0) {
    lines.push("  (none — this is a bare box)");
  } else {
    for (const cap of available) {
      lines.push(`  ✓ ${cap.label} — ${cap.detail}`);
      lines.push(`      unlocks: ${cap.grants.join(", ")}`);
    }
  }

  lines.push("", "✗ Unavailable");
  if (unavailable.length === 0) {
    lines.push("  (none — fully provisioned)");
  } else {
    for (const cap of unavailable) {
      lines.push(`  ✗ ${cap.label} — ${cap.detail}`);
      lines.push(`      would unlock: ${cap.grants.join(", ")}`);
      if (cap.enable) lines.push(`      to enable: ${cap.enable}`);
    }
  }

  return lines.join("\n");
}
