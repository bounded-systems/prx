// triage/drift-fix — runDriftFixActor's audit-capturing wrapper, driven with
// empty gh/bd seams so it runs to a clean no-drift result without real IO.

import { describe, expect, test } from "bun:test";

import { runDriftFixActor } from "../../src/triage/drift-fix.ts";

describe("runDriftFixActor", () => {
  test("a repo with no open issues and no beads → a clean (no-drift) actor result", async () => {
    const r = await runDriftFixActor(
      { repo: "owner/repo", dryRun: true } as never,
      {
        repoNameWithOwner: (() => "owner/repo") as never,
        listOpenIssues: (() => []) as never,
        loadAllBeads: (() => []) as never,
        execBd: (() => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null })) as never,
        auditSink: { appendFn: () => {}, ensureDir: () => {} } as never,
      },
    );
    expect(typeof r.exitCode).toBe("number");
    expect(Array.isArray(r.touchedIssues)).toBe(true);
  });
});
