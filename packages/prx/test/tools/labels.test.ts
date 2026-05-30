import { describe, expect, test } from "bun:test";

import {
  computeLabelDiff,
  formatSyncLabelsResult,
  syncLabels,
  type GhLabel,
  type GhLabelSpawn,
  type GhLabelSpawnResult,
} from "../../src/tools/labels.ts";
import { defaultLabelDefinitions } from "../../src/triage/labels.ts";

function makeLabels(...names: string[]): GhLabel[] {
  // Echo each name back as-is matching the schema's defaults so they don't
  // appear under `updates`. Tests that want drift override description/color.
  const defs = defaultLabelDefinitions();
  return names.map((name) => {
    const def = defs.find((d) => d.name === name);
    return {
      name,
      description: def?.description ?? "legacy",
      color: def?.color ?? "ededed",
    };
  });
}

type SpawnCall = { args: string[]; cwd?: string | undefined };

function makeSpawn(handler: (args: string[]) => GhLabelSpawnResult): {
  spawn: GhLabelSpawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: GhLabelSpawn = (args, options) => {
    calls.push({ args, cwd: options.cwd });
    return handler(args);
  };
  return { spawn, calls };
}

describe("computeLabelDiff", () => {
  test("creates entries for every schema label when GH has none of them", () => {
    const schema = defaultLabelDefinitions();
    const diff = computeLabelDiff(schema, []);
    expect(diff.creates).toHaveLength(schema.length);
    expect(diff.updates).toHaveLength(0);
    expect(diff.unknown).toHaveLength(0);
  });

  test("treats existing labels with matching color+description as a no-op", () => {
    const schema = defaultLabelDefinitions();
    const diff = computeLabelDiff(schema, schema.map((d) => ({ name: d.name, description: d.description, color: d.color })));
    expect(diff.creates).toHaveLength(0);
    expect(diff.updates).toHaveLength(0);
    expect(diff.unknown).toHaveLength(0);
  });

  test("flags color drift as an update", () => {
    const schema = defaultLabelDefinitions();
    const target = schema.find((d) => d.name === "type::feature")!;
    const existing: GhLabel[] = [{ name: target.name, description: target.description, color: "FFFFFF" }];
    const diff = computeLabelDiff(schema, existing);
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0]!.to.name).toBe("type::feature");
  });

  test("flags description drift as an update", () => {
    const schema = defaultLabelDefinitions();
    const target = schema.find((d) => d.name === "priority::high")!;
    const existing: GhLabel[] = [{ name: target.name, description: "old desc", color: target.color }];
    const diff = computeLabelDiff(schema, existing);
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0]!.to.name).toBe("priority::high");
  });

  test("collects out-of-schema labels under unknown", () => {
    const schema = defaultLabelDefinitions();
    const existing: GhLabel[] = [
      { name: "agent::architect", description: "", color: "ededed" },
      { name: "documentation", description: "", color: "0075ca" },
    ];
    const diff = computeLabelDiff(schema, existing);
    expect(diff.unknown.map((l) => l.name).sort()).toEqual(["agent::architect", "documentation"]);
  });
});

describe("syncLabels — dry-run", () => {
  test("computes the full create diff against an empty repo and writes nothing", () => {
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === "label" && args[1] === "list") {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      throw new Error(`unexpected gh call in dry-run: ${args.join(" ")}`);
    });
    const result = syncLabels({ dryRun: true }, { spawn });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["label", "list"]);
    expect(result.dryRun).toBe(true);
    expect(result.diff.creates).toHaveLength(defaultLabelDefinitions().length);
    expect(result.applied.created).toEqual([]);
  });

  test("--repo is forwarded to gh label list", () => {
    const { spawn, calls } = makeSpawn(() => ({ status: 0, stdout: "[]", stderr: "" }));
    syncLabels({ repo: "owner/repo", dryRun: true }, { spawn });
    const args = calls[0]!.args;
    const repoIdx = args.indexOf("--repo");
    expect(repoIdx).toBeGreaterThan(0);
    expect(args[repoIdx + 1]).toBe("owner/repo");
  });
});

