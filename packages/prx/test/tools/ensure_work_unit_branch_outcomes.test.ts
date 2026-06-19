// tools/ensure_work_unit_branch — every outcome of the local-tracking-branch
// ensurer, driven through the injectable git spawn (which threads into
// ensureBranch too). No real git.

import { describe, expect, test } from "bun:test";

import {
  ensureWorkUnitBranchAndUpstream,
  type EnsureWorkUnitBranchOptions,
} from "../../src/tools/ensure_work_unit_branch.ts";

type R = { status: number | null; stdout?: string; stderr?: string };
const has = (argv: string[], s: string) => argv.some((a) => a.includes(s));

// Route on the full argv (git "-C" cwd <sub> ...).
const git = (h: (argv: string[]) => Partial<R>): EnsureWorkUnitBranchOptions["spawn"] =>
  ((_f: string, argv: string[]) => ({ status: 0, stdout: "", stderr: "", ...h(argv) })) as never;

const run = (
  spawn: EnsureWorkUnitBranchOptions["spawn"],
  over: Partial<EnsureWorkUnitBranchOptions> = {},
) =>
  ensureWorkUnitBranchAndUpstream({
    id: "GH-1",
    base: "origin/main",
    cwd: "/repo",
    spawn,
    ...over,
  } as EnsureWorkUnitBranchOptions);

// Make ensureBranch return "exists-remote": no local head, remote list non-empty.
const remoteExists = (argv: string[]): Partial<R> | null => {
  if (argv[2] === "rev-parse" && has(argv, "refs/heads/")) return { status: 1 };
  if (argv[2] === "branch" && has(argv, "-r")) return { status: 0, stdout: "  origin/GH-1\n" };
  return null;
};
// Make ensureBranch return "exists-local": local head present.
const localExists = (argv: string[]): Partial<R> | null => {
  if (argv[2] === "rev-parse" && has(argv, "refs/heads/")) return { status: 0 };
  return null;
};

describe("ensureWorkUnitBranchAndUpstream", () => {
  test("skipped when ensureBranch skips", () => {
    expect(
      run(
        git(() => ({ status: 0 })),
        { id: "main", skip: ["main"] },
      ).status,
    ).toBe("skipped");
  });

  test("error when ensureBranch base is unresolvable", () => {
    // invalid base → ensureBranch error → propagated.
    expect(
      run(
        git(() => ({ status: 1 })),
        { base: "noslash" },
      ).status,
    ).toBe("error");
  });

  test("error when origin ref is missing after ensureBranch", () => {
    const r = run(
      git((argv) => {
        const e = remoteExists(argv);
        if (e) return e;
        if (has(argv, "refs/remotes/origin/")) return { status: 1 }; // originRef missing
        return { status: 1 };
      }),
    );
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/not found after ensureBranch/);
  });

  test("created-tracking when the local branch is absent", () => {
    const r = run(
      git((argv) => {
        const e = remoteExists(argv);
        if (e) return e;
        if (has(argv, "refs/remotes/origin/")) return { status: 0 }; // origin present
        if (argv[2] === "branch" && has(argv, "--track")) return { status: 0 }; // create ok
        return { status: 1 };
      }),
    );
    expect(r).toMatchObject({ status: "created-tracking", localCreated: true });
  });

  test("error when the tracking-branch create fails", () => {
    const r = run(
      git((argv) => {
        const e = remoteExists(argv);
        if (e) return e;
        if (has(argv, "refs/remotes/origin/")) return { status: 0 };
        if (argv[2] === "branch" && has(argv, "--track"))
          return { status: 128, stderr: "track failed" };
        return { status: 1 };
      }),
    );
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/track failed/);
  });

  test("ok when the local branch already tracks origin/<id>", () => {
    const r = run(
      git((argv) => {
        const e = localExists(argv);
        if (e) return e;
        if (has(argv, "refs/remotes/origin/")) return { status: 0 };
        if (argv[2] === "branch" && has(argv, "--format"))
          return { status: 0, stdout: "origin/GH-1\n" };
        return { status: 0 };
      }),
    );
    expect(r.status).toBe("ok");
  });

  test("upstream-mismatch when the local branch tracks something else", () => {
    const r = run(
      git((argv) => {
        const e = localExists(argv);
        if (e) return e;
        if (has(argv, "refs/remotes/origin/")) return { status: 0 };
        if (argv[2] === "branch" && has(argv, "--format"))
          return { status: 0, stdout: "origin/other\n" };
        return { status: 0 };
      }),
    );
    expect(r.status).toBe("upstream-mismatch");
    expect(r.message).toMatch(/upstream is origin\/other/);
  });

  test("upstream-fixed when no upstream is set and set-upstream succeeds", () => {
    const r = run(
      git((argv) => {
        const e = localExists(argv);
        if (e) return e;
        if (has(argv, "refs/remotes/origin/")) return { status: 0 };
        if (argv[2] === "branch" && has(argv, "--format")) return { status: 0, stdout: "" }; // no upstream
        if (argv[2] === "branch" && has(argv, "--set-upstream-to")) return { status: 0 };
        return { status: 0 };
      }),
    );
    expect(r.status).toBe("upstream-fixed");
  });

  test("error when set-upstream fails", () => {
    const r = run(
      git((argv) => {
        const e = localExists(argv);
        if (e) return e;
        if (has(argv, "refs/remotes/origin/")) return { status: 0 };
        if (argv[2] === "branch" && has(argv, "--format")) return { status: 0, stdout: "" };
        if (argv[2] === "branch" && has(argv, "--set-upstream-to"))
          return { status: 1, stderr: "detached" };
        return { status: 0 };
      }),
    );
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/detached/);
  });
});
