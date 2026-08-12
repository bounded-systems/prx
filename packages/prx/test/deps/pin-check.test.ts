import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkPins,
  classifySpec,
  isFailing,
  type Manifest,
  renderReport,
  unwrapAlias,
} from "../../src/deps/pin-check.ts";

const manifest = (path: string, json: Record<string, unknown>): Manifest => ({ path, json });

describe("classifySpec", () => {
  test("exact versions are pinned", () => {
    for (const spec of ["1.2.3", "0.0.1", "2.5.1", "1.2.3-rc.1", "1.2.3+build.5"]) {
      expect(classifySpec(spec).kind).toBe("pinned");
    }
  });

  test("every floating form named in GH-1039 is caught", () => {
    // The literal acceptance list from the ticket: ^, ~, *, x, latest, git refs.
    for (const spec of [
      "^1.2.3",
      "~1.2.3",
      "*",
      "x",
      "1.x",
      "latest",
      ">=1.2.3",
      "1.2.3 - 2.0.0",
    ]) {
      expect(classifySpec(spec).kind).toBe("floating");
    }
  });

  test("an empty or version-less spec is a float, not an exemption", () => {
    expect(classifySpec("").kind).toBe("floating");
    expect(classifySpec("npm:some-pkg").kind).toBe("floating");
    expect(classifySpec("npm:@jsr/scope__name").kind).toBe("floating");
  });

  test("a range hidden inside an npm: alias is still a range", () => {
    // ~25 direct deps in this repo are declared this way; a bad split would
    // silently exempt all of them.
    expect(classifySpec("npm:@jsr/bounded-systems__cas@^0.1.1").kind).toBe("floating");
    expect(classifySpec("npm:@jsr/bounded-systems__cas@0.1.2").kind).toBe("pinned");
  });

  test("unwrapAlias splits on the last @ so scoped names survive", () => {
    expect(unwrapAlias("npm:@jsr/bounded-systems__anchored-chain@0.2.2")).toBe("0.2.2");
    expect(unwrapAlias("^1.2.3")).toBe("^1.2.3");
  });

  test("local protocols are exempt, not pinned-by-accident", () => {
    for (const spec of [
      "workspace:*",
      "workspace:^",
      "file:../x",
      "link:../x",
      "catalog:default",
    ]) {
      expect(classifySpec(spec).kind).toBe("exempt");
    }
  });

  test("git deps pin only to a 40-hex commit sha", () => {
    expect(classifySpec("git+https://github.com/o/r.git#main").kind).toBe("floating");
    expect(classifySpec("git+https://github.com/o/r.git#v1.2.3").kind).toBe("floating");
    expect(classifySpec("github:o/r").kind).toBe("floating");
    expect(
      classifySpec("git+https://github.com/o/r.git#3d3c42e9f0a1b2c4d5e6f708192a3b4c5d6e7f80").kind,
    ).toBe("pinned");
  });
});

