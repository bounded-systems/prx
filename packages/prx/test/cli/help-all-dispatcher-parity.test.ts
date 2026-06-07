// GH-2129: broad regression guard for help-catalog ⊆ dispatcher parity.
//
// The dolt bug (GH-2129) was an instance of a drift class: a verb advertised
// in the `prx help-all` catalog (src/cli/registry.data.ts) that the namespace
// dispatcher (normalizeNamespaceArgv in src/pr-state/cli.ts) never routes,
// so it dies with `Unknown <parent> subcommand: <verb>`. The dolt-scoped guard
// lives in test/dolt/dispatch-parity.test.ts; this one walks EVERY namespaced
// catalog row and asserts the dispatcher reaches a route without that bare
// `Unknown` error — catching the same class for chain, tmux, repo, and any
// future actor.
//
// KNOWN_DRIFT pins pre-existing instances that are out of scope for GH-2129
// (which is dolt-only). Each entry is a row the catalog advertises but the
// dispatcher still rejects. The test asserts each pinned row STILL drifts, so
// when the owning ticket wires the verb the stale allowlist entry forces a
// failure here and must be removed — the allowlist cannot silently rot.

import { describe, expect, test } from "bun:test";

import { normalizeNamespaceArgv } from "../../src/pr-state/cli.ts";
import { CliError } from "../../src/pr-state/cli-error.ts";
import { prxCommandRegistry } from "../../src/cli/registry.data.ts";

// Pre-existing drift, out of scope for GH-2129 (dolt-only). Same bug family as
// the dolt fix: `map next` / `map sync` are declared in the catalog but the
// `map` dispatcher only routes `create` / `show`.
const KNOWN_DRIFT = new Set<string>(["map next", "map sync"]);

/** Split a catalog row name into its dispatcher argv (parent + verb tokens). */
function rowArgv(name: string, parent: string): string[] {
  const verb = name.startsWith(`${parent} `)
    ? name.slice(parent.length + 1)
    : name;
  return [parent, ...verb.split(" ")];
}

/** True iff rewriting this row's argv throws a bare `Unknown … subcommand`. */
function driftsUnknown(argv: string[]): boolean {
  try {
    normalizeNamespaceArgv(argv);
    return false;
  } catch (err) {
    return err instanceof CliError && /^Unknown .+ subcommand/.test(err.message);
  }
}

const namespacedRows = prxCommandRegistry.filter(
  (row) => row.parent !== undefined,
);

describe("help-all ⊆ dispatcher parity (GH-2129)", () => {
  test("every catalog verb reaches a route except known, pinned drift", () => {
    const unexpected: string[] = [];
    for (const row of namespacedRows) {
      const argv = rowArgv(row.name, row.parent as string);
      if (driftsUnknown(argv) && !KNOWN_DRIFT.has(row.name)) {
        unexpected.push(row.name);
      }
    }
    expect(unexpected).toEqual([]);
  });

  test("the dolt namespace has zero drift (the verb set GH-2129 wired)", () => {
    const doltDrift = namespacedRows
      .filter((row) => row.parent === "dolt")
      .map((row) => rowArgv(row.name, "dolt"))
      .filter(driftsUnknown);
    expect(doltDrift).toEqual([]);
  });

  test("every KNOWN_DRIFT entry still drifts (allowlist cannot rot)", () => {
    for (const name of KNOWN_DRIFT) {
      const row = prxCommandRegistry.find((r) => r.name === name);
      expect(row).toBeDefined();
      if (!row) continue;
      const argv = rowArgv(row.name, row.parent as string);
      // If this fails, the verb was wired — delete its KNOWN_DRIFT entry.
      expect(driftsUnknown(argv)).toBe(true);
    }
  });
});
