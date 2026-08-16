// GH-2015 — regression net for the CLI canonical-id gate's adapter
// fall-through. The static `combinedCanonicalIdPattern()` union cannot
// encode cwd-dependent surface ids (BD's bare-workspace arm reads
// `bd_workspace_prefix` from `.prx/repos/index.json`), so the gate falls
// through to `adapterForCanonicalId(id)` when the static regex misses.
//
// These tests exercise the gate end-to-end through `bun run scripts/pr_state.ts`
// so the adapter registry self-registration path (`src/adapters/beads.ts`)
// matches production. `prx audit uow <id>` is the cheapest verb that hits
// `parseCanonicalWorkUnitId` early in parsing — the assertions pin on the
// gate's "must match CANONICAL-ID format" error string, not on the verb's
// downstream behaviour.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(repoRoot, "scripts/pr_state.ts");

function runCli(args: string[], cwd: string) {
  return Bun.spawnSync({
    cmd: ["bun", "run", scriptPath, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function setupRepo(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `gh-2015-${prefix}-`)));
  execFileSync("git", ["-C", root, "init", "-q"]);
  return root;
}

function writeIndexWithBdPrefix(root: string, bdWorkspacePrefix: string): void {
  mkdirSync(join(root, ".prx", "repos"), { recursive: true });
  const inventory = {
    roots: [root],
    repos: [
      {
        name: "test-repo",
        commonDir: root,
        kind: "bare" as const,
        mainWorktree: null,
        worktrees: [],
        localOnlyBranches: [],
        findings: [],
        remotes: [],
        primaryRemote: null,
        upstreamRemote: null,
        bd_workspace_prefix: bdWorkspacePrefix,
      },
    ],
  };
  writeFileSync(join(root, ".prx", "repos", "index.json"), JSON.stringify(inventory, null, 2));
}

describe("CLI canonical-id gate adapter fall-through (GH-2015)", () => {
  // GH-1012: the "bare bd workspace id is accepted" case is gone — the bd
  // adapter fall-through was removed with beads, so a bd-shaped id no longer
  // clears the gate. The rejection path (with the beads-id hint) is kept below.

  test("bare bd workspace id is rejected with an actionable unregistered-prefix hint when no covering repo prefix is registered", () => {
    // Default identity + no `.prx/repos/index.json` (or one whose prefix
    // does not cover the cwd). The BD adapter's `matchesSurfaceId` returns
    // false; the static regex still misses; the gate refuses. Because the id
    // has the bd-short shape (`<prefix>-<rest>`), the gate emits the
    // unregistered-`bd_workspace_prefix` remedy (not the bare "must match
    // CANONICAL-ID format" line, which misled before).
    const root = setupRepo("bare-refuse");
    const result = runCli(["audit", "uow", "demo-repo-aqg"], root);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain('"demo-repo-aqg" looks like a beads id');
    expect(stderr).toContain("bd workspace prefix is not registered");
    expect(stderr).toContain("prx repo backfill");
    // The canonical-format clause is still present as the fallback explanation.
    expect(stderr).toContain("must match CANONICAL-ID format");
  });

  test("custom [sources.<name>] overlay wins outright over adapter fall-through", () => {
    // GH-1421: per-repo `[sources.<name>]` is the operator's explicit
    // "only these shapes" pin — the adapter fall-through is gated on
    // `activeCanonicalIsDefault` so it does not widen a custom overlay.
    // Even with the bd_workspace_prefix registered, the bare id must refuse.
    const root = setupRepo("overlay-wins");
    writeIndexWithBdPrefix(root, "demo-repo");
    writeFileSync(
      join(root, "prx.toml"),
      ["[sources.github]", 'kind = "github"', 'canonical_id_pattern = "^GH-\\\\d+$"', ""].join(
        "\n",
      ),
    );
    const result = runCli(["audit", "uow", "demo-repo-aqg"], root);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("audit uow must match CANONICAL-ID format");
  });

  test("GH-<n> regression — static fast-path still accepts the canonical shape", () => {
    // Default identity, no special setup. The static
    // `combinedCanonicalIdPattern()` matches before the adapter fall-through
    // runs at all, so `GH-1` behaviour is unchanged.
    const root = setupRepo("gh-fastpath");
    const result = runCli(["audit", "uow", "GH-1"], root);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).not.toContain("must match CANONICAL-ID format");
  });
});
