import { describe, expect, test } from "bun:test";

import {
  bodyTemplateOptionsSchema,
  formatBodyTemplateRender,
  renderBodyTemplate,
  runBodyTemplate,
  type BodyTemplateOptions,
} from "../../src/submit/body-template.ts";

const NOTION_UUID = "1f2e3d4c-5678-90ab-cdef-1234567890ab";

function opts(overrides: Partial<BodyTemplateOptions> = {}): BodyTemplateOptions {
  return bodyTemplateOptionsSchema.parse({
    closes: ["GH-885"],
    ...overrides,
  });
}

describe("renderBodyTemplate — happy paths", () => {
  test("single --closes GH-N emits one Closes #N line", () => {
    const r = renderBodyTemplate(opts({ closes: ["GH-885"] }));
    expect(r.closesLines).toEqual(["Closes #885"]);
    expect(r.numbers).toEqual([885]);
    expect(r.refsLines).toEqual([]);
    expect(r.refs).toEqual([]);
  });

  test("multiple --closes args preserve order", () => {
    const r = renderBodyTemplate(opts({ closes: ["GH-885", "GH-882", "GH-1318"] }));
    expect(r.closesLines).toEqual(["Closes #885", "Closes #882", "Closes #1318"]);
  });

  test("accepts #N, bare N, and GitHub URL forms", () => {
    const r = renderBodyTemplate(
      opts({
        closes: ["#7", "42", "https://github.com/owner/repo/issues/100"],
      }),
    );
    expect(r.numbers).toEqual([7, 42, 100]);
  });

  test("dedupes repeated args, preserving first occurrence", () => {
    const r = renderBodyTemplate(opts({ closes: ["GH-1", "#1", "1", "GH-2"] }));
    expect(r.numbers).toEqual([1, 2]);
    expect(r.closesLines).toEqual(["Closes #1", "Closes #2"]);
  });
});

describe("renderBodyTemplate — bd / notion auto-Refs (GH-1805)", () => {
  test("bd canonical id emits a Refs <bd-id> line, no Closes", () => {
    const r = renderBodyTemplate(opts({ closes: ["BD-DEADBEEF"] }));
    expect(r.closesLines).toEqual([]);
    expect(r.refsLines).toEqual(["Refs BD-DEADBEEF"]);
    expect(r.refs).toEqual(["BD-DEADBEEF"]);
    expect(r.numbers).toEqual([]);
  });

  test("notion uuid emits a Refs <decoded-uuid> line", () => {
    const r = renderBodyTemplate(opts({ closes: [NOTION_UUID] }));
    expect(r.closesLines).toEqual([]);
    expect(r.refsLines).toEqual([`Refs ${NOTION_UUID}`]);
    expect(r.refs).toEqual([NOTION_UUID]);
  });

  test("bd dedupe is verbatim — same id twice → one Refs line", () => {
    const r = renderBodyTemplate(opts({ closes: ["BD-cafe", "BD-cafe"] }));
    expect(r.refsLines).toEqual(["Refs BD-cafe"]);
    expect(r.refs).toEqual(["BD-cafe"]);
  });

  test("bd dedupe is case-sensitive (mirrors author renderer)", () => {
    const r = renderBodyTemplate(opts({ closes: ["BD-cafe", "bd-cafe"] }));
    expect(r.refsLines).toEqual(["Refs BD-cafe", "Refs bd-cafe"]);
  });

  test("mixed GH + bd args populate both blocks independently", () => {
    const r = renderBodyTemplate(opts({ closes: ["GH-1", "BD-cafe", "GH-2"] }));
    expect(r.closesLines).toEqual(["Closes #1", "Closes #2"]);
    expect(r.refsLines).toEqual(["Refs BD-cafe"]);
    expect(r.numbers).toEqual([1, 2]);
    expect(r.refs).toEqual(["BD-cafe"]);
  });

  test("GH and bd dedupe independently in mixed input", () => {
    const r = renderBodyTemplate(opts({ closes: ["GH-1", "BD-cafe", "GH-1", "BD-cafe", "GH-2"] }));
    expect(r.closesLines).toEqual(["Closes #1", "Closes #2"]);
    expect(r.refsLines).toEqual(["Refs BD-cafe"]);
  });

  test("order-stability: closes block always renders before refs block", () => {
    const r = renderBodyTemplate(opts({ closes: ["BD-a", "GH-1", "BD-b", "GH-2"] }));
    expect(r.closesLines).toEqual(["Closes #1", "Closes #2"]);
    expect(r.refsLines).toEqual(["Refs BD-a", "Refs BD-b"]);
  });

  test("input with shell metacharacters is still rejected", () => {
    expect(() => renderBodyTemplate(opts({ closes: ["bad id"] }))).toThrow(/invalid characters/);
  });
});

