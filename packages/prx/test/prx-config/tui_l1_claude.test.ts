import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TUI_KEYS,
  driftReport,
  emit,
  parse,
  type TuiL1Claude,
} from "@bounded-systems/prx-config";

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const REPO_CLAUDE_SETTINGS = join(REPO_ROOT, "claude/settings.json");

describe("parse — empty object", () => {
  test("succeeds with empty subset and empty passthrough", () => {
    const r = parse({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tui).toEqual({});
    expect(r.value.passthrough).toEqual({});
    expect(r.drift.ok).toBe(true);
    expect(r.drift.issues).toEqual([]);
  });
});

describe("parse — repo's checked-in claude/settings.json", () => {
  test("validates and routes non-TUI fields to passthrough", () => {
    const raw = JSON.parse(readFileSync(REPO_CLAUDE_SETTINGS, "utf8"));
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tui.tui).toBe("fullscreen");
    expect(r.value.passthrough).toHaveProperty("permissions");
    expect(r.value.passthrough).toHaveProperty("hooks");
    expect(r.value.passthrough).toHaveProperty("statusLine");
    expect(r.value.passthrough).toHaveProperty("enabledPlugins");
    expect(r.value.passthrough).not.toHaveProperty("tui");
    expect(r.drift.ok).toBe(true);
  });
});

describe("parse — user's live ~/.claude/settings.json", () => {
  const home = process.env.HOME;
  const livePath = home ? join(home, ".claude/settings.json") : null;
  const liveExists = livePath != null && existsSync(livePath);
  test.skipIf(!liveExists)("validates without drift", () => {
    if (livePath == null) return;
    const raw = JSON.parse(readFileSync(livePath, "utf8"));
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(true);
  });
});

describe("parse — maximum valid", () => {
  const maxValid = {
    tui: "fullscreen",
    editorMode: "vim",
    language: "japanese",
    outputStyle: "Explanatory",
    viewMode: "verbose",
    autoScrollEnabled: true,
    prefersReducedMotion: false,
    showThinkingSummaries: true,
    showTurnDuration: false,
    terminalProgressBarEnabled: true,
    spinnerTipsEnabled: false,
    awaySummaryEnabled: true,
    voice: { enabled: true, mode: "tap", autoSubmit: false },
    enabledPlugins: { "foo@bar": true },
    permissions: { allow: ["Bash(*)"], deny: [], defaultMode: "default" },
  } as const;

  test("every TUI field is typed and round-trip preserves both halves", () => {
    const r = parse(maxValid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(true);
    expect(r.value.tui.tui).toBe("fullscreen");
    expect(r.value.tui.editorMode).toBe("vim");
    expect(r.value.tui.voice).toEqual({ enabled: true, mode: "tap", autoSubmit: false });
    expect(r.value.passthrough).toHaveProperty("enabledPlugins");
    expect(r.value.passthrough).toHaveProperty("permissions");

    const reparsed = parse(JSON.parse(emit(r.value)));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value).toEqual(r.value);
  });
});

describe("parse — type drift on tui", () => {
  test("input remains parseable; drift reports the bad value", () => {
    const r = parse({ tui: "yes please" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(false);
    expect(r.drift.issues).toHaveLength(1);
    const issue = r.drift.issues[0]!;
    expect(issue.path).toBe("tui");
    expect(issue.kind).toBe("stale_value");
    expect(issue.rawValue).toBe("yes please");
    expect(r.value.tui.tui).toBeUndefined();
  });
});

describe("parse — valid sibling survives drift", () => {
  test("valid TUI key is retained when a sibling field has drift", () => {
    const r = parse({ tui: "default", editorMode: "emacs" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(false);
    expect(r.value.tui.tui).toBe("default");
    expect(r.value.tui.editorMode).toBeUndefined();
  });
});

describe("parse — nested drift on voice.mode", () => {
  test("surfaces drift on the nested path", () => {
    const r = parse({ voice: { mode: "shout" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(false);
    const paths = r.drift.issues.map((i) => i.path);
    expect(paths).toContain("voice.mode");
  });
});

describe("parse — unrecognized nested keys emit separate issues", () => {
  test("two unknown voice keys produce two distinct drift issues", () => {
    const r = parse({ voice: { foo: 1, bar: 2 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.ok).toBe(false);
    const paths = r.drift.issues.map((i) => i.path);
    expect(paths).toContain("voice.foo");
    expect(paths).toContain("voice.bar");
    expect(r.drift.issues.find((i) => i.path === "voice.foo")?.rawValue).toBe(1);
    expect(r.drift.issues.find((i) => i.path === "voice.bar")?.rawValue).toBe(2);
  });
});

describe("parse — non-object root", () => {
  const cases: Array<{ label: string; input: unknown }> = [
    { label: "number", input: 42 },
    { label: "null", input: null },
    { label: "array", input: [] },
    { label: "string", input: "string" },
    { label: "boolean", input: true },
  ];
  for (const { label, input } of cases) {
    test(`rejects ${label}`, () => {
      const r = parse(input);
      expect(r.ok).toBe(false);
      expect(r.drift.ok).toBe(false);
    });
  }
});

describe("driftReport", () => {
  test("standalone inspection without consuming the value", () => {
    const report = driftReport({ tui: "default", editorMode: "emacs" });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.path === "editorMode")).toBe(true);
  });

  test("clean input has empty issues", () => {
    expect(driftReport({ tui: "default" })).toEqual({ ok: true, issues: [] });
  });
});

describe("emit", () => {
  test("emits passthrough first, then TUI keys in declared order", () => {
    const profile: TuiL1Claude = {
      tui: { tui: "fullscreen", editorMode: "vim" },
      passthrough: { theme: "dark", enabledPlugins: { "x@y": true } },
    };
    const out = emit(profile);
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toEqual(["theme", "enabledPlugins", "tui", "editorMode"]);
  });

  test("does not emit absent TUI keys", () => {
    const out = emit({ tui: { tui: "default" }, passthrough: {} });
    expect(JSON.parse(out)).toEqual({ tui: "default" });
  });

  test("preserves passthrough fields without modification", () => {
    const passthrough = {
      permissions: { allow: ["Bash(*)"], deny: [], defaultMode: "default" },
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bd prime" }] }] },
    };
    const out = JSON.parse(emit({ tui: {}, passthrough }));
    expect(out).toEqual(passthrough);
  });
});

describe("TUI_KEYS", () => {
  test("matches the schema's declared keys exactly", () => {
    expect(new Set(TUI_KEYS)).toEqual(
      new Set([
        "tui",
        "editorMode",
        "language",
        "outputStyle",
        "viewMode",
        "autoScrollEnabled",
        "prefersReducedMotion",
        "showThinkingSummaries",
        "showTurnDuration",
        "terminalProgressBarEnabled",
        "spinnerTipsEnabled",
        "awaySummaryEnabled",
        "voice",
      ]),
    );
  });
});
