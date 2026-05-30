// GH-2129: parity guard for the `prx dolt <verb>` CLI surface.
//
// Background: GH-2009 declared all nine dolt verbs in the help catalog
// (src/cli/registry.data.ts) and on the dolt actor (src/machine/actors.ts),
// but only `reconcile` ever reached a dispatcher route. The other eight died
// with `Unknown dolt subcommand: <verb>` — the help catalog advertised an
// interface the dispatcher did not implement. This test pins the new single
// source of truth (DOLT_VERB_DISPATCH) against the contract array (DOLT_VERBS)
// and the registry rows, and asserts every verb now resolves to a real route
// or a typed not-implemented stub instead of an `Unknown` error.

import { describe, expect, test } from "bun:test";

import {
  DOLT_VERBS,
  DOLT_VERB_DISPATCH,
} from "../../src/dolt/schema.ts";
import {
  CliError,
  normalizeNamespaceArgv,
  parseCommand,
} from "../../src/pr-state/cli.ts";
import { prxCommandRegistry } from "../../src/cli/registry.data.ts";

describe("dolt dispatch parity (GH-2129)", () => {
  test("DOLT_VERBS, DOLT_VERB_DISPATCH, and the registry agree on the verb set", () => {
    const contractVerbs = [...DOLT_VERBS].sort();
    const dispatchVerbs = Object.keys(DOLT_VERB_DISPATCH).sort();
    const registryVerbs = prxCommandRegistry
      .filter((row) => row.parent === "dolt")
      .map((row) => row.name.replace(/^dolt /, ""))
      .sort();

    expect(dispatchVerbs).toEqual(contractVerbs);
    expect(registryVerbs).toEqual(contractVerbs);
  });

  test("every verb rewrites without throwing Unknown dolt subcommand", () => {
    for (const verb of DOLT_VERBS) {
      const rewrite = () => normalizeNamespaceArgv(["dolt", verb]);
      expect(rewrite).not.toThrow();
      const head = rewrite()[0];
      expect(head).toBe(
        DOLT_VERB_DISPATCH[verb].route === "dolt-stub"
          ? "dolt-stub"
          : DOLT_VERB_DISPATCH[verb].route,
      );
    }
  });

  test("each stub verb parses to a typed not-implemented command naming its ticket", () => {
    for (const verb of DOLT_VERBS) {
      if (DOLT_VERB_DISPATCH[verb].route !== "dolt-stub") continue;
      const parsed = parseCommand(["dolt", verb]);
      expect(parsed.command).toBe("dolt-stub");
      if (parsed.command !== "dolt-stub") continue;
      expect(parsed.verb).toBe(verb);
      expect(parsed.tracking).toBe(DOLT_VERB_DISPATCH[verb].tracking);
      expect(parsed.tracking).toMatch(/^GH-\d+$/);
    }
  });

  test("reconcile still routes to the real dolt-reconcile command", () => {
    const parsed = parseCommand(["dolt", "reconcile"]);
    expect(parsed.command).toBe("dolt-reconcile");
  });

  test("no-arg dolt error enumerates every verb in catalog order", () => {
    let message = "";
    try {
      normalizeNamespaceArgv(["dolt"]);
    } catch (err) {
      if (err instanceof CliError) message = err.message;
    }
    expect(message).toBe(
      `dolt requires a subcommand: ${DOLT_VERBS.join(", ")}`,
    );
  });

  test("an unknown verb names the available verbs instead of dying bare", () => {
    let message = "";
    try {
      normalizeNamespaceArgv(["dolt", "bogus"]);
    } catch (err) {
      if (err instanceof CliError) message = err.message;
    }
    expect(message).toContain("Unknown dolt subcommand: bogus");
    expect(message).toContain(DOLT_VERBS.join(", "));
  });
});
