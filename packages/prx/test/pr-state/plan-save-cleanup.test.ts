// GH-1336 — `prx plan save --cleanup={none|delete|move-to=PATH}`.
//
// Coverage: the four CLI modes (default, delete, move-to, parse rejection
// without --from-file) plus the atomicity invariant: when runPlanSave throws,
// the staging file is left untouched. The fail-fast invariant for
// `move-to=<missing>` is asserted via the stat seam — the stat call must
// reject before runPlanSave is invoked.

import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

function captureOutput(): { logs: string[]; errors: string[]; output: Output } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    },
  };
}

const FAKE_SHA = "deadbeef".repeat(8);
const VALID_BODY = "# Plan\n\n## Scope\n\n- Real scope.\n";

describe("prx plan save — staging-file cleanup (GH-1336)", () => {
  test("default --cleanup=none leaves the staging file untouched", async () => {
    const { output } = captureOutput();
    const stagingPath = "/cache/staging/GH-1336-test.md";
    let unlinkCalls = 0;
    let renameCalls = 0;

    const exit = await runCli(
      ["plan", "save", "--unit", "GH-1336", "--from-file", stagingPath],
      output,
      {
        readPlanFile: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => ({ sha: FAKE_SHA, ref: "GH-1336:plan@draft", body_sha: FAKE_SHA, envelope_sha: FAKE_SHA, validated_ok: true, diagnostics: [] }),
        unlinkPlanFile: () => {
          unlinkCalls++;
        },
        renamePlanFile: () => {
          renameCalls++;
        },
      },
    );

    expect(exit).toBe(0);
    expect(unlinkCalls).toBe(0);
    expect(renameCalls).toBe(0);
  });

  test("--cleanup=delete unlinks the staging path after save", async () => {
    const { logs, output } = captureOutput();
    const stagingPath = "/cache/staging/GH-1336-test.md";
    const unlinked: string[] = [];
    let saveOrder = 0;
    let unlinkOrder = 0;
    let counter = 0;

    const exit = await runCli(
      [
        "plan",
        "save",
        "--unit",
        "GH-1336",
        "--from-file",
        stagingPath,
        "--cleanup=delete",
      ],
      output,
      {
        readPlanFile: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => {
          saveOrder = ++counter;
          return { sha: FAKE_SHA, ref: "GH-1336:plan@draft", body_sha: FAKE_SHA, envelope_sha: FAKE_SHA, validated_ok: true, diagnostics: [] };
        },
        unlinkPlanFile: (path) => {
          unlinkOrder = ++counter;
          unlinked.push(path);
        },
      },
    );

    expect(exit).toBe(0);
    expect(unlinked).toEqual([stagingPath]);
    // Cleanup runs strictly after the save resolves (atomicity invariant).
    expect(saveOrder).toBeLessThan(unlinkOrder);
    expect(logs).toEqual([FAKE_SHA]);
  });

  test("--cleanup=move-to renames staging file to dest/<basename>", async () => {
    const { output } = captureOutput();
    const stagingPath = "/cache/staging/GH-1336-test.md";
    const archive = "/tmp/gh1336-archive";
    const renames: Array<{ src: string; dest: string }> = [];
    const stats: string[] = [];

    const exit = await runCli(
      [
        "plan",
        "save",
        "--unit",
        "GH-1336",
        "--from-file",
        stagingPath,
        `--cleanup=move-to=${archive}`,
      ],
      output,
      {
        readPlanFile: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => ({ sha: FAKE_SHA, ref: "GH-1336:plan@draft", body_sha: FAKE_SHA, envelope_sha: FAKE_SHA, validated_ok: true, diagnostics: [] }),
        statPath: (path) => {
          stats.push(path);
          return { isDirectory: () => true };
        },
        renamePlanFile: (src, dest) => {
          renames.push({ src, dest });
        },
      },
    );

    expect(exit).toBe(0);
    expect(stats).toEqual([archive]);
    expect(renames).toEqual([
      { src: stagingPath, dest: `${archive}/GH-1336-test.md` },
    ]);
  });

  test("--cleanup=move-to=<nonexistent> fails fast — runPlanSave never called", async () => {
    const { errors, output } = captureOutput();
    const stagingPath = "/cache/staging/GH-1336-test.md";
    const missing = "/tmp/does-not-exist";
    let saveCalls = 0;
    let renameCalls = 0;

    const exit = await runCli(
      [
        "plan",
        "save",
        "--unit",
        "GH-1336",
        "--from-file",
        stagingPath,
        `--cleanup=move-to=${missing}`,
      ],
      output,
      {
        readPlanFile: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => {
          saveCalls++;
          return { sha: FAKE_SHA, ref: "GH-1336:plan@draft", body_sha: FAKE_SHA, envelope_sha: FAKE_SHA, validated_ok: true, diagnostics: [] };
        },
        statPath: () => {
          throw new Error("ENOENT: no such file or directory");
        },
        renamePlanFile: () => {
          renameCalls++;
        },
      },
    );

    expect(exit).not.toBe(0);
    expect(saveCalls).toBe(0);
    expect(renameCalls).toBe(0);
    expect(errors.join("\n")).toContain(missing);
    expect(errors.join("\n")).toContain("must point to an existing directory");
  });

  test("--cleanup=move-to=<file> (non-directory) fails fast — save never called", async () => {
    const { errors, output } = captureOutput();
    const stagingPath = "/cache/staging/GH-1336-test.md";
    const notADir = "/tmp/not-a-dir";
    let saveCalls = 0;

    const exit = await runCli(
      [
        "plan",
        "save",
        "--unit",
        "GH-1336",
        "--from-file",
        stagingPath,
        `--cleanup=move-to=${notADir}`,
      ],
      output,
      {
        readPlanFile: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => {
          saveCalls++;
          return { sha: FAKE_SHA, ref: "GH-1336:plan@draft", body_sha: FAKE_SHA, envelope_sha: FAKE_SHA, validated_ok: true, diagnostics: [] };
        },
        statPath: () => ({ isDirectory: () => false }),
      },
    );

    expect(exit).not.toBe(0);
    expect(saveCalls).toBe(0);
    expect(errors.join("\n")).toContain(notADir);
  });

  test("atomicity: save throws ⇒ staging file untouched (no unlink, no rename)", async () => {
    const { output } = captureOutput();
    const stagingPath = "/cache/staging/GH-1336-test.md";
    let unlinkCalls = 0;
    let renameCalls = 0;

    const exit = await runCli(
      [
        "plan",
        "save",
        "--unit",
        "GH-1336",
        "--from-file",
        stagingPath,
        "--cleanup=delete",
      ],
      output,
      {
        readPlanFile: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => {
          throw new Error("simulated CAS failure");
        },
        unlinkPlanFile: () => {
          unlinkCalls++;
        },
        renamePlanFile: () => {
          renameCalls++;
        },
      },
    );

    expect(exit).not.toBe(0);
    expect(unlinkCalls).toBe(0);
    expect(renameCalls).toBe(0);
  });

  test("--cleanup with --from-stdin is rejected at parse time", async () => {
    const { errors, output } = captureOutput();
    let saveCalls = 0;

    const exit = await runCli(
      [
        "plan",
        "save",
        "--unit",
        "GH-1336",
        "--from-stdin",
        "--cleanup=delete",
      ],
      output,
      {
        readStdinSync: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => {
          saveCalls++;
          return { sha: FAKE_SHA, ref: "GH-1336:plan@draft", body_sha: FAKE_SHA, envelope_sha: FAKE_SHA, validated_ok: true, diagnostics: [] };
        },
      },
    );

    expect(exit).not.toBe(0);
    expect(saveCalls).toBe(0);
    expect(errors.join("\n")).toContain("--cleanup");
    expect(errors.join("\n")).toContain("--from-file");
  });

  test("invalid --cleanup value rejected (e.g., 'archive')", async () => {
    const { errors, output } = captureOutput();
    let saveCalls = 0;

    const exit = await runCli(
      [
        "plan",
        "save",
        "--unit",
        "GH-1336",
        "--from-file",
        "/cache/staging/GH-1336-test.md",
        "--cleanup=archive",
      ],
      output,
      {
        readPlanFile: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => {
          saveCalls++;
          return { sha: FAKE_SHA, ref: "GH-1336:plan@draft", body_sha: FAKE_SHA, envelope_sha: FAKE_SHA, validated_ok: true, diagnostics: [] };
        },
      },
    );

    expect(exit).not.toBe(0);
    expect(saveCalls).toBe(0);
    expect(errors.join("\n")).toContain("invalid --cleanup");
  });

  test("--cleanup=move-to= with empty path rejected", async () => {
    const { errors, output } = captureOutput();
    let saveCalls = 0;

    const exit = await runCli(
      [
        "plan",
        "save",
        "--unit",
        "GH-1336",
        "--from-file",
        "/cache/staging/GH-1336-test.md",
        "--cleanup=move-to=",
      ],
      output,
      {
        readPlanFile: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => {
          saveCalls++;
          return { sha: FAKE_SHA, ref: "GH-1336:plan@draft", body_sha: FAKE_SHA, envelope_sha: FAKE_SHA, validated_ok: true, diagnostics: [] };
        },
      },
    );

    expect(exit).not.toBe(0);
    expect(saveCalls).toBe(0);
    expect(errors.join("\n")).toContain("destination path");
  });
});