describe("syncLabels — apply path", () => {
  test("creates only the labels missing from GH; leaves matching ones alone", () => {
    const schema = defaultLabelDefinitions();
    const existingNames = ["type::bug", "type::feature", "priority::high", "priority::medium", "priority::low", "priority::critical"];
    const existing = makeLabels(...existingNames);

    const { spawn, calls } = makeSpawn((args) => {
      if (args[1] === "list") {
        return { status: 0, stdout: JSON.stringify(existing), stderr: "" };
      }
      if (args[1] === "create" || args[1] === "edit" || args[1] === "delete") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });

    const result = syncLabels({}, { spawn });
    const expectedCreates = schema.filter((d) => !existingNames.includes(d.name)).map((d) => d.name);

    expect(result.applied.created.sort()).toEqual([...expectedCreates].sort());
    expect(result.applied.updated).toEqual([]);
    expect(result.applied.deleted).toEqual([]);

    // Number of gh invocations = 1 list + N creates
    expect(calls.length).toBe(1 + expectedCreates.length);
    for (const call of calls.slice(1)) {
      expect(call.args[0]).toBe("label");
      expect(call.args[1]).toBe("create");
    }
  });

  test("idempotent: a second run after a successful sync produces no new writes", () => {
    const schema = defaultLabelDefinitions();
    // Simulate state: every schema label exists exactly as projected.
    const existing = schema.map((d) => ({ name: d.name, description: d.description, color: d.color }));

    const { spawn, calls } = makeSpawn((args) => {
      if (args[1] === "list") return { status: 0, stdout: JSON.stringify(existing), stderr: "" };
      throw new Error(`unexpected mutation call: ${args.join(" ")}`);
    });

    const result = syncLabels({}, { spawn });
    expect(result.diff.creates).toHaveLength(0);
    expect(result.diff.updates).toHaveLength(0);
    expect(result.applied.created).toEqual([]);
    expect(result.applied.updated).toEqual([]);
    expect(result.applied.deleted).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("--prune deletes labels that exist on GH but not in the schema", () => {
    const schema = defaultLabelDefinitions();
    // GH carries every schema label PLUS one legacy unknown.
    const existing: GhLabel[] = [
      ...schema.map((d) => ({ name: d.name, description: d.description, color: d.color })),
      { name: "agent::architect", description: "", color: "ededed" },
    ];

    const { spawn, calls } = makeSpawn((args) => {
      if (args[1] === "list") return { status: 0, stdout: JSON.stringify(existing), stderr: "" };
      if (args[1] === "delete") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected non-delete write: ${args.join(" ")}`);
    });

    const result = syncLabels({ prune: true }, { spawn });
    expect(result.applied.deleted).toEqual(["agent::architect"]);

    // Verify the delete call shape
    const deleteCall = calls.find((c) => c.args[1] === "delete");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.args).toContain("--yes");
    expect(deleteCall!.args).toContain("agent::architect");
  });

  test("without --prune unknown labels are reported but not deleted", () => {
    const schema = defaultLabelDefinitions();
    const existing: GhLabel[] = [
      ...schema.map((d) => ({ name: d.name, description: d.description, color: d.color })),
      { name: "agent::architect", description: "", color: "ededed" },
    ];

    const { spawn, calls } = makeSpawn((args) => {
      if (args[1] === "list") return { status: 0, stdout: JSON.stringify(existing), stderr: "" };
      if (args[1] === "delete") throw new Error("must not delete without --prune");
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const result = syncLabels({}, { spawn });
    expect(result.diff.unknown.map((l) => l.name)).toEqual(["agent::architect"]);
    expect(result.applied.deleted).toEqual([]);
    expect(calls.filter((c) => c.args[1] === "delete")).toHaveLength(0);
  });

  test("propagates a failed gh label list as a thrown error", () => {
    const { spawn } = makeSpawn(() => ({ status: 1, stdout: "", stderr: "gh: oops\n" }));
    expect(() => syncLabels({}, { spawn })).toThrow(/gh: oops/);
  });
});

describe("formatSyncLabelsResult", () => {
  test("plain output reports counts and the dry-run mode tag", () => {
    const { spawn } = makeSpawn(() => ({ status: 0, stdout: "[]", stderr: "" }));
    const result = syncLabels({ dryRun: true, repo: "owner/repo" }, { spawn });
    const text = formatSyncLabelsResult(result, "plain");
    expect(text).toContain("owner/repo");
    expect(text).toContain("[dry-run]");
    expect(text).toContain(`+ create  ${defaultLabelDefinitions().length}`);
    expect(text).toContain("- unknown 0");
  });

  test("json output round-trips the result struct", () => {
    const { spawn } = makeSpawn(() => ({ status: 0, stdout: "[]", stderr: "" }));
    const result = syncLabels({ dryRun: true }, { spawn });
    expect(JSON.parse(formatSyncLabelsResult(result, "json"))).toEqual(JSON.parse(JSON.stringify(result)));
  });
});