describe("formatBodyTemplateRender", () => {
  test("plain joins lines with \\n; prefix/suffix separated by blank line", () => {
    const r = renderBodyTemplate(
      opts({
        closes: ["GH-1", "GH-2"],
        prefix: "## Summary\n\nFoo",
        suffix: "🤖 trailer",
      }),
    );
    const out = formatBodyTemplateRender(r, "plain");
    expect(out).toBe("## Summary\n\nFoo\n\nCloses #1\nCloses #2\n\n🤖 trailer");
  });

  test("plain emits closes block then refs block separated by blank line", () => {
    const r = renderBodyTemplate(opts({ closes: ["GH-1", "GH-2", "BD-cafe"] }));
    const out = formatBodyTemplateRender(r, "plain");
    expect(out).toBe("Closes #1\nCloses #2\n\nRefs BD-cafe");
  });

  test("plain with prefix/suffix wraps both blocks", () => {
    const r = renderBodyTemplate(
      opts({
        closes: ["GH-1", "BD-cafe"],
        prefix: "## Summary",
        suffix: "🤖 trailer",
      }),
    );
    const out = formatBodyTemplateRender(r, "plain");
    expect(out).toBe("## Summary\n\nCloses #1\n\nRefs BD-cafe\n\n🤖 trailer");
  });

  test("plain emits only refs block when no GH args present", () => {
    const r = renderBodyTemplate(opts({ closes: ["BD-cafe"] }));
    const out = formatBodyTemplateRender(r, "plain");
    expect(out).toBe("Refs BD-cafe");
  });

  test("json round-trips all fields including refsLines/refs", () => {
    const r = renderBodyTemplate(opts({ closes: ["GH-9", "BD-cafe"], prefix: "## P" }));
    const parsed = JSON.parse(formatBodyTemplateRender(r, "json"));
    expect(parsed.closesLines).toEqual(["Closes #9"]);
    expect(parsed.numbers).toEqual([9]);
    expect(parsed.refsLines).toEqual(["Refs BD-cafe"]);
    expect(parsed.refs).toEqual(["BD-cafe"]);
    expect(parsed.prefix).toBe("## P");
  });
});

describe("runBodyTemplate — exit codes", () => {
  test("exit 0 on happy path, writes formatted output", () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = runBodyTemplate(opts({ closes: ["GH-100"] }), {
      log: (l) => logs.push(l),
      error: (l) => errs.push(l),
    });
    expect(exit).toBe(0);
    expect(logs[0]).toBe("Closes #100");
    expect(errs).toEqual([]);
  });

  test("exit 1 when --closes is empty", () => {
    const errs: string[] = [];
    const exit = runBodyTemplate(bodyTemplateOptionsSchema.parse({}), {
      log: () => undefined,
      error: (l) => errs.push(l),
    });
    expect(exit).toBe(1);
    expect(errs[0]).toMatch(/at least one --closes/);
  });

  test("exit 0 writing Refs line for a bd target", () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = runBodyTemplate(opts({ closes: ["BD-CAFEBABE"] }), {
      log: (l) => logs.push(l),
      error: (l) => errs.push(l),
    });
    expect(exit).toBe(0);
    expect(logs[0]).toBe("Refs BD-CAFEBABE");
    expect(errs).toEqual([]);
  });
});
