// GH-1706 — `prx beads migrate` (embedded → shared-server).
//
// Pure-runner tests against real tmp dirs with the bd runner faked. The
// classifier inspects `.beads/` on disk, so each refusal arm seeds the
// matching disk shape. The destructive bd commands never spawn — the
// fake runner returns scripted SpawnCaptureResults keyed on `cmd[1]`
// (`init`/`export`/`dolt`/`list`) so we can assert per-step ordering and
// failure handling.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  runBeadsMigrate,
  type MigrateDeps,
  type MigrateEventName,
} from "../../src/beads/migrate.ts";
import type { LocalRepo } from "../../src/pr-state/repos.ts";
import type { SpawnCaptureResult } from "@bounded-systems/proc";
import type { BdMigrateRunner } from "../../src/beads/migrate_runner.ts";

const FIXTURE_SHOW_SERVER = readFileSync(
  join(import.meta.dir, "fixtures", "migrate", "dolt-show-server.txt"),
  "utf8",
);
const FIXTURE_SHOW_MISMATCH = readFileSync(
  join(import.meta.dir, "fixtures", "migrate", "dolt-show-mismatch.txt"),
  "utf8",
);

function makeTmpDirs(): { cwd: string; home: string } {
  return {
    cwd: mkdtempSync(join(tmpdir(), "prx-migrate-")),
    home: mkdtempSync(join(tmpdir(), "prx-migrate-home-")),
  };
}

function seedEmbeddedRepo(cwd: string): void {
  // Embedded layout: `.beads/embeddeddolt/<ws>/.dolt/`.
  mkdirSync(join(cwd, ".beads", "embeddeddolt", "ws1", ".dolt"), {
    recursive: true,
  });
  // metadata.json starts in pre-migration shape (GH-1695 patch flips it).
  writeFileSync(
    join(cwd, ".beads", "metadata.json"),
    `${JSON.stringify({ dolt_mode: "embedded", dolt_database: "demo_beads" }, null, 2)}\n`,
  );
}

function seedJsonl(cwd: string, contents = '{"id":"BD-demo-1"}\n'): void {
  writeFileSync(join(cwd, ".beads", "issues.jsonl"), contents);
}

function fakeRepo(cwd: string, overrides: Partial<LocalRepo> = {}): LocalRepo {
  return {
    name: "demo",
    commonDir: cwd,
    kind: "bare",
    mainWorktree: null,
    worktrees: [],
    localOnlyBranches: [],
    findings: [],
    remotes: [],
    primaryRemote: null,
    upstreamRemote: null,
    bd_workspace_prefix: "demo",
    ...overrides,
  };
}

function ok(stdout = ""): SpawnCaptureResult {
  return { status: 0, signal: null, stdout, stderr: "" };
}

function nonZero(stderr: string, status = 1): SpawnCaptureResult {
  return { status, signal: null, stdout: "", stderr };
}

type RunnerCall = { cmd: readonly string[]; cwd: string | undefined };

function makeRunner(
  responder: (call: RunnerCall) => SpawnCaptureResult,
): { runner: BdMigrateRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: BdMigrateRunner = (cmd, options) => {
    const call = { cmd, cwd: options?.cwd };
    calls.push(call);
    return responder(call);
  };
  return { runner, calls };
}

function happyResponder(call: RunnerCall): SpawnCaptureResult {
  if (call.cmd[1] === "export") return ok('{"id":"BD-demo-1"}\n');
  if (call.cmd[1] === "init") return ok("");
  if (call.cmd[1] === "dolt") return ok(FIXTURE_SHOW_SERVER);
  if (call.cmd[1] === "list") return ok("BD-demo-1  open  example bead\n");
  return nonZero(`unexpected: ${call.cmd.join(" ")}`);
}

function recordedEvents(): {
  recordEvent: NonNullable<MigrateDeps["recordEvent"]>;
  events: MigrateEventName[];
  details: Record<string, unknown>[];
} {
  const events: MigrateEventName[] = [];
  const details: Record<string, unknown>[] = [];
  return {
    events,
    details,
    recordEvent: (event, opts) => {
      events.push(event);
      details.push({ event, ...(opts ?? {}) });
    },
  };
}

