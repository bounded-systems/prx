// GH-1704 — the slug-or-cwd repo locator. Pure: it takes an inventory + opts
// and returns found/not_found. Covers the slug branch (found by name / by
// owner-name / ambiguous / not-registered) and the cwd branch (commonDir match,
// nested path, worktree path, no-cwd, no-match).

import { describe, expect, test } from "bun:test";

import { locateRepo } from "../../src/pr-state/repo_locate.ts";
import type { LocalRepo, RepoInventory } from "../../src/pr-state/repos.ts";

const repo = (over: Partial<LocalRepo>): LocalRepo =>
  ({
    name: "r",
    commonDir: "/repos/r",
    kind: "bare",
    mainWorktree: null,
    worktrees: [],
    localOnlyBranches: [],
    findings: [],
    remotes: [],
    primaryRemote: null,
    upstreamRemote: null,
    ...over,
  }) as LocalRepo;

const inv = (repos: LocalRepo[]): RepoInventory => ({ repos }) as RepoInventory;
const remote = (githubRepo: string) => ({ githubRepo }) as LocalRepo["primaryRemote"];

describe("locateRepo — slug branch", () => {
  test("finds a repo by bare name", () => {
    const r = locateRepo(inv([repo({ name: "prx", commonDir: "/c/prx" })]), { slug: "prx" });
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.index).toBe(0);
  });

  test("finds a repo by owner/name primary remote", () => {
    const r = locateRepo(
      inv([repo({ name: "x", commonDir: "/c/x", primaryRemote: remote("acme/prx") })]),
      { slug: "acme/prx" },
    );
    expect(r.kind).toBe("found");
  });

  test("reports ambiguity with candidates", () => {
    const r = locateRepo(
      inv([
        repo({ name: "prx", commonDir: "/a" }),
        repo({ name: "other", commonDir: "/b", primaryRemote: remote("prx") }),
      ]),
      { slug: "prx" },
    );
    expect(r.kind).toBe("not_found");
    if (r.kind === "not_found") expect(r.detail).toMatch(/ambiguous/);
  });

  test("reports a slug that is not registered", () => {
    const r = locateRepo(inv([repo({ name: "prx" })]), { slug: "nope" });
    expect(r.kind).toBe("not_found");
    if (r.kind === "not_found") expect(r.detail).toMatch(/No repo registered/);
  });
});

describe("locateRepo — cwd branch", () => {
  const repos = inv([
    repo({
      name: "prx",
      commonDir: "/repos/prx",
      worktrees: [{ path: "/wt/GH-1" }] as LocalRepo["worktrees"],
    }),
  ]);

  test("no slug and no cwd → not_found", () => {
    const r = locateRepo(repos, { slug: null });
    expect(r.kind).toBe("not_found");
    if (r.kind === "not_found") expect(r.detail).toMatch(/no cwd/);
  });

  test("cwd exactly at commonDir → found", () => {
    expect(locateRepo(repos, { slug: null, cwd: "/repos/prx" }).kind).toBe("found");
  });

  test("cwd nested under commonDir → found", () => {
    expect(locateRepo(repos, { slug: null, cwd: "/repos/prx/sub/dir" }).kind).toBe("found");
  });

  test("cwd inside a registered worktree → found", () => {
    expect(locateRepo(repos, { slug: null, cwd: "/wt/GH-1/pkg" }).kind).toBe("found");
  });

  test("cwd covered by no inventory entry → not_found", () => {
    const r = locateRepo(repos, { slug: null, cwd: "/elsewhere" });
    expect(r.kind).toBe("not_found");
    if (r.kind === "not_found") expect(r.detail).toMatch(/Could not infer/);
  });
});
