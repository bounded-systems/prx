// tools/ensure_branch — every outcome of the work-unit branch ensurer, driven
// through the injectable git spawn (no real git). Covers the spawn path in
// runGit, the fetch→recheck base-resolution ladder, and local-only vs push.

import { describe, expect, test } from "bun:test";

import {
  ensureBranch,
  formatEnsureBranchResult,
  type EnsureBranchOptions,
  type EnsureBranchResult,
} from "../../src/tools/ensure_branch.ts";

type R = { status: number | null; stdout?: string; stderr?: string };
// Route on the git subcommand (args = ["-C", cwd, <sub>, ...]) + a predicate on
// the full argv so the three `rev-parse` calls (local / base / recheck) split.
const git =
  (handler: (sub: string, argv: string[]) => Partial<R>): EnsureBranchOptions["spawn"] =>
  ((_file: string, argv: string[]) => ({ status: 0, stdout: "", stderr: "", ...handler(argv[2]!, argv) })) as never;

const run = (over: Partial<EnsureBranchOptions>, spawn: EnsureBranchOptions["spawn"]): EnsureBranchResult =>
  ensureBranch({ name: "GH-1", base: "origin/main", cwd: "/repo", spawn, ...over });

const refsHeads = (argv: string[]) => argv.some((a) => a.startsWith("refs/heads/"));

describe("ensureBranch outcomes", () => {
  test("invalid base → error", () => {
    expect(run({ base: "noslash" }, git(() => ({}))).status).toBe("error");
  });

  test("skip-listed branch → skipped", () => {
    expect(run({ name: "main", skip: ["main"] }, git(() => ({}))).status).toBe("skipped");
  });

  test("existing local branch → exists-local", () => {
    const r = run({}, git((sub, argv) => (sub === "rev-parse" && refsHeads(argv) ? { status: 0 } : { status: 1 })));
    expect(r.status).toBe("exists-local");
  });

  test("existing remote branch → exists-remote", () => {
    const r = run({}, git((sub, argv) => {
      if (sub === "rev-parse" && refsHeads(argv)) return { status: 1 }; // no local
      if (sub === "branch" && argv.includes("-r")) return { status: 0, stdout: "  origin/GH-1\n" };
      return { status: 1 };
    }));
    expect(r.status).toBe("exists-remote");
  });

  test("unresolvable base, fetch fails → base-unresolved", () => {
    const r = run({}, git((sub, argv) => {
      if (sub === "rev-parse" && refsHeads(argv)) return { status: 1 };
      if (sub === "branch") return { status: 1 }; // no remote
      if (sub === "rev-parse") return { status: 1 }; // baseCheck fails
      if (sub === "fetch") return { status: 1, stderr: "no such remote ref" };
      return { status: 1 };
    }));
    expect(r.status).toBe("base-unresolved");
    expect(r.message).toMatch(/no such remote ref/);
  });

  test("base still unresolved after a successful fetch → base-unresolved", () => {
    let revParseBase = 0;
    const r = run({}, git((sub, argv) => {
      if (sub === "rev-parse" && refsHeads(argv)) return { status: 1 };
      if (sub === "branch") return { status: 1 };
      if (sub === "rev-parse") { revParseBase += 1; return { status: 1 }; } // base + recheck both fail
      if (sub === "fetch") return { status: 0 }; // fetch ok
      return { status: 1 };
    }));
    expect(r.status).toBe("base-unresolved");
    expect(r.message).toMatch(/still unresolvable/);
    expect(revParseBase).toBe(2); // baseCheck + recheck
  });

  test("base resolves after fetch, then localOnly create → created", () => {
    let baseRevParse = 0;
    const r = run({ localOnly: true }, git((sub, argv) => {
      if (sub === "rev-parse" && refsHeads(argv)) return { status: 1 };
      if (sub === "branch" && argv.includes("-r")) return { status: 1 };
      if (sub === "rev-parse") { baseRevParse += 1; return { status: baseRevParse === 1 ? 1 : 0 }; } // fail, then ok
      if (sub === "fetch") return { status: 0 };
      if (sub === "branch") return { status: 0 };
      return { status: 1 };
    }));
    expect(r).toMatchObject({ status: "created", created: true });
    expect(baseRevParse).toBe(2); // baseCheck (fail) + recheck (ok)
  });

  test("localOnly create succeeds → created", () => {
    const r = run({ localOnly: true }, git((sub, argv) => {
      if (sub === "rev-parse" && refsHeads(argv)) return { status: 1 };
      if (sub === "branch" && argv.includes("-r")) return { status: 1 };
      if (sub === "rev-parse") return { status: 0 }; // base resolves
      if (sub === "branch") return { status: 0 }; // create
      return { status: 1 };
    }));
    expect(r).toMatchObject({ status: "created", created: true });
  });

  test("localOnly create fails → error", () => {
    const r = run({ localOnly: true }, git((sub, argv) => {
      if (sub === "rev-parse" && refsHeads(argv)) return { status: 1 };
      if (sub === "branch" && argv.includes("-r")) return { status: 1 };
      if (sub === "rev-parse") return { status: 0 };
      if (sub === "branch") return { status: 128, stderr: "branch exists" };
      return { status: 1 };
    }));
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/branch exists/);
  });

  test("push succeeds → created", () => {
    const r = run({}, git((sub, argv) => {
      if (sub === "rev-parse" && refsHeads(argv)) return { status: 1 };
      if (sub === "branch") return { status: 1 };
      if (sub === "rev-parse") return { status: 0 };
      if (sub === "push") return { status: 0 };
      return { status: 1 };
    }));
    expect(r).toMatchObject({ status: "created", created: true });
  });

  test("push fails → error", () => {
    const r = run({}, git((sub, argv) => {
      if (sub === "rev-parse" && refsHeads(argv)) return { status: 1 };
      if (sub === "branch") return { status: 1 };
      if (sub === "rev-parse") return { status: 0 };
      if (sub === "push") return { status: 1, stderr: "rejected" };
      return { status: 1 };
    }));
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/rejected/);
  });
});

describe("formatEnsureBranchResult", () => {
  const base = { branch: "GH-1", base: "origin/main", remote: "origin", created: false } as const;
  test("json round-trips", () => {
    const r: EnsureBranchResult = { ...base, status: "skipped" };
    expect(JSON.parse(formatEnsureBranchResult(r, "json")).status).toBe("skipped");
  });
  test("plain tags every status", () => {
    const tag = (status: EnsureBranchResult["status"], extra: Partial<EnsureBranchResult> = {}) =>
      formatEnsureBranchResult({ ...base, status, ...extra } as EnsureBranchResult, "plain");
    expect(tag("created", { created: true })).toMatch(/^created: GH-1 from origin\/main/);
    expect(tag("exists-local")).toMatch(/ok \(local\)/);
    expect(tag("exists-remote")).toMatch(/ok \(remote\)/);
    expect(tag("skipped")).toMatch(/skipped/);
    expect(tag("base-unresolved", { message: "m" })).toMatch(/base-unresolved.*— m/);
    expect(tag("error")).toMatch(/error/);
  });
});