describe("runBeadsMigrate refusals (GH-1706)", () => {
  test("slug-not-found when resolveRepo returns null", () => {
    const { cwd, home } = makeTmpDirs();
    const result = runBeadsMigrate(
      { slug: "nope" },
      {
        cwd,
        homeDir: home,
        resolveRepo: () => null,
      },
    );
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toBe("slug-not-found");
    }
  });

  test("not-embedded when classifier reports per-project", () => {
    const { cwd, home } = makeTmpDirs();
    mkdirSync(join(cwd, ".beads", "dolt"), { recursive: true });
    const result = runBeadsMigrate(
      {},
      {
        cwd,
        homeDir: home,
        resolveRepo: () => fakeRepo(cwd),
      },
    );
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toBe("not-embedded");
      // already migrated to per-project, hint flags v2 work.
      expect(result.hint).toContain("per-project");
    }
  });

  test("missing-jsonl when .beads/issues.jsonl is absent", () => {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    const result = runBeadsMigrate(
      {},
      { cwd, homeDir: home, resolveRepo: () => fakeRepo(cwd) },
    );
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("missing-jsonl");
  });

  test("empty-workspace when issues.jsonl is zero-length", () => {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    seedJsonl(cwd, "");
    const result = runBeadsMigrate(
      {},
      { cwd, homeDir: home, resolveRepo: () => fakeRepo(cwd) },
    );
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("empty-workspace");
  });

  test("stale-jsonl when issues.jsonl mtime is older than the threshold", () => {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    seedJsonl(cwd);
    // Push mtime 7200s into the past; default threshold is 3600s.
    const jsonl = join(cwd, ".beads", "issues.jsonl");
    const old = new Date(Date.now() - 7200_000);
    utimesSync(jsonl, old, old);
    const result = runBeadsMigrate(
      {},
      { cwd, homeDir: home, resolveRepo: () => fakeRepo(cwd) },
    );
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("stale-jsonl");
  });
});

describe("runBeadsMigrate dry-run (GH-1706)", () => {
  test("dry-run lists planned steps and derives DESTROY-<prefix> from inventory; no on-disk changes", () => {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    seedJsonl(cwd);
    const { runner, calls } = makeRunner(happyResponder);
    const { recordEvent, events } = recordedEvents();

    const before = readdirSync(cwd).sort();
    const result = runBeadsMigrate(
      { dryRun: true },
      {
        cwd,
        homeDir: home,
        resolveRepo: () => fakeRepo(cwd),
        runner,
        recordEvent,
      },
    );
    const after = readdirSync(cwd).sort();
    expect(after).toEqual(before);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);

    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.slug).toBe("demo");
      expect(result.plannedBackupDir).toContain(
        join(home, ".local", "state", "prx", "migrations"),
      );
      expect(result.plannedBackupDir).toContain("demo-");
      const reinitStep = result.plannedSteps.find((step) =>
        step.startsWith("bd init "),
      );
      expect(reinitStep).toBeDefined();
      expect(reinitStep!).toContain("--reinit-local");
      expect(reinitStep!).toContain("--shared-server");
      expect(reinitStep!).toContain("--prefix=demo");
      expect(reinitStep!).toContain("--destroy-token=DESTROY-demo");
      // patch-metadata default-on → step is included.
      expect(
        result.plannedSteps.some((step) => step.startsWith("patch-metadata:")),
      ).toBe(true);
    }
  });

  test("dry-run with --no-patch-metadata omits the metadata step", () => {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    seedJsonl(cwd);
    const result = runBeadsMigrate(
      { dryRun: true, patchMetadata: false },
      { cwd, homeDir: home, resolveRepo: () => fakeRepo(cwd) },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(
        result.plannedSteps.some((step) => step.startsWith("patch-metadata:")),
      ).toBe(false);
    }
  });
});

