import { describe, expect, test } from "bun:test";

import {
  remoteCiCheckVerb,
  scoutLogsVerb,
  type RemoteCiCheckDeps,
  type RemoteCiCheckOutput,
  type ScoutLogsDeps,
  type ScoutLogsOutput,
} from "../../src/pr-state/ci-check-verb.ts";

// `prx remote-ci-check` / `prx scout-logs` migrated off cli.ts to deps-bearing
// VerbSpecs (ADR docs/prx/cli-decomposition.md) — the first non-throwing
// consumers of the `exitCode` projection (failing checks ⇒ exit 1). These cover
// run + render + exitCode through the deps seam; routing (`repo ci` / `scout ci`
// / `scout logs`) is covered by the compiled CLI + help-all parity.

const runRemote = (
  input: { "repo-path": string; pr?: string; format: "plain" | "json" },
  deps: RemoteCiCheckDeps,
): { rendered: string; exit: number } => {
  const out = remoteCiCheckVerb.run(input as never, deps) as RemoteCiCheckOutput;
  return {
    rendered: remoteCiCheckVerb.render!(out, input as never),
    exit: remoteCiCheckVerb.exitCode!(out, input as never),
  };
};

const runScout = (
  input: { "repo-path": string; pr?: string; "max-lines": number; format: "plain" | "json" },
  deps: ScoutLogsDeps,
): { rendered: string; exit: number } => {
  const out = scoutLogsVerb.run(input as never, deps) as ScoutLogsOutput;
  return {
    rendered: scoutLogsVerb.render!(out, input as never),
    exit: scoutLogsVerb.exitCode!(out, input as never),
  };
};

describe("remote-ci-check verb", () => {
  test("plain output lists failing checks and exits 1", () => {
    const { rendered, exit } = runRemote(
      { "repo-path": ".", pr: "16230", format: "plain" },
      {
        resolveCurrentPrRef: () => "unused",
        remoteCiCheck: () =>
          ({
            repoPath: ".",
            pr: "16230",
            failingChecks: [
              {
                name: "continuous-integration/codebuild",
                state: "FAILURE",
                description: "The CodeBuild build has failed",
                link: "https://console.aws.amazon.com/codebuild/home#/builds/X:view/new",
                codebuild: {
                  buildId: "X:view",
                  reportArn: "arn:aws:codebuild:us-east-1:123:report/X",
                  error: null,
                  failures: [
                    {
                      name: "t",
                      suite: "S",
                      status: "FAILED",
                      message: null,
                      details: "x",
                      duration_ns: 1,
                    },
                  ],
                },
              },
            ],
          }) as never,
      },
    );
    expect(exit).toBe(1);
    expect(rendered).toContain("remote ci check");
    expect(rendered).toContain("continuous-integration/codebuild");
    expect(rendered).toContain("failed_tests: 1");
  });

  test("json output with no failing checks exits 0", () => {
    const { rendered, exit } = runRemote(
      { "repo-path": ".", pr: "16230", format: "json" },
      {
        resolveCurrentPrRef: () => "unused",
        remoteCiCheck: () => ({ repoPath: "/repo", pr: "16230", failingChecks: [] }) as never,
      },
    );
    expect(exit).toBe(0);
    expect(JSON.parse(rendered)).toMatchObject({
      repoPath: "/repo",
      pr: "16230",
      failingChecks: [],
    });
  });

  test("without --pr it resolves the ref from the current branch", () => {
    let seen = "";
    const { exit } = runRemote(
      { "repo-path": ".", format: "plain" },
      {
        resolveCurrentPrRef: () => "42",
        remoteCiCheck: (_repoPath, prRef) => {
          seen = prRef;
          return { repoPath: ".", pr: prRef, failingChecks: [] } as never;
        },
      },
    );
    expect(seen).toBe("42");
    expect(exit).toBe(0);
  });
});

describe("scout-logs verb", () => {
  test("failing checks render the logs and exit 1", () => {
    let seenRef = "";
    let seenMax: number | undefined;
    const { rendered, exit } = runScout(
      { "repo-path": ".", pr: "42", "max-lines": 200, format: "json" },
      {
        resolveCurrentPrRef: () => "unused",
        scoutLogs: (_repoPath, prRef, _runner, maxLines) => {
          seenRef = prRef;
          seenMax = maxLines;
          return {
            repoPath: ".",
            pr: prRef,
            checks: [
              {
                name: "ci",
                state: "FAILURE",
                link: "https://x/runs/123",
                runId: "123",
                logs: "Error: test failed",
                error: null,
              },
            ],
          } as never;
        },
      },
    );
    expect(seenRef).toBe("42");
    expect(seenMax).toBe(200);
    expect(exit).toBe(1);
    expect(rendered).toContain('"runId": "123"');
    expect(rendered).toContain("Error: test failed");
  });

  test("no failing checks exits 0", () => {
    const { rendered, exit } = runScout(
      { "repo-path": ".", pr: "42", "max-lines": 200, format: "plain" },
      {
        resolveCurrentPrRef: () => "unused",
        scoutLogs: () => ({ repoPath: ".", pr: "42", checks: [] }) as never,
      },
    );
    expect(exit).toBe(0);
    expect(rendered).toContain("no failing checks");
  });
});
