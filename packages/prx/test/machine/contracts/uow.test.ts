/**
 * prx-4fa (epic prx-997) — the `uow` artifact contract.
 *
 * `uow` is the pipeline's ROOT artifact: intake's output and triage's input
 * (`sessionProfileIo`: intake → uow). This slot was a deferred registry stub
 * (`deferred:GH-1824`); prx-4fa fills it with a concrete schema so the
 * intake→triage boundary is TYPED. These tests are that contract.
 *
 * Note: a uow is git-persisted (the GH issue / bead), so the intake→triage
 * transport is GH/beads — not the CAS edge primitive (prx-d2d), which carries
 * the cas-persisted back-half (plan→implement→submit→author).
 */
import { describe, expect, test } from "bun:test";

import { getArtifactContract } from "../../../src/machine/contracts/artifacts.ts";
import { type Uow, uowSchema } from "../../../src/machine/contracts/lifecycle_artifacts.ts";

describe("uow artifact schema (prx-4fa)", () => {
  test("accepts a well-formed GH-rooted uow", () => {
    const uow: Uow = { id: "GH-1900", title: "tui board shows a stale column", status: "open" };
    expect(uowSchema.parse(uow)).toEqual(uow);
  });

  test("accepts bd- and cross-repo (<repo>#N) work-unit ids", () => {
    expect(uowSchema.parse({ id: "bd-abc12", title: "x", status: "in_progress" }).id).toBe(
      "bd-abc12",
    );
    expect(uowSchema.parse({ id: "owner/repo#42", title: "y", status: "closed" }).id).toBe(
      "owner/repo#42",
    );
  });

  test("rejects empty / missing required fields", () => {
    expect(() => uowSchema.parse({ id: "GH-1", title: "", status: "open" })).toThrow();
    expect(() => uowSchema.parse({ id: "", title: "t", status: "open" })).toThrow();
    expect(() => uowSchema.parse({ id: "GH-1", status: "open" })).toThrow();
  });

  test("rejects an unknown status (the lifecycle is the contract)", () => {
    expect(() => uowSchema.parse({ id: "GH-1", title: "t", status: "frozen" })).toThrow();
  });

  test("rejects extra fields (strict — the schema is the boundary)", () => {
    expect(() =>
      uowSchema.parse({ id: "GH-1", title: "t", status: "open", sneaky: true }),
    ).toThrow();
  });
});

describe("uow registry contract (prx-4fa)", () => {
  test("the `uow` slot is now LIVE, not deferred", () => {
    const contract = getArtifactContract("uow");
    expect(contract).toBeDefined();
    // Was `deferred:GH-1824`; now points at the concrete schema.
    expect(contract?.validationRef).toBe(
      "schema:src/machine/contracts/lifecycle_artifacts.ts#uowSchema",
    );
    expect(contract?.validationRef.startsWith("deferred:")).toBe(false);
    expect(contract?.requiredFields).toEqual(["id", "title", "status"]);
    expect(contract?.persistence).toBe("git");
  });
});