describe("runBeadsMigrate apply (GH-1706)", () => {
  test("happy path emits the full BD_MIGRATION_* sequence in order", () => {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    seedJsonl(cwd);
    const { runner } = makeRunner(happyResponder);
    const { recordEvent, events } = recordedEvents();
    const result = runBeadsMigrate(
      {},
      {
        cwd,
        homeDir: home,
        resolveRepo: () => fakeRepo(cwd),
        runner,
        recordEvent,
      },
    );
    expect(result.kind).toBe("applied");
    expect(events).toEqual([
      "BD_MIGRATION_STARTED",
      "BD_MIGRATION_BACKUP_WRITTEN",
      "BD_MIGRATION_REINIT_COMPLETED",
      "BD_MIGRATION_METADATA_PATCHED",
      "BD_MIGRATION_VERIFIED",
      "BD_MIGRATION_COMPLETED",
    ]);
    if (result.kind === "applied") {
      expect(result.slug).toBe("demo");
      expect(result.patchedMetadata).toBe(true);
      expect(statSync(result.backupDir).isDirectory()).toBe(true);
      expect(
        statSync(join(result.backupDir, "issues.jsonl")).size,
      ).toBeGreaterThan(0);
      expect(
        statSync(join(result.backupDir, "beads-full")).isDirectory(),
      ).toBe(true);
      // metadata.json patched in place.
      const patched = JSON.parse(
        readFileSync(join(cwd, ".beads", "metadata.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(patched.dolt_mode).toBe("server");
      expect(result.hint).toContain("prx repo add-dolthub demo");
      expect(result.hint).toContain("prx repo gc demo");
    }
  });

  test("--no-patch-metadata skips BD_MIGRATION_METADATA_PATCHED and leaves metadata.json untouched", () => {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    seedJsonl(cwd);
    const { runner } = makeRunner(happyResponder);
    const { recordEvent, events } = recordedEvents();
    runBeadsMigrate(
      { patchMetadata: false },
      {
        cwd,
        homeDir: home,
        resolveRepo: () => fakeRepo(cwd),
        runner,
        recordEvent,
      },
    );
    expect(events).not.toContain("BD_MIGRATION_METADATA_PATCHED");
    expect(events).toContain("BD_MIGRATION_COMPLETED");
    const metadata = JSON.parse(
      readFileSync(join(cwd, ".beads", "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    // unchanged from seed
    expect(metadata.dolt_mode).toBe("embedded");
  });

  test("verify-failure (regex no-match) emits BD_MIGRATION_FAILED and preserves backup", () => {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    seedJsonl(cwd);
    const { runner } = makeRunner((call) => {
      if (call.cmd[1] === "dolt") return ok(FIXTURE_SHOW_MISMATCH);
      return happyResponder(call);
    });
    const { recordEvent, events } = recordedEvents();
    const result = runBeadsMigrate(
      {},
      {
        cwd,
        homeDir: home,
        resolveRepo: () => fakeRepo(cwd),
        runner,
        recordEvent,
      },
    );
    expect(result.kind).toBe("failed");
    expect(events).toContain("BD_MIGRATION_FAILED");
    expect(events).toContain("BD_MIGRATION_REINIT_COMPLETED");
    expect(events).not.toContain("BD_MIGRATION_VERIFIED");
    expect(events).not.toContain("BD_MIGRATION_COMPLETED");
    if (result.kind === "failed") {
      expect(result.failedAt).toBe("BD_MIGRATION_VERIFIED");
      // backup dir survives for manual rollback.
      expect(statSync(result.backupDir).isDirectory()).toBe(true);
      expect(
        statSync(join(result.backupDir, "issues.jsonl")).size,
      ).toBeGreaterThan(0);
    }
  });

  test("reinit failure stops before metadata patch and preserves backup", () => {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    seedJsonl(cwd);
    const { runner } = makeRunner((call) => {
      if (call.cmd[1] === "init") return nonZero("dolt: cannot reinit");
      return happyResponder(call);
    });
    const { recordEvent, events } = recordedEvents();
    const result = runBeadsMigrate(
      {},
      {
        cwd,
        homeDir: home,
        resolveRepo: () => fakeRepo(cwd),
        runner,
        recordEvent,
      },
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.failedAt).toBe("BD_MIGRATION_REINIT_COMPLETED");
      expect(result.detail).toContain("bd init --reinit-local");
    }
    expect(events).not.toContain("BD_MIGRATION_METADATA_PATCHED");
    expect(events).not.toContain("BD_MIGRATION_VERIFIED");
  });
});
describe("runBeadsMigrate refusals — non-embedded modes (GH-1706)", () => {
  test("none (no .beads) → not-embedded with the beads-init hint", () => {
    const { cwd, home } = makeTmpDirs();
    const r = runBeadsMigrate({}, { cwd, homeDir: home, resolveRepo: () => fakeRepo(cwd) });
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.reason).toBe("not-embedded");
      expect(r.hint).toContain("beads-init");
    }
  });

  test("shared_server (metadata server mode) → not-embedded with the add-dolthub hint", () => {
    const { cwd, home } = makeTmpDirs();
    mkdirSync(join(cwd, ".beads"), { recursive: true });
    writeFileSync(
      join(cwd, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "server", dolt_database: "demo_db" }),
    );
    mkdirSync(join(home, ".beads", "shared-server", "dolt", "demo_db"), { recursive: true });
    const r = runBeadsMigrate({}, { cwd, homeDir: home, resolveRepo: () => fakeRepo(cwd) });
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.reason).toBe("not-embedded");
      expect(r.hint).toContain("add-dolthub");
    }
  });

  test("ambiguous (.beads with no dolt subtree) → not-embedded with the refresh hint", () => {
    const { cwd, home } = makeTmpDirs();
    mkdirSync(join(cwd, ".beads"), { recursive: true });
    const r = runBeadsMigrate({}, { cwd, homeDir: home, resolveRepo: () => fakeRepo(cwd) });
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.reason).toBe("not-embedded");
      expect(r.hint).toContain("refresh");
    }
  });
});

