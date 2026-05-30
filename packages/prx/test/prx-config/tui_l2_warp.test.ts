import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WARP_KEYS,
  driftReportWarp,
  emitWarp,
  parseWarp,
  parseFileWarp,
  emitToFileWarp,
  type TuiL2Warp,
} from "@bounded-systems/prx-config";

describe("parseWarp — empty object", () => {
  test("succeeds with empty subset and empty passthrough", () => {
    const r = parseWarp({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.warp).toEqual({});
    expect(r.value.passthrough).toEqual({});
    expect(r.drift.ok).toBe(true);
    expect(r.drift.issues).toEqual([]);
  });
});

describe("parseWarp — maximum valid", () => {
  const maxValid = {
    blocksUiMode: "minimized",
    inputAutoFormatEnabled: false,
    aiSuggestionOverlayEnabled: false,
    sendAltAsMeta: true,
    optionAsMeta: true,
    rendering: "standard",
    // passthrough: home-manager / Warpify module may carry sibling keys
    profileName: "claude-safe",
    notes: "manual import target",
  } as const;

  test("every WARP knob is typed and round-trip preserves both halves", () => {
    const r = parseWarp(maxValid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(true);
    expect(r.value.warp.blocksUiMode).toBe("minimized");
    expect(r.value.warp.inputAutoFormatEnabled).toBe(false);
    expect(r.value.warp.aiSuggestionOverlayEnabled).toBe(false);
    expect(r.value.warp.sendAltAsMeta).toBe(true);
    expect(r.value.warp.optionAsMeta).toBe(true);
    expect(r.value.warp.rendering).toBe("standard");
    expect(r.value.passthrough).toEqual({
      profileName: "claude-safe",
      notes: "manual import target",
    });

    const reparsed = parseWarp(JSON.parse(emitWarp(r.value)));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value).toEqual(r.value);
  });
});

describe("parseWarp — type drift on blocksUiMode", () => {
  test("input remains parseable; drift reports the bad enum value", () => {
    const r = parseWarp({ blocksUiMode: "huge" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(false);
    expect(r.drift.issues).toHaveLength(1);
    const issue = r.drift.issues[0]!;
    expect(issue.path).toBe("blocksUiMode");
    expect(issue.kind).toBe("stale_value");
    expect(issue.rawValue).toBe("huge");
    expect(r.value.warp.blocksUiMode).toBeUndefined();
  });
});

describe("parseWarp — type drift on boolean knob", () => {
  test("non-boolean sendAltAsMeta surfaces as type_mismatch", () => {
    const r = parseWarp({ sendAltAsMeta: "yes" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(false);
    const issue = r.drift.issues.find((i) => i.path === "sendAltAsMeta");
    expect(issue).toBeDefined();
    expect(issue?.kind).toBe("type_mismatch");
    expect(r.value.warp.sendAltAsMeta).toBeUndefined();
  });
});

describe("parseWarp — valid sibling survives drift", () => {
  test("valid knob retained when sibling has drift", () => {
    const r = parseWarp({ blocksUiMode: "minimized", rendering: "fancy" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(false);
    expect(r.value.warp.blocksUiMode).toBe("minimized");
    expect(r.value.warp.rendering).toBeUndefined();
  });
});

describe("parseWarp — passthrough preserved", () => {
  test("unknown root keys route to passthrough, not drift", () => {
    const r = parseWarp({
      blocksUiMode: "default",
      profileName: "experimental",
      meta: { author: "operator" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(true);
    expect(r.value.passthrough).toEqual({
      profileName: "experimental",
      meta: { author: "operator" },
    });
    expect(r.value.warp.blocksUiMode).toBe("default");
  });
});

describe("parseWarp — non-object root", () => {
  const cases: Array<{ label: string; input: unknown }> = [
    { label: "number", input: 42 },
    { label: "null", input: null },
    { label: "array", input: [] },
    { label: "string", input: "string" },
    { label: "boolean", input: true },
  ];
  for (const { label, input } of cases) {
    test(`rejects ${label}`, () => {
      const r = parseWarp(input);
      expect(r.ok).toBe(false);
      expect(r.drift.ok).toBe(false);
    });
  }
});

describe("driftReportWarp", () => {
  test("standalone inspection without consuming the value", () => {
    const report = driftReportWarp({ blocksUiMode: "minimized", rendering: "fancy" });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.path === "rendering")).toBe(true);
  });

  test("clean input has empty issues", () => {
    expect(driftReportWarp({ blocksUiMode: "minimized" })).toEqual({
      ok: true,
      issues: [],
    });
  });

  test("non-object root surfaces a single root drift", () => {
    const report = driftReportWarp(42);
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.path).toBe("");
  });
});

describe("emitWarp", () => {
  test("emits passthrough first, then WARP_KEYS in declared order", () => {
    const profile: TuiL2Warp = {
      warp: { blocksUiMode: "minimized", sendAltAsMeta: true, rendering: "standard" },
      passthrough: { profileName: "claude-safe", notes: "x" },
    };
    const out = emitWarp(profile);
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toEqual([
      "profileName",
      "notes",
      "blocksUiMode",
      "sendAltAsMeta",
      "rendering",
    ]);
  });

  test("does not emit absent WARP_KEYS", () => {
    const out = emitWarp({ warp: { sendAltAsMeta: true }, passthrough: {} });
    expect(JSON.parse(out)).toEqual({ sendAltAsMeta: true });
  });

  test("preserves passthrough fields without modification", () => {
    const passthrough = {
      profileName: "claude-safe",
      meta: { author: "operator", source: "home-manager" },
    };
    const out = JSON.parse(emitWarp({ warp: {}, passthrough }));
    expect(out).toEqual(passthrough);
  });
});

describe("WARP_KEYS", () => {
  test("matches the schema's declared keys exactly", () => {
    expect(new Set(WARP_KEYS)).toEqual(
      new Set([
        "blocksUiMode",
        "inputAutoFormatEnabled",
        "aiSuggestionOverlayEnabled",
        "sendAltAsMeta",
        "optionAsMeta",
        "rendering",
      ]),
    );
  });
});

describe("parseFileWarp + emitToFileWarp", () => {
  test("round-trip on a tmp path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui_l2_warp-"));
    try {
      const path = join(dir, "profile.json");
      const profile: TuiL2Warp = {
        warp: { blocksUiMode: "minimized", optionAsMeta: true, rendering: "standard" },
        passthrough: { profileName: "claude-safe" },
      };
      emitToFileWarp(path, profile);

      const r = parseFileWarp(path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.drift.ok).toBe(true);
      expect(r.value).toEqual(profile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
