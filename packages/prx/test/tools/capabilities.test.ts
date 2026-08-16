// Tests for the OCAP self-report surface (`prx capabilities`). All ambient
// reads are injected through CapabilityDeps so the report is exercised against
// a synthetic box — no real git/bd/gh/repo on the test host required.

import { describe, expect, test } from "bun:test";

import {
  formatCapabilities,
  probeCapabilities,
  type CapabilityDeps,
} from "../../src/tools/capabilities.ts";

/** Build deps for a box where the named binaries resolve and fs is empty. */
function deps(over: {
  onPath?: Set<string>;
  files?: Record<string, string>;
  cwd?: string;
  homeDir?: string | null;
}): CapabilityDeps {
  const onPath = over.onPath ?? new Set<string>();
  const files = over.files ?? {};
  return {
    exec: async ({ args }) => {
      // resolveOnPath runs `/bin/sh -c "command -v <bin>"`.
      const bin = (args[1] ?? "").replace(/^command -v /, "").trim();
      return onPath.has(bin)
        ? { status: 0, stdout: `/usr/bin/${bin}\n` }
        : { status: 1, stdout: "" };
    },
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    cwd: over.cwd ?? "/home/claude",
    homeDir: over.homeDir === undefined ? "/home/claude" : over.homeDir,
  };
}

describe("probeCapabilities", () => {
  test("a bare box reports everything unavailable", async () => {
    const report = await probeCapabilities(deps({}));

    expect(report.available).toEqual([]);
    expect(report.unavailable).toEqual(["git", "git-repo", "bd", "gh", "repos", "claude-lsp"]);
    // Every miss carries a translation ("how to enable").
    for (const cap of report.capabilities) {
      expect(cap.status).toBe("unavailable");
      expect(cap.enable).toBeTruthy();
    }
  });

  test("a fully provisioned box reports everything available", async () => {
    const report = await probeCapabilities(
      deps({
        onPath: new Set(["git", "bd", "gh", "typescript-language-server", "tsserver"]),
        cwd: "/work/repo/sub",
        files: {
          "/work/repo/.git": "",
          "/work/repo/.prx/repos/index.json": JSON.stringify({
            repos: [{ name: "a" }, { name: "b" }],
          }),
        },
      }),
    );

    expect(report.unavailable).toEqual([]);
    expect(report.available).toEqual(["git", "git-repo", "bd", "gh", "repos", "claude-lsp"]);
    const repoRepo = report.capabilities.find((c) => c.id === "repos")!;
    expect(repoRepo.detail).toContain("2 repo(s)");
  });

  test("git-repo is detected by walking up to the .git marker, independent of the git binary", async () => {
    // No `git` on PATH, but cwd sits below a .git marker — honest answer is
    // still "inside a repo".
    const report = await probeCapabilities(
      deps({ cwd: "/work/repo/a/b", files: { "/work/repo/.git": "" } }),
    );
    const gitBin = report.capabilities.find((c) => c.id === "git")!;
    const gitRepo = report.capabilities.find((c) => c.id === "git-repo")!;
    expect(gitBin.status).toBe("unavailable");
    expect(gitRepo.status).toBe("available");
    expect(gitRepo.detail).toContain("/work/repo");
  });

  test("an index with zero repos counts as unavailable", async () => {
    const report = await probeCapabilities(
      deps({
        cwd: "/work/repo",
        files: {
          "/work/repo/.git": "",
          "/work/repo/.prx/repos/index.json": JSON.stringify({ repos: [] }),
        },
      }),
    );
    expect(report.unavailable).toContain("repos");
  });
});

describe("formatCapabilities", () => {
  test("plain output groups available and unavailable with enable hints", async () => {
    const report = await probeCapabilities(deps({ onPath: new Set(["git"]) }));
    const out = formatCapabilities(report, "plain");
    expect(out).toContain("✓ Available");
    expect(out).toContain("✗ Unavailable");
    expect(out).toContain("to enable:");
    // The available git binary appears under the available section.
    expect(out).toContain("git CLI");
  });

  test("json output round-trips the report", async () => {
    const report = await probeCapabilities(deps({}));
    const parsed = JSON.parse(formatCapabilities(report, "json"));
    expect(parsed.available).toEqual(report.available);
    expect(parsed.capabilities).toHaveLength(6);
  });
});