describe("runBeadsMigrate apply path (GH-1706)", () => {
  // export/reinit succeed; `dolt show` reports per-project; `list` is non-empty.
  const successRunner = ((cmd: readonly string[]) => {
    const j = cmd.join(" ");
    if (j.includes("dolt show")) return ok("Mode: per-project\n");
    if (/\blist\b/.test(j)) return ok("BD-1\trow\n");
    return ok('{"id":"BD-1"}\n');
  }) as never;

  function runEmbedded(runner: unknown) {
    const { cwd, home } = makeTmpDirs();
    seedEmbeddedRepo(cwd);
    seedJsonl(cwd);
    return runBeadsMigrate(
      {},
      { cwd, homeDir: home, resolveRepo: () => fakeRepo(cwd), runner: runner as never, recordEvent: () => {}, now: () => new Date("2026-01-01T00:00:00.000Z") },
    );
  }

  test("applies on a healthy embedded repo (export → reinit → patch → verify)", () => {
    expect(runEmbedded(successRunner).kind).toBe("applied");
  });

  test("a failing bd export → failed at backup", () => {
    const runner = ((cmd: readonly string[]) => (cmd.includes("export") ? nonZero("disk full") : ok("")));
    expect(runEmbedded(runner).kind).toBe("failed");
  });

  test("a failing reinit → failed", () => {
    const runner = ((cmd: readonly string[]) => {
      const j = cmd.join(" ");
      if (j.includes("export")) return ok('{"id":"BD-1"}\n');
      if (j.includes("init") || j.includes("reinit")) return nonZero("reinit boom");
      return ok("");
    });
    expect(runEmbedded(runner).kind).toBe("failed");
  });

  test("verify failing when `dolt show` is not per-project → failed", () => {
    const runner = ((cmd: readonly string[]) => {
      const j = cmd.join(" ");
      if (j.includes("dolt show")) return ok("Mode: embedded\n");
      if (/\blist\b/.test(j)) return ok("BD-1\trow\n");
      return ok('{"id":"BD-1"}\n');
    });
    expect(runEmbedded(runner).kind).toBe("failed");
  });

  test("verify failing when `bd list` is empty → failed", () => {
    const runner = ((cmd: readonly string[]) => {
      const j = cmd.join(" ");
      if (j.includes("dolt show")) return ok("Mode: per-project\n");
      if (/\blist\b/.test(j)) return ok("");
      return ok('{"id":"BD-1"}\n');
    });
    expect(runEmbedded(runner).kind).toBe("failed");
  });
});

// suppress unused-import lint on the helpers we keep ready for future tests.
void cpSync;
