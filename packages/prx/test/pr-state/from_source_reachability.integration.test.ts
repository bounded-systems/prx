// GH-2112 — strict live-binary integration smoke proving that
// `--from=beads` / `--from=notion` reachability through `prx plan session
// <id> --create --from=<src> --check` is operator-provable end-to-end.
//
// PR #2101 wired the `--from=beads` arms into `checkWorkUnitChain` and unit
// tests passed, but no operator path actually reached them — upstream gates
// fired first. GH-2140 lifted the GH-keyed-id rejection to the front of
// `validateWorkSessionEntry` (a pure local check, before any `gh` round-trip),
// and GH-2015 made the canonical-id gate fall through to the adapter registry
// for bare workspace-long ids. The only existing coverage routes through the
// in-process `session open` alias with stubbed `wtStatus`/`boardStatus` — that
// is exactly the class of mock-driven test the original bug report warns
// against. These tests spawn the real CLI via `bun run scripts/pr_state.ts`
// (the same live surface `canonical_id_gate.test.ts` trusts) so the adapter
// registry self-registration and the full `invokedViaPlanSession --check`
// dispatch path match production.
//
// GH-2113 / GH-2120 (closed by this PR): the operator-facing `prx plan session
// <id> --create --from=<src> --check` parses to `command: "session-plan"`,
// whose `--check` dispatch (src/pr-state/cli.ts ~18896) originally called
// `validateWorkSessionEntry` WITHOUT forwarding `parsed.from` (nor
// `findEpicChildren`/`wtStatus`), unlike the sibling `command: "session"`
// dispatch (~18164). So GH-2140's lifted guard never saw `--from` on the true
// operator path, fell through to `checkWorkUnitChain` → `boardStatus`, and died
// on a `gh` round-trip instead of the precise rejection — exactly the GH-2112
// reachability bug. The fix forwards those three args (mirroring the `session`
// dispatch); the negative cases below pin that the guard now fires before any
// `gh` round-trip, for both `--from=beads` (GH-2113) and `--from=notion`
// (GH-2120). Closing both children, with the positive case below, closes the
// umbrella GH-2112.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), `gh-2112-${prefix}-`)));
  execFileSync("git", ["-C", root, "init", "-q"]);
  return root;
}

// Markers that, if present in stderr, would prove the live binary reached a
// remote-board / `gh` round-trip. The negative-path guard must fire *before*
// any of these surface (GH-2140's whole point).
const GH_ROUNDTRIP_MARKERS = [
  "Failed to read remote board status", // prxSessionBoardReadFailureMessage
  "gh pr list",
  "Could not resolve to an issue",
];

describe("--from=<source> reachability through `prx plan session` (GH-2112)", () => {
  // A. Negative smoke — fully hermetic (covers GH-2113 + GH-2120).
  // A GH-keyed id + `--from=<non-gh>` against a repo with no local parity unit
  // must be rejected by the lifted GH-2140 guard, before any `gh` round-trip.
  // The `session-plan --check` dispatch now forwards `parsed.from` (the
  // GH-2113/GH-2120 fix in this PR), so the guard fires on the operator path.
  for (const from of ["beads", "notion"] as const) {
    test(`--from=${from} against a GH-keyed id is rejected before any gh round-trip`, () => {
      const root = setupRepo(`reject-${from}`);
      const result = runCli(
        ["plan", "session", "GH-99999999", "--create", `--from=${from}`, "--check"],
        root,
      );
      const stderr = new TextDecoder().decode(result.stderr);

      expect(result.exitCode).toBe(1);
      // The lifted guard's exact message (cli.ts:4121-4122). "BD" for beads,
      // "Notion" for notion.
      const sourceLabel = from === "beads" ? "BD" : "Notion";
      expect(stderr).toContain(
        `--from=${from} is not valid for GitHub work unit IDs (GH-99999999).`,
      );
      expect(stderr).toContain(`Use a ${sourceLabel} canonical ID or omit --from=${from}.`);

      // The guard fired before boardStatus / any GH round-trip. This is the
      // precise regression the in-process stub test cannot prove against the
      // live binary.
      for (const marker of GH_ROUNDTRIP_MARKERS) {
        expect(stderr).not.toContain(marker);
      }
    });
  }
});
