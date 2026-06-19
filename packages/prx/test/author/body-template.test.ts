// GH-1206: author body-template renderer — emits a CLAUDE.md PR-Standards
// run-sheet body the operator pastes into `gh pr create --body-file`.

import { describe, expect, test } from "bun:test";

import {
  authorBodyTemplateOptionsSchema,
  formatAuthorBodyRender,
  renderAuthorBody,
  runAuthorBodyTemplate,
  type AuthorBodyTemplateOptions,
} from "../../src/author/body-template.ts";

function opts(overrides: Partial<AuthorBodyTemplateOptions> = {}): AuthorBodyTemplateOptions {
  return authorBodyTemplateOptionsSchema.parse({
    unit: "GH-1206",
    ...overrides,
  });
}

describe("renderAuthorBody — GH-numbered units", () => {
  test("emits a Closes #N line for GH-N input", () => {
    const r = renderAuthorBody(opts({ unit: "GH-1206" }));
    expect(r.unitKind).toBe("gh");
    expect(r.closesLines).toEqual(["Closes #1206"]);
    expect(r.refsLine).toBe("");
  });

  test("accepts #N, bare N, and GitHub URL forms", () => {
    expect(renderAuthorBody(opts({ unit: "#42" })).closesLines).toEqual(["Closes #42"]);
    expect(renderAuthorBody(opts({ unit: "42" })).closesLines).toEqual(["Closes #42"]);
    expect(
      renderAuthorBody(opts({ unit: "https://github.com/owner/repo/issues/100" })).closesLines,
    ).toEqual(["Closes #100"]);
  });

  test("emits the 5-item CLAUDE.md PR-Standards run-sheet unchecked", () => {
    const r = renderAuthorBody(opts({ unit: "GH-1206" }));
    expect(r.runSheet).toHaveLength(5);
    expect(r.runSheet[0]).toContain("Independent PR");
    expect(r.runSheet[1]).toContain("Changed codepaths verified");
    expect(r.runSheet[2]).toContain("Root cause identified");
    expect(r.runSheet[3]).toContain("No duplication");
    expect(r.runSheet[4]).toContain("No unrelated changes");
    for (const item of r.runSheet) {
      expect(item.startsWith("- [ ] **")).toBe(true);
    }
  });
});

describe("renderAuthorBody — bd-only units use Refs (#1767 convention)", () => {
  test("bd id falls through to `Refs <bd-id>`, not `Closes`", () => {
    const r = renderAuthorBody(opts({ unit: "bd-deadbeef" }));
    expect(r.unitKind).toBe("bd");
    expect(r.closesLines).toEqual([]);
    expect(r.refsLine).toBe("Refs bd-deadbeef");
  });
});

describe("renderAuthorBody — Post-merge handoff (#1773)", () => {
  test("bd unit emits ## Post-merge handoff with bd close pointer", () => {
    const r = renderAuthorBody(opts({ unit: "bd-deadbeef" }));
    expect(r.unitKind).toBe("bd");
    expect(r.postMergeHandoff).toContain("## Post-merge handoff");
    expect(r.postMergeHandoff).toContain("prx submit postmerge");
    expect(r.postMergeHandoff).toContain("bd close bd-deadbeef");
  });

  test("GH-numbered unit emits no Post-merge handoff section", () => {
    const r = renderAuthorBody(opts({ unit: "GH-1206" }));
    expect(r.unitKind).toBe("gh");
    expect(r.postMergeHandoff).toBe("");
  });

  test("plain output appends the handoff block for bd units", () => {
    const r = renderAuthorBody(opts({ unit: "bd-deadbeef" }));
    const plain = formatAuthorBodyRender(r, "plain");
    expect(plain).toContain("## Post-merge handoff");
    expect(plain).toContain("bd close bd-deadbeef");
    expect(plain.indexOf("Refs bd-deadbeef")).toBeLessThan(plain.indexOf("## Post-merge handoff"));
  });

  test("plain output omits the handoff block for GH-numbered units", () => {
    const r = renderAuthorBody(opts({ unit: "GH-1206" }));
    const plain = formatAuthorBodyRender(r, "plain");
    expect(plain).not.toContain("## Post-merge handoff");
  });
});

describe("formatAuthorBodyRender — plain output", () => {
  test("renders summary placeholder + run-sheet + Closes line in order", () => {
    const r = renderAuthorBody(opts({ unit: "GH-1206" }));
    const plain = formatAuthorBodyRender(r, "plain");
    expect(plain).toContain("## Summary");
    expect(plain).toContain("## Run-sheet");
    expect(plain).toContain("- [ ] **Independent PR**");
    expect(plain).toContain("Closes #1206");
    // Refs line is omitted on GH-numbered units.
    expect(plain).not.toContain("Refs ");
  });

  test("renders Refs line in place of Closes for bd-only units", () => {
    const r = renderAuthorBody(opts({ unit: "bd-deadbeef" }));
    const plain = formatAuthorBodyRender(r, "plain");
    expect(plain).toContain("Refs bd-deadbeef");
    expect(plain).not.toContain("Closes #");
  });
});

describe("formatAuthorBodyRender — json output", () => {
  test("emits the AuthorBodyRender shape verbatim", () => {
    const r = renderAuthorBody(opts({ unit: "GH-1206" }));
    const json = JSON.parse(formatAuthorBodyRender(r, "json"));
    expect(json.unitKind).toBe("gh");
    expect(json.closesLines).toEqual(["Closes #1206"]);
    expect(json.refsLine).toBe("");
    expect(Array.isArray(json.runSheet)).toBe(true);
    expect(typeof json.summaryPlaceholder).toBe("string");
  });
});

describe("runAuthorBodyTemplate — exit codes + output", () => {
  test("happy path logs the formatted body and returns 0", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = runAuthorBodyTemplate(opts({ unit: "GH-1206", format: "plain" }), {
      log: (s) => logs.push(s),
      error: (s) => errors.push(s),
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Closes #1206");
    expect(logs[0]).toContain("- [ ] **Independent PR**");
  });

  test("invalid input characters → non-zero exit + error line", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = runAuthorBodyTemplate(
      // Spaces are in FORBIDDEN_INPUT_RE (src/issues/resolver.ts).
      // authorBodyTemplateOptionsSchema only trims and rejects empty strings,
      // so this passes the parser and is rejected by resolveIssueId.
      opts({ unit: "bad id" }),
      { log: (s) => logs.push(s), error: (s) => errors.push(s) },
    );
    expect(code).not.toBe(0);
    expect(logs).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("invalid characters");
  });
});
