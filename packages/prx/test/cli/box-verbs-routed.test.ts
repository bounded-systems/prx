import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";

/**
 * Regression guard for a bug that bit THREE times: a verb registered in
 * verb-registry.ts (so MCP/OpenAPI see it) but never given a routing case in
 * cli.ts's dispatch — so the CLI answers "Unknown subcommand". It stays invisible
 * for daemon verbs that only ever run inside an OCI box entrypoint (never in unit
 * tests), then crashes the container at deploy time:
 *   - `ghapp serve` (ghappd-box `/bin/prx ghapp serve`) → "Unknown subcommand: ghapp"
 *   - `pod secrets` (prx-zee7) → "Unknown subcommand: pod"
 *
 * These verbs are invoked by a box entrypoint or the deploy flow, so they MUST be
 * reachable from the real `prx` CLI (`runCli`), not just registered. `--help`
 * short-circuits verbspec dispatch (renders help, never runs the daemon).
 */
const BOX_ENTRYPOINT_VERBS: ReadonlyArray<readonly string[]> = [
  ["ghapp", "serve"], // ghappd-box entrypoint — the credential-broker door daemon
  ["pod", "up"], // `prx pod up`
  ["pod", "secrets"], // `prx pod secrets`
  ["pod", "down"], // `prx pod down`
];

function capture() {
  const lines: string[] = [];
  const sink = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  // Output is console-shaped; provide the common methods.
  const out = { log: sink, error: sink, warn: sink, info: sink, debug: sink } as unknown as Console;
  return { out, text: () => lines.join("\n") };
}

describe("box/daemon entrypoint verbs are CLI-routed (not just registered)", () => {
  for (const verb of BOX_ENTRYPOINT_VERBS) {
    test(`prx ${verb.join(" ")} dispatches (no "Unknown subcommand")`, async () => {
      const cap = capture();
      await runCli([...verb, "--help"], cap.out);
      expect(cap.text()).not.toContain("Unknown subcommand");
    });
  }
});
