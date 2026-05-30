// GH-1274 (PR-2 of GH-1261): end-to-end CLI tests for `prx dep research`.
//
// Drives the public `runCli` seam with an injected fetcher so no test ever
// shells out to real git/curl. Verifies the two acceptance bullets from
// the issue body: a parseable DepSnapshot on success, and a non-zero exit
// with `run_state: "failed"` on fetch failure.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/pr-state/cli.ts";
import { DepSnapshot } from "../../src/dep-research/schemas.ts";
import type { FetchSourceFn } from "../../src/dep-research/fetch.ts";

type CapturedOutput = {
  logs: string[];
  errors: string[];
  output: { log: (line: string) => void; error: (line: string) => void };
};

function captureOutput(): CapturedOutput {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  };
}

function repoWithManifest(): string {
  const root = mkdtempSync(join(tmpdir(), "dep-research-cli-"));
  mkdirSync(join(root, ".prx", "dep-research"), { recursive: true });
  writeFileSync(
    join(root, ".prx", "dep-research", "manifest.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          name: "xstate",
          source: {
            kind: "git",
            url: "https://github.com/statelyai/xstate",
            paths: ["packages/core/src/types.ts"],
          },
          classification_hints: { schema: [], state: [], cli: [], config: [] },
        },
      ],
    }),
    "utf8",
  );
  return root;
}

const fixedNow = () => new Date("2026-05-05T12:00:00.000Z");

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

