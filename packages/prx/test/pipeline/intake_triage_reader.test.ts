// The bd-output parsing inside the intake→triage default reader. `uowReaderWith`
// takes an injectable runner, so the `bd show <id> --json` parse branches
// (non-zero exit, array vs single object, missing row) are testable without bd.

import { describe, expect, test } from "bun:test";

import { uowReaderWith } from "../../src/pipeline/edges/intake-triage.ts";
import type { CommandResult } from "@bounded-systems/proc";

const runner = (r: Partial<CommandResult>) =>
  (() => ({ stdout: "", stderr: "", status: 0, ...r })) as never;

describe("uowReaderWith", () => {
  test("throws when bd show exits non-zero", () => {
    const read = uowReaderWith(runner({ status: 1, stderr: "boom" }));
    expect(() => read("GH-1")).toThrow(/bd show GH-1 failed: boom/);
  });

  test("selects the matching row from a bd-show array", () => {
    const read = uowReaderWith(
      runner({
        stdout: JSON.stringify([
          { id: "GH-9", title: "dep", status: "open" },
          { id: "GH-1", title: "the unit", status: "in_progress" },
        ]),
      }),
    );
    expect(read("GH-1")).toEqual({ id: "GH-1", title: "the unit", status: "in_progress" });
  });

  test("accepts a single (non-array) record shape", () => {
    const read = uowReaderWith(
      runner({ stdout: JSON.stringify({ id: "GH-2", title: "t", status: "open" }) }),
    );
    expect(read("GH-2")).toEqual({ id: "GH-2", title: "t", status: "open" });
  });

  test("throws when no row matches the requested id", () => {
    const read = uowReaderWith(
      runner({ stdout: JSON.stringify([{ id: "GH-other", title: "x", status: "open" }]) }),
    );
    expect(() => read("GH-1")).toThrow(/no record with id=GH-1/);
  });
});
