import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultFetchSource,
  fetchSources,
} from "../../src/dep-research/fetch.ts";
import type { DepManifestEntry } from "../../src/dep-research/schemas.ts";
import type { CommandRunner } from "../../src/pr-state/scope-inference.ts";

function gitEntry(): DepManifestEntry {
  return {
    name: "xstate",
    source: {
      kind: "git",
      url: "https://github.com/statelyai/xstate",
      paths: ["a.ts", "missing.ts"],
    },
    classification_hints: { schema: [], state: [], cli: [], config: [] },
  };
}

function docsEntry(): DepManifestEntry {
  return {
    name: "claude-code",
    source: {
      kind: "docs",
      url: "https://docs.claude.com/en/docs/claude-code/overview",
      paths: ["settings", "hooks"],
    },
    classification_hints: { schema: [], state: [], cli: [], config: [] },
  };
}

function tmpDestDir(): string {
  return mkdtempSync(join(tmpdir(), "dep-research-fetch-"));
}

describe("defaultFetchSource — git", () => {
  test("clones once and reads each manifest path", async () => {
    const destDir = tmpDestDir();
    let cloneInvocations = 0;
    const runner: CommandRunner = (cmd, args, _opts) => {
      cloneInvocations += 1;
      expect(cmd).toBe("git");
      expect(args[0]).toBe("clone");
      expect(args).toContain("--depth=1");
      const cloneDir = args[args.length - 1]!;
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(join(cloneDir, "a.ts"), "export const a = 1;\n", "utf8");
      // 'missing.ts' deliberately absent.
      return { stdout: "", stderr: "", status: 0 };
    };

    const fetcher = defaultFetchSource(runner);
    const result = await fetchSources(gitEntry(), destDir, fetcher);

    expect(cloneInvocations).toBe(1);
    expect(result.paths["a.ts"]?.toString("utf8")).toBe("export const a = 1;\n");
    expect(result.paths["missing.ts"]).toBeUndefined();
    expect(result.failures["missing.ts"]).toMatch(/read failed/);
  });

  test("propagates clone failure to every path as a failure reason", async () => {
    const destDir = tmpDestDir();
    const runner: CommandRunner = () => ({
      stdout: "",
      stderr: "fatal: repository not found",
      status: 128,
    });

    const result = await fetchSources(gitEntry(), destDir, defaultFetchSource(runner));
    expect(result.paths).toEqual({});
    expect(Object.keys(result.failures).sort()).toEqual(["a.ts", "missing.ts"]);
    for (const reason of Object.values(result.failures)) {
      expect(reason).toContain("git clone failed");
      expect(reason).toContain("repository not found");
    }
  });
});

describe("defaultFetchSource — docs", () => {
  test("issues one curl per path and reads the staged file", async () => {
    const destDir = tmpDestDir();
    const expectedUrls = [
      "https://docs.claude.com/en/docs/claude-code/overview/settings",
      "https://docs.claude.com/en/docs/claude-code/overview/hooks",
    ];
    const seenUrls: string[] = [];
    const runner: CommandRunner = (cmd, args, _opts) => {
      expect(cmd).toBe("curl");
      const oFlagIdx = args.indexOf("-o");
      expect(oFlagIdx).toBeGreaterThanOrEqual(0);
      const outFile = args[oFlagIdx + 1]!;
      const url = args[args.length - 1]!;
      seenUrls.push(url);
      writeFileSync(outFile, `body for ${url}\n`, "utf8");
      return { stdout: "", stderr: "", status: 0 };
    };

    const result = await fetchSources(docsEntry(), destDir, defaultFetchSource(runner));
    expect(seenUrls.sort()).toEqual([...expectedUrls].sort());
    expect(result.paths["settings"]?.toString("utf8")).toContain("settings");
    expect(result.paths["hooks"]?.toString("utf8")).toContain("hooks");
    expect(result.failures).toEqual({});
  });

  test("captures per-path failures without aborting the rest", async () => {
    const destDir = tmpDestDir();
    const runner: CommandRunner = (cmd, args, _opts) => {
      const url = args[args.length - 1]!;
      if (url.endsWith("/hooks")) {
        return { stdout: "", stderr: "curl: (22) HTTP 404", status: 22 };
      }
      const outFile = args[args.indexOf("-o") + 1]!;
      writeFileSync(outFile, "ok\n", "utf8");
      return { stdout: "", stderr: "", status: 0 };
    };
    const result = await fetchSources(docsEntry(), destDir, defaultFetchSource(runner));
    expect(result.paths["settings"]?.toString("utf8")).toBe("ok\n");
    expect(result.paths["hooks"]).toBeUndefined();
    expect(result.failures["hooks"]).toContain("curl failed");
  });
});

describe("defaultFetchSource — unimplemented kinds", () => {
  test("npm and flake-input report a clear per-path failure", async () => {
    const destDir = tmpDestDir();
    const runner: CommandRunner = () => {
      throw new Error(
        "runner should not be invoked for unimplemented kinds",
      );
    };
    const entry: DepManifestEntry = {
      name: "x",
      source: {
        kind: "npm",
        url: "https://registry.npmjs.org/something",
        paths: ["package.json"],
      },
      classification_hints: { schema: [], state: [], cli: [], config: [] },
    };
    const result = await fetchSources(entry, destDir, defaultFetchSource(runner));
    expect(result.paths).toEqual({});
    expect(result.failures["package.json"]).toContain("not yet implemented");
    expect(result.failures["package.json"]).toContain("npm");
  });
});
