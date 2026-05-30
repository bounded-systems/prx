// GH-1689 / GH-1684 / GH-1701 — disk-shape classifier for `.beads/` workspace
// mode and its operator-facing hint formatter. Tests run against real tmp dirs
// (the classifier reads only fs; shared-server mode also reads
// $HOME/.beads/shared-server/, which we redirect by passing an injected
// `homeDir` option to keep tests hermetic).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  beadsModeHint,
  classifyBeadsWorkspace,
} from "../../src/beads/workspace_mode.ts";

function makeTmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "prx-workspace-mode-"));
}

function makeTmpHome(): string {
  return mkdtempSync(join(tmpdir(), "prx-workspace-mode-home-"));
}

describe("classifyBeadsWorkspace (GH-1684)", () => {
  test("no .beads/ at all → kind: 'none'", () => {
    const cwd = makeTmpCwd();
    expect(classifyBeadsWorkspace(cwd)).toEqual({ kind: "none" });
  });

  test(".beads/dolt/ present → kind: 'per_project'", () => {
    const cwd = makeTmpCwd();
    mkdirSync(join(cwd, ".beads", "dolt"), { recursive: true });
    const mode = classifyBeadsWorkspace(cwd);
    expect(mode.kind).toBe("per_project");
    if (mode.kind === "per_project") {
      expect(mode.doltDir).toBe(join(cwd, ".beads", "dolt"));
    }
  });

  test(".beads/embeddeddolt/<ws>/.dolt present → kind: 'embedded'", () => {
    const cwd = makeTmpCwd();
    mkdirSync(join(cwd, ".beads", "embeddeddolt", "ws1", ".dolt"), { recursive: true });
    const mode = classifyBeadsWorkspace(cwd);
    expect(mode.kind).toBe("embedded");
    if (mode.kind === "embedded") {
      expect(mode.doltDir).toBe(join(cwd, ".beads", "embeddeddolt", "ws1", ".dolt"));
    }
  });

  test(".beads/ present with neither layout → kind: 'ambiguous'", () => {
    const cwd = makeTmpCwd();
    mkdirSync(join(cwd, ".beads"), { recursive: true });
    const mode = classifyBeadsWorkspace(cwd);
    expect(mode.kind).toBe("ambiguous");
    if (mode.kind === "ambiguous") {
      expect(mode.details.length).toBeGreaterThan(0);
    }
  });

  test(".beads/embeddeddolt/ present with no <ws>/.dolt child → kind: 'ambiguous'", () => {
    const cwd = makeTmpCwd();
    mkdirSync(join(cwd, ".beads", "embeddeddolt"), { recursive: true });
    const mode = classifyBeadsWorkspace(cwd);
    expect(mode.kind).toBe("ambiguous");
  });

  test("metadata dolt_mode=server + ~/.beads/shared-server/dolt/<db>/ present → kind: 'shared_server' (GH-1701)", () => {
    const cwd = makeTmpCwd();
    const home = makeTmpHome();
    mkdirSync(join(cwd, ".beads"), { recursive: true });
    writeFileSync(
      join(cwd, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "server", dolt_database: "demo_beads" }),
    );
    const sharedDir = join(home, ".beads", "shared-server", "dolt", "demo_beads");
    mkdirSync(sharedDir, { recursive: true });

    const mode = classifyBeadsWorkspace(cwd, { homeDir: home });
    expect(mode.kind).toBe("shared_server");
    if (mode.kind === "shared_server") {
      expect(mode.sharedDir).toBe(sharedDir);
    }
  });

  test("metadata dolt_mode=server but shared-server dolt dir missing → falls through to per_project/ambiguous (GH-1701)", () => {
    const cwd = makeTmpCwd();
    const home = makeTmpHome();
    mkdirSync(join(cwd, ".beads"), { recursive: true });
    writeFileSync(
      join(cwd, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "server", dolt_database: "demo_beads" }),
    );
    // No ~/.beads/shared-server/dolt/demo_beads/ created.
    // Also no .beads/dolt/ → should land at ambiguous.
    const mode = classifyBeadsWorkspace(cwd, { homeDir: home });
    expect(mode.kind).toBe("ambiguous");
  });

  test("metadata dolt_mode=server with per-project .beads/dolt/ also present → shared_server wins (GH-1701)", () => {
    // Defensive: a repo mid-migration could have both a populated shared-server
    // dolt dir AND a stale .beads/dolt/ from the prior per-project layout. The
    // classifier should report shared_server (the source of truth) rather than
    // misclassify as per_project.
    const cwd = makeTmpCwd();
    const home = makeTmpHome();
    mkdirSync(join(cwd, ".beads", "dolt"), { recursive: true });
    writeFileSync(
      join(cwd, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "server", dolt_database: "demo_beads" }),
    );
    mkdirSync(join(home, ".beads", "shared-server", "dolt", "demo_beads"), {
      recursive: true,
    });

    const mode = classifyBeadsWorkspace(cwd, { homeDir: home });
    expect(mode.kind).toBe("shared_server");
  });
});

describe("beadsModeHint (GH-1684)", () => {
  test("per_project returns null (ready to dispatch)", () => {
    expect(
      beadsModeHint({ kind: "per_project", doltDir: "/x" }, "foo"),
    ).toBeNull();
  });

  test("shared_server returns null (ready to dispatch) (GH-1701)", () => {
    expect(
      beadsModeHint({ kind: "shared_server", sharedDir: "/x" }, "foo"),
    ).toBeNull();
  });

  test("none returns the GH-493 bootstrap hint with the slug interpolated", () => {
    const hint = beadsModeHint({ kind: "none" }, "demo-repo");
    expect(hint).not.toBeNull();
    expect(hint).toContain("demo-repo");
    expect(hint).toContain("GH-493");
  });

  test("embedded returns the GH-1471 migration hint and references bd-safe / GH-1061", () => {
    const hint = beadsModeHint(
      { kind: "embedded", doltDir: "/x" },
      "demo-repo",
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("demo-repo");
    expect(hint).toContain("embedded mode");
    expect(hint).toContain("GH-1471");
    expect(hint).toContain("GH-1061");
  });

  test("ambiguous suggests `prx repo refresh <slug>`", () => {
    const hint = beadsModeHint(
      { kind: "ambiguous", details: "x" },
      "foo",
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("prx repo refresh foo");
  });
});