describe("prx dep research <dep> --dry-run", () => {
  test("prints a parseable DepSnapshot on success", async () => {
    const root = repoWithManifest();
    const okFetcher: FetchSourceFn = async (entry) => {
      const paths: Record<string, Buffer> = {};
      for (const path of entry.source.paths) {
        paths[path] = Buffer.from(`stub ${path}`, "utf8");
      }
      return { paths, failures: {} };
    };
    const captured = captureOutput();

    const exit = await withCwd(root, () =>
      Promise.resolve(
        runCli(
          ["dep", "research", "xstate", "--dry-run"],
          captured.output,
          { depResearchFetcher: okFetcher, depResearchNow: fixedNow },
        ),
      ),
    );

    expect(exit).toBe(0);
    expect(captured.logs.length).toBe(1);
    const printed = JSON.parse(captured.logs[0]!);
    const parsed = DepSnapshot.parse(printed);
    expect(parsed.dep).toBe("xstate");
    expect(parsed.run_id).toBe("20260505T120000Z");
    expect(parsed.run_state).toBe("ok");
    expect(parsed.source_sha256["packages/core/src/types.ts"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test("leaves no on-disk artifacts under .prx/dep-research/<dep>/", async () => {
    const root = repoWithManifest();
    const okFetcher: FetchSourceFn = async (entry) => {
      const paths: Record<string, Buffer> = {};
      for (const path of entry.source.paths) {
        paths[path] = Buffer.from("stub", "utf8");
      }
      return { paths, failures: {} };
    };
    const captured = captureOutput();

    await withCwd(root, () =>
      Promise.resolve(
        runCli(
          ["dep", "research", "xstate", "--dry-run"],
          captured.output,
          { depResearchFetcher: okFetcher, depResearchNow: fixedNow },
        ),
      ),
    );

    // Manifest is still there (we wrote it ourselves).
    expect(existsSync(join(root, ".prx", "dep-research", "manifest.json"))).toBe(
      true,
    );
    // No <dep>/ directory ever materialized under .prx/dep-research/.
    expect(existsSync(join(root, ".prx", "dep-research", "xstate"))).toBe(false);
  });

  test("fetch failure exits non-zero and prints the failed snapshot", async () => {
    const root = repoWithManifest();
    const failingFetcher: FetchSourceFn = async (entry) => {
      const failures: Record<string, string> = {};
      for (const path of entry.source.paths) {
        failures[path] = "git clone failed (128): repository unreachable";
      }
      return { paths: {}, failures };
    };
    const captured = captureOutput();

    const exit = await withCwd(root, () =>
      Promise.resolve(
        runCli(
          ["dep", "research", "xstate", "--dry-run"],
          captured.output,
          { depResearchFetcher: failingFetcher, depResearchNow: fixedNow },
        ),
      ),
    );

    expect(exit).not.toBe(0);
    const printed = JSON.parse(captured.logs[0]!);
    const parsed = DepSnapshot.parse(printed);
    expect(parsed.run_state).toBe("failed");
    expect(parsed.source_sha256).toEqual({});
    expect(captured.errors.some((e) => e.includes("repository unreachable"))).toBe(
      true,
    );
    // Even after failure, the dry-run leaves no on-disk artifacts.
    expect(existsSync(join(root, ".prx", "dep-research", "xstate"))).toBe(false);
  });
});

describe("prx dep research <dep> (bare form)", () => {
  test("writes atomically under .prx/dep-research/<dep>/<run_id>/", async () => {
    const root = repoWithManifest();
    const okFetcher: FetchSourceFn = async (entry) => {
      const paths: Record<string, Buffer> = {};
      for (const path of entry.source.paths) {
        paths[path] = Buffer.from(`payload ${path}`, "utf8");
      }
      return { paths, failures: {} };
    };
    const captured = captureOutput();

    const exit = await withCwd(root, () =>
      Promise.resolve(
        runCli(
          ["dep", "research", "xstate"],
          captured.output,
          { depResearchFetcher: okFetcher, depResearchNow: fixedNow },
        ),
      ),
    );

    expect(exit).toBe(0);
    const finalPath = join(
      root,
      ".prx",
      "dep-research",
      "xstate",
      "20260505T120000Z",
      "snapshot.json",
    );
    expect(existsSync(finalPath)).toBe(true);
  });
});

describe("prx dep research — argv routing", () => {
  test("unknown dep returns exit 66 with available list", async () => {
    const root = repoWithManifest();
    const captured = captureOutput();

    const exit = await withCwd(root, () =>
      Promise.resolve(
        runCli(
          ["dep", "research", "no-such-dep", "--dry-run"],
          captured.output,
          { depResearchNow: fixedNow },
        ),
      ),
    );

    expect(exit).toBe(66);
    expect(captured.errors.some((e) => e.includes("unknown dep 'no-such-dep'"))).toBe(
      true,
    );
    expect(captured.errors.some((e) => e.includes("xstate"))).toBe(true);
  });

  test("missing positional yields a clear error", async () => {
    const captured = captureOutput();
    const exit = await Promise.resolve(
      runCli(["dep", "research", "--dry-run"], captured.output, {}),
    );
    expect(exit).not.toBe(0);
    expect(captured.errors.some((e) =>
      e.includes("requires a <dep> positional"),
    )).toBe(true);
  });

  test("`prx dep` lists manifest, research, and status", async () => {
    const captured = captureOutput();
    const exit = await Promise.resolve(
      runCli(["dep"], captured.output, {}),
    );
    expect(exit).not.toBe(0);
    const joined = captured.errors.join("\n");
    expect(joined).toContain("manifest");
    expect(joined).toContain("research");
    expect(joined).toContain("status");
  });

  test("unknown dep subcommand lists available + research + status", async () => {
    const captured = captureOutput();
    const exit = await Promise.resolve(
      runCli(["dep", "researrch"], captured.output, {}),
    );
    expect(exit).not.toBe(0);
    const joined = captured.errors.join("\n");
    expect(joined).toContain("Unknown dep subcommand");
    expect(joined).toContain("manifest");
    expect(joined).toContain("research");
    expect(joined).toContain("status");
  });
});

describe("prx dep status", () => {
  test("never-run dep prints a row with state 'never'", async () => {
    const root = repoWithManifest();
    const captured = captureOutput();
    const exit = await withCwd(root, () =>
      Promise.resolve(runCli(["dep", "status"], captured.output, {})),
    );
    expect(exit).toBe(0);
    const joined = captured.logs.join("\n");
    expect(joined).toContain("xstate");
    expect(joined).toContain("never");
  });

  test("--format json emits a JSON array of status rows", async () => {
    const root = repoWithManifest();
    const captured = captureOutput();
    const exit = await withCwd(root, () =>
      Promise.resolve(
        runCli(["dep", "status", "--format", "json"], captured.output, {}),
      ),
    );
    expect(exit).toBe(0);
    const printed = JSON.parse(captured.logs[0]!);
    expect(Array.isArray(printed)).toBe(true);
    expect(printed[0]?.dep).toBe("xstate");
    expect(printed[0]?.run_state).toBe("never");
    expect(printed[0]?.classification).toBeNull();
  });
});