describe("checkPins scope", () => {
  test("peerDependencies are never reported — pinning one breaks consumers", () => {
    const report = checkPins([
      manifest("packages/prx-config/package.json", {
        peerDependencies: { zod: "^3.25.0 || ^4.0.0" },
      }),
    ]);
    expect(report.violations).toBeEmpty();
    expect(report.examined).toBe(0);
  });

  test("overrides/resolutions are never reported — they pin transitives (GH-1038)", () => {
    const report = checkPins([
      manifest("package.json", {
        overrides: { hono: "4.12.34", "fast-uri": "3.1.5" },
        resolutions: { something: "^1.0.0" },
      }),
    ]);
    expect(report.violations).toBeEmpty();
  });

  test("dependencies, devDependencies and optionalDependencies are all in scope", () => {
    const report = checkPins([
      manifest("package.json", {
        dependencies: { a: "^1.0.0" },
        devDependencies: { b: "~2.0.0" },
        optionalDependencies: { c: "*" },
      }),
    ]);
    expect(report.violations.map((v) => v.name).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("the shrinking allowlist", () => {
  const floated = [manifest("package.json", { dependencies: { flaky: "^1.0.0" } })];

  test("an allowlisted float passes but stays visible", () => {
    const report = checkPins(floated, {
      entries: [
        {
          manifest: "package.json",
          field: "dependencies",
          name: "flaky",
          reason: "upstream ships no exact tag yet",
        },
      ],
    });
    expect(report.violations).toBeEmpty();
    expect(report.allowed).toHaveLength(1);
    expect(isFailing(report)).toBeFalse();
    expect(renderReport(report)).toContain("draining");
  });

  test("an allowlist entry with no reason fails — the reason is the point", () => {
    const report = checkPins(floated, {
      entries: [{ manifest: "package.json", field: "dependencies", name: "flaky" }],
    });
    expect(report.unexplained).toHaveLength(1);
    expect(isFailing(report)).toBeTrue();
  });

  test("an entry with a blank reason fails too", () => {
    const report = checkPins(floated, {
      entries: [{ manifest: "package.json", field: "dependencies", name: "flaky", reason: "   " }],
    });
    expect(report.unexplained).toHaveLength(1);
    expect(isFailing(report)).toBeTrue();
  });

  test("the list can only shrink: an entry whose dep got pinned is stale and fails", () => {
    const report = checkPins([manifest("package.json", { dependencies: { flaky: "1.0.0" } })], {
      entries: [
        {
          manifest: "package.json",
          field: "dependencies",
          name: "flaky",
          reason: "upstream ships no exact tag yet",
        },
      ],
    });
    expect(report.stale).toHaveLength(1);
    expect(isFailing(report)).toBeTrue();
    expect(renderReport(report)).toContain("only shrinks");
  });

  test("an allowlist entry cannot cover a different manifest's dep", () => {
    const report = checkPins(
      [
        manifest("package.json", { dependencies: { flaky: "^1.0.0" } }),
        manifest("packages/p/package.json", { dependencies: { flaky: "^1.0.0" } }),
      ],
      {
        entries: [
          {
            manifest: "package.json",
            field: "dependencies",
            name: "flaky",
            reason: "root only",
          },
        ],
      },
    );
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.manifest).toBe("packages/p/package.json");
  });
});

describe("renderReport teaches the fix", () => {
  test("a violation names the file, the spec and the command to run", () => {
    const out = renderReport(
      checkPins([manifest("package.json", { devDependencies: { ajv: "^8.17.1" } })]),
    );
    expect(out).toContain("package.json");
    expect(out).toContain("devDependencies.ajv");
    expect(out).toContain("^8.17.1");
    expect(out).toContain("bun install");
  });
});

/**
 * Rule 3 binds the gate to itself: "a gate's claim about itself is not
 * evidence". These drive the REAL script — exit code and all — against fixture
 * trees written to a tmpdir, so a regression that made the gate silently
 * pass-everything would fail here.
 *
 * The fixtures are built at runtime rather than committed: a checked-in
 * `package.json` full of carets would be picked up by dependabot and by the
 * gate's own workspace walk.
 */
describe("check-dep-pins CLI (fixture-driven)", () => {
  const script = join(import.meta.dir, "..", "..", "scripts", "check-dep-pins.ts");

  function withFixture(
    root: Record<string, unknown>,
    extra: {
      pkgs?: Record<string, Record<string, unknown>>;
      allowlist?: unknown;
      lock?: unknown;
    } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "pin-check-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify(root, null, 2));
    if (extra.pkgs) {
      for (const [name, json] of Object.entries(extra.pkgs)) {
        mkdirSync(join(dir, "packages", name), { recursive: true });
        writeFileSync(join(dir, "packages", name, "package.json"), JSON.stringify(json, null, 2));
      }
    }
    if (extra.lock !== undefined) {
      writeFileSync(join(dir, "bun.lock"), JSON.stringify(extra.lock, null, 2));
    }
    if (extra.allowlist !== undefined) {
      writeFileSync(
        join(dir, ".dep-pins-allowlist.json"),
        JSON.stringify(extra.allowlist, null, 2),
      );
    }
    return dir;
  }

  function run(dir: string) {
    const r = Bun.spawnSync(["bun", script, "--root", dir], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  }

  test("FAILS on a deliberately floated fixture", () => {
    const dir = withFixture({
      name: "fixture",
      dependencies: { xstate: "^5.32.5" },
      devDependencies: { typescript: "~6.0.3", knip: "latest" },
    });
    try {
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("xstate");
      expect(out).toContain("typescript");
      expect(out).toContain("knip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS on a float in a workspace member, not just the root", () => {
    const dir = withFixture(
      { name: "fixture", dependencies: { xstate: "5.32.5" } },
      { pkgs: { inner: { name: "inner", dependencies: { zod: "^4.4.3" } } } },
    );
    try {
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("packages/inner/package.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS on a floating JSR alias", () => {
    const dir = withFixture({
      name: "fixture",
      dependencies: { "@bounded-systems/cas": "npm:@jsr/bounded-systems__cas@^0.1.1" },
    });
    try {
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("@bounded-systems/cas");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS on a stale allowlist entry (the ratchet cannot rot)", () => {
    const dir = withFixture(
      { name: "fixture", dependencies: { xstate: "5.32.5" } },
      {
        allowlist: {
          entries: [
            {
              manifest: "package.json",
              field: "dependencies",
              name: "xstate",
              reason: "stale — xstate is pinned now",
            },
          ],
        },
      },
    );
    try {
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("PASSES on a fully pinned fixture, peer ranges and all", () => {
    const dir = withFixture(
      {
        name: "fixture",
        dependencies: { xstate: "5.32.5", "@bounded-systems/x": "workspace:*" },
        devDependencies: { typescript: "6.0.3" },
        overrides: { hono: "4.12.34" },
      },
      {
        pkgs: {
          inner: {
            name: "inner",
            peerDependencies: { zod: "^3.25.0 || ^4.0.0" },
            dependencies: { "@bounded-systems/cas": "npm:@jsr/bounded-systems__cas@0.1.2" },
          },
        },
      },
    );
    try {
      const { code, out } = run(dir);
      expect(code).toBe(0);
      expect(out).toContain("pinned exactly");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS when a pin disagrees with what bun.lock resolves", () => {
    const dir = withFixture(
      { name: "fixture", dependencies: { xstate: "5.32.5" } },
      {
        // The lock resolves 5.32.9; the manifest claims 5.32.5. Pinned, but
        // still not recording what the tree installs.
        lock: {
          lockfileVersion: 1,
          workspaces: { "": { name: "fixture", dependencies: { xstate: "5.32.5" } } },
          packages: { xstate: ["xstate@5.32.9", "", {}, "sha512-deadbeef"] },
        },
      },
    );
    try {
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("does not resolve");
      expect(out).toContain("5.32.5");
      expect(out).toContain("5.32.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves an alias by its alias key, not the underlying package name", () => {
    // The trap this check was written around: bun.lock carries BOTH keys at
    // different versions. Reading the wrong one silently pins a transitive's
    // version onto a direct dep.
    const dir = withFixture(
      {
        name: "fixture",
        dependencies: { "@bs/disposition": "npm:@jsr/bs__disposition@0.2.0" },
      },
      {
        lock: {
          lockfileVersion: 1,
          workspaces: { "": { name: "fixture" } },
          packages: {
            "@bs/disposition": ["@jsr/bs__disposition@0.2.0", "", {}, "sha512-a"],
            "@jsr/bs__disposition": ["@jsr/bs__disposition@0.3.0", "", {}, "sha512-b"],
          },
        },
      },
    );
    try {
      // 0.2.0 is what the ALIAS resolves to, so this must pass. It would fail
      // if the lookup went through "@jsr/bs__disposition" (0.3.0).
      expect(run(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tolerates a lockfile with trailing commas (bun writes JSONC)", () => {
    const dir = withFixture({ name: "fixture", dependencies: { xstate: "5.32.5" } });
    writeFileSync(
      join(dir, "bun.lock"),
      '{\n  "packages": {\n    "xstate": ["xstate@5.32.9", "", {}, "sha512-x"],\n  },\n}\n',
    );
    try {
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("5.32.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("PASSES on this repo's own tree — the gate's live claim", () => {
    const { code } = run(join(import.meta.dir, "..", "..", "..", ".."));
    expect(code).toBe(0);
  });
});
