import { describe, expect, test } from "bun:test";

import {
  classifyBdQueue,
  classifyBdRecord,
  classifyIssueRow,
  classifyQueue,
  classifyTitle,
  formatBdLabelPlan,
  formatLabelPlan,
  runTriageClassify,
} from "../../src/triage/classifier.ts";
import type { FallbackIssue } from "../../src/pr-state/github.ts";
import type { BdExecResult } from "@bounded-systems/bd";

describe("classifyTitle — type rule table", () => {
  const cases: Array<[string, string]> = [
    // [title, expected type]
    ["[epic] M0: spec finalization", "epic"],
    ["M3: ship Phase A", "epic"],
    ["bug(triage): wrong label", "bug"],
    ["fix(prx): off-by-one", "bug"],
    ["refactor(triage): split module", "chore"],
    ["migrate to bun:test", "chore"],
    ["move helpers to shared lib", "chore"],
    ["chore: bump deps", "chore"],
    ["bump tsx to 4", "chore"],
    ["upgrade nix flake", "chore"],
    ["feat(prx): add classify verb", "feature"],
    ["feature: enable webhook", "feature"],
    ["add `prx triage apply`", "feature"],
    ["enable strict mode", "feature"],
    ["adopt Ink for TUI", "feature"],
    ["implement audit log", "feature"],
    // GH-988: task/spike arms join the rule table.
    ["task(prx): wire it up", "task"],
    ["task: extend coverage", "task"],
    ["spike(prx): investigate auth", "task"],
    ["spike: prove out notion sync", "task"],
  ];

  for (const [title, expectedType] of cases) {
    test(`"${title}" → type::${expectedType} (scored)`, () => {
      const result = classifyTitle(title);
      expect(result.type).toBe(expectedType as never);
      expect(result.typeConfidence).toBe("scored");
    });
  }

  test("GH-988: spike-prefixed titles also set spike:true", () => {
    expect(classifyTitle("spike(prx): foo").spike).toBe(true);
    expect(classifyTitle("spike: investigate notion auth").spike).toBe(true);
    // task-prefixed titles do NOT set spike.
    expect(classifyTitle("task(prx): wire it up").spike).toBeUndefined();
  });

  test("GH-988: decision/adr/investigation titles fall through to unscored fallback", () => {
    for (const title of [
      "investigation: latency",
      "decision: triage vocabulary",
      "adr-007: pick label vocab v2",
    ]) {
      const result = classifyTitle(title);
      expect(result.type).toBe("task");
      expect(result.typeConfidence).toBe("unscored");
      expect(result.spike).toBeUndefined();
    }
  });
});

describe("classifyTitle — GH-988 unscored fallback", () => {
  test("title with no type prefix falls back to type::task + unscored", () => {
    const result = classifyTitle("random title with no prefix");
    expect(result.type).toBe("task");
    expect(result.typeConfidence).toBe("unscored");
    expect(result.spike).toBeUndefined();
  });

  test("GH-970: priority defaults to 'none' with priorityConfidence 'unscored'", () => {
    // No scored priority rules exist yet; every title gets the explicit
    // unscored marker. Apply preserves operator-set priority via GH-957.
    for (const title of [
      "bug(prx): boom",
      "feat: new thing",
      "[epic] M0: spec",
      "random title",
    ]) {
      const result = classifyTitle(title);
      expect(result.priority).toBe("none");
      expect(result.priorityConfidence).toBe("unscored");
    }
  });

  test("effort is always undefined (no independent effort rules yet)", () => {
    expect(classifyTitle("bug(prx): boom").effort).toBeUndefined();
    expect(classifyTitle("feat: new thing").effort).toBeUndefined();
    expect(classifyTitle("chore: bump").effort).toBeUndefined();
    expect(classifyTitle("random title").effort).toBeUndefined();
  });

  test("GH-988: title with no rule fires emits type::task unscored + priority::none unscored", () => {
    const result = classifyTitle("random title with no prefix");
    expect(result).toEqual({
      type: "task",
      typeConfidence: "unscored",
      priority: "none",
      priorityConfidence: "unscored",
    });
  });

  test("GH-988: representative unmatched titles all hit the unscored fallback", () => {
    for (const title of [
      "Harden ~/.beads paths",
      "Make the dashboard sparkle",
      "Document beads JSON schema",
    ]) {
      const result = classifyTitle(title);
      expect(result.type).toBe("task");
      expect(result.typeConfidence).toBe("unscored");
    }
  });
});

describe("classifyTitle — GH-988: ambiguous-verb titles fall to unscored fallback (was GH-958 regression suite)", () => {
  // Documentation and ambiguous-verb titles must NOT fire `type::feature` or
  // similar scored guesses. They now resolve to the unscored fallback
  // `type::task` so promote no longer skips them, but the confidence bit
  // marks them as not-yet-scored so a future operator/typify verb can sharpen.
  const fallbackCases: string[] = [
    "Document beads JSON schema and common jq patterns", // GH-137
    "Document test naming convention in CLAUDE.md", // GH-122
    "define vocabulary",
    "audit recent transcripts",
    "establish naming convention",
    "formalize the schema",
    "map the dependency graph",
    "evaluate Notion CLI options",
  ];

  for (const title of fallbackCases) {
    test(`"${title}" → type::task unscored (fallback, not a scored guess)`, () => {
      const result = classifyTitle(title);
      expect(result.type).toBe("task");
      expect(result.typeConfidence).toBe("unscored");
    });
  }
});

describe("classifyTitle — area heuristic", () => {
  const cases: Array<[string, string | undefined]> = [
    // GH-937 ticket spot-checks
    ["Experiment: emit block-friendly output", "warp"],
    ["fix(prx): `prx nw` ignores something", "prx"],
    // claude-code variants
    ["bug: claude-code permission prompt missing", "claude-code"],
    ["feat: integrate claude code statusline", "claude-code"],
    // home-manager / nix
    ["chore: update home-manager flake", "home-manager"],
    ["bump nix flake inputs", "home-manager"],
    // notion
    ["spike: notion OAuth dead-end", "notion"],
    // warp variants
    ["enable warpify in tmux", "warp"],
    // tmux (wins over prx if both terms present? — no, first match wins; tmux comes after warp in rule order)
    ["fix: tmux pane title escapes", "tmux"],
    // tui / ink
    ["adopt Ink for TUI kernel", "tui"],
    // beads
    ["bug(beads): hydrate fails on fresh worktree", "beads"],
    ["fix: `bd github sync` lag", "beads"],
    // ci / actions
    ["fix: github actions cache miss", "ci"],
    ["bump CI runner image", "ci"],
    // prx fallback (broad)
    ["feat(triage): add classify verb", "prx"],
    ["bug: parity chain skip", "prx"],
    ["chore: prune worktree leftovers", "prx"],
    // no area
    ["random title with no prefix", undefined],
    ["define vocabulary", undefined],
  ];

  for (const [title, expectedArea] of cases) {
    test(`"${title}" → area::${expectedArea ?? "(none)"}`, () => {
      const result = classifyTitle(title);
      expect(result.area).toBe(expectedArea as never);
    });
  }
});

describe("classifyTitle — case insensitivity", () => {
  test("uppercase BUG: matches bug rule", () => {
    expect(classifyTitle("BUG: oh no").type).toBe("bug");
  });

  test("mixed-case Refactor matches chore rule (case-insensitive)", () => {
    expect(classifyTitle("Refactor(prx): split module").type).toBe("chore");
  });
});

describe("classifyIssueRow", () => {
  test("preserves currentLabels and url; GH-970 emits priority::none + unscored", () => {
    const issue: FallbackIssue = {
      number: 919,
      title: "feat(prx): triage classifier",
      url: "https://github.com/bdelanghe/ai-home/issues/919",
      labels: [{ name: "needs-triage" }, { name: "priority::high" }],
    };
    const row = classifyIssueRow(issue);
    expect(row.number).toBe(919);
    expect(row.type).toBe("feature");
    expect(row.typeConfidence).toBe("scored");
    expect(row.priority).toBe("none");
    expect(row.priorityConfidence).toBe("unscored");
    expect(row.area).toBe("prx");
    expect(row.effort).toBeUndefined();
    expect(row.currentLabels).toEqual(["needs-triage", "priority::high"]);
    // Operator-set priority::high will be preserved by apply via GH-957
    // hasPriority gate; the row's priority::none is suppressed there.
  });

  test("GH-988: missing labels treated as empty array; type::task unscored fallback + priority::none (GH-970)", () => {
    const issue: FallbackIssue = {
      number: 1,
      title: "task no prefix",
      url: "https://github.com/o/r/issues/1",
    };
    const row = classifyIssueRow(issue);
    expect(row.currentLabels).toEqual([]);
    expect(row.type).toBe("task");
    expect(row.typeConfidence).toBe("unscored");
    expect(row.area).toBeUndefined();
    expect(row.effort).toBeUndefined();
    expect(row.priority).toBe("none");
    expect(row.priorityConfidence).toBe("unscored");
  });

  test("GH-988: GH-741 (Experiment) → unscored fallback + area::warp + priority::none", () => {
    const issue: FallbackIssue = {
      number: 741,
      title: "Experiment: emit block-friendly output",
      url: "https://github.com/bdelanghe/ai-home/issues/741",
      labels: [],
    };
    const row = classifyIssueRow(issue);
    // No TYPE_RULES arm fires; GH-988 fallback emits type::task unscored.
    expect(row.type).toBe("task");
    expect(row.typeConfidence).toBe("unscored");
    expect(row.area).toBe("warp");
    expect(row.priority).toBe("none");
    expect(row.priorityConfidence).toBe("unscored");
    expect(row.effort).toBeUndefined();
  });

  test("GH-701 (fix(prx)) → bug + prx + priority::none (GH-970)", () => {
    const issue: FallbackIssue = {
      number: 701,
      title: "fix(prx): `prx nw` ignores --target",
      url: "https://github.com/bdelanghe/ai-home/issues/701",
      labels: [],
    };
    const row = classifyIssueRow(issue);
    expect(row.type).toBe("bug");
    expect(row.typeConfidence).toBe("scored");
    expect(row.area).toBe("prx");
    expect(row.priority).toBe("none");
    expect(row.priorityConfidence).toBe("unscored");
    expect(row.effort).toBeUndefined();
  });

  test("GH-988: title-driven spike (spike(...) prefix) sets row.spike = true", () => {
    const issue: FallbackIssue = {
      number: 42,
      title: "spike(prx): investigate notion auth",
      url: "https://github.com/o/r/issues/42",
      labels: [],
    };
    const row = classifyIssueRow(issue);
    expect(row.type).toBe("task");
    expect(row.typeConfidence).toBe("scored");
    expect(row.spike).toBe(true);
  });

  test("GH-988 + GH-1489: legacy spike-only issue (type::spike, no type::task) carries spike forward", () => {
    const issue: FallbackIssue = {
      number: 1500,
      title: "Some legacy spike issue",
      url: "https://github.com/o/r/issues/1500",
      labels: [{ name: "type::spike" }],
    };
    const row = classifyIssueRow(issue);
    expect(row.type).toBe("task");
    // No scored TYPE_RULES arm fires (title-driven), so the type axis is
    // unscored; the spike bit comes from the label-driven path.
    expect(row.typeConfidence).toBe("unscored");
    expect(row.spike).toBe(true);
  });
});

describe("classifyQueue", () => {
  test("plan validates against schema", () => {
    const issues: FallbackIssue[] = [
      {
        number: 1,
        title: "feat: x",
        url: "https://github.com/o/r/issues/1",
        labels: [],
      },
    ];
    const plan = classifyQueue(issues, "o/r", "2026-04-28T20:00:00Z");
    expect(plan.repo).toBe("o/r");
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.type).toBe("feature");
  });
});

describe("formatLabelPlan", () => {
  test("json output is parseable and round-trips", () => {
    const plan = classifyQueue(
      [{ number: 1, title: "fix: bug", url: "https://github.com/o/r/issues/1", labels: [] }],
      "o/r",
      "2026-04-28T20:00:00Z",
    );
    const json = formatLabelPlan(plan, "json");
    expect(JSON.parse(json)).toEqual(plan);
  });

  test("tsv output has header and one row per issue", () => {
    const plan = classifyQueue(
      [
        { number: 1, title: "feat: x", url: "https://github.com/o/r/issues/1", labels: [] },
        { number: 2, title: "bug: y", url: "https://github.com/o/r/issues/2", labels: [] },
      ],
      "o/r",
      "2026-04-28T20:00:00Z",
    );
    const tsv = formatLabelPlan(plan, "tsv");
    const lines = tsv.split("\n");
    // 2 metadata + 1 header + 2 rows
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe("number\ttype\tpriority\tarea\teffort\tproposed\ttitle");
    const row1Cols = lines[3]!.split("\t");
    expect(row1Cols[0]).toBe("1");
    expect(row1Cols[1]).toBe("feature"); // type fired
    expect(row1Cols[2]).toBe("none"); // priority::none default (GH-970)
    expect(row1Cols[4]).toBe(""); // effort silent (GH-952)
  });
});

describe("runTriageClassify", () => {
  function makeOutput() {
    const log: string[] = [];
    const error: string[] = [];
    return {
      output: { log: (line: string) => log.push(line), error: (line: string) => error.push(line) },
      log,
      error,
    };
  }

  test("classifies live queue via injected listOpenIssues", () => {
    const { output, log } = makeOutput();
    const code = runTriageClassify(
      { format: "json", limit: 0 },
      output,
      {
        listOpenIssues: () => [
          { number: 1, title: "feat: x", url: "https://github.com/o/r/issues/1", labels: [] },
        ],
        repoNameWithOwner: () => "o/r",
        cwd: () => "/tmp",
        now: () => new Date("2026-04-28T20:00:00Z"),
      },
    );
    expect(code).toBe(0);
    const plan = JSON.parse(log[0]!);
    expect(plan.repo).toBe("o/r");
    expect(plan.rows[0]!.type).toBe("feature");
  });

  test("respects --limit by truncating issues", () => {
    const { output, log } = makeOutput();
    const code = runTriageClassify(
      { format: "json", limit: 1 },
      output,
      {
        listOpenIssues: () => [
          { number: 1, title: "feat: a", url: "https://github.com/o/r/issues/1", labels: [] },
          { number: 2, title: "feat: b", url: "https://github.com/o/r/issues/2", labels: [] },
        ],
        repoNameWithOwner: () => "o/r",
        cwd: () => "/tmp",
        now: () => new Date("2026-04-28T20:00:00Z"),
      },
    );
    expect(code).toBe(0);
    const plan = JSON.parse(log[0]!);
    expect(plan.rows).toHaveLength(1);
  });

  test("--from reads triage status JSON", () => {
    const { output, log } = makeOutput();
    const fixture = JSON.stringify({
      repo: "o/r",
      totalOpen: 1,
      totalUntriaged: 1,
      issues: [
        { number: 5, title: "feat(prx): add x", url: "https://github.com/o/r/issues/5", labels: [] },
      ],
    });
    const code = runTriageClassify(
      { format: "json", limit: 0, from: "/tmp/queue.json" },
      output,
      {
        readFileSync: () => fixture,
        listOpenIssues: () => {
          throw new Error("should not call live gh when --from is set");
        },
        cwd: () => "/tmp",
        now: () => new Date("2026-04-28T20:00:00Z"),
      },
    );
    expect(code).toBe(0);
    const plan = JSON.parse(log[0]!);
    expect(plan.repo).toBe("o/r");
    expect(plan.rows[0]!.type).toBe("feature");
  });

  test("--from with bad JSON returns error code 1", () => {
    const { output, error } = makeOutput();
    const code = runTriageClassify(
      { format: "json", limit: 0, from: "/tmp/queue.json" },
      output,
      {
        readFileSync: () => "not json",
        cwd: () => "/tmp",
        now: () => new Date(),
      },
    );
    expect(code).toBe(1);
    expect(error.join("\n")).toContain("not valid JSON");
  });

  test("classify output is stable across runs (idempotent)", () => {
    const issues: FallbackIssue[] = [
      { number: 1, title: "feat: x", url: "https://github.com/o/r/issues/1", labels: [] },
      { number: 2, title: "bug: y", url: "https://github.com/o/r/issues/2", labels: [] },
    ];
    const a = makeOutput();
    const b = makeOutput();
    runTriageClassify(
      { format: "json", limit: 0 },
      a.output,
      {
        listOpenIssues: () => issues,
        repoNameWithOwner: () => "o/r",
        cwd: () => "/tmp",
        now: () => new Date("2026-04-28T20:00:00Z"),
      },
    );
    runTriageClassify(
      { format: "json", limit: 0 },
      b.output,
      {
        listOpenIssues: () => issues,
        repoNameWithOwner: () => "o/r",
        cwd: () => "/tmp",
        now: () => new Date("2026-04-28T20:00:00Z"),
      },
    );
    expect(a.log[0]).toBe(b.log[0]);
  });

  describe("--require-budget gate", () => {
    function makeOutput() {
      const log: string[] = [];
      const error: string[] = [];
      return {
        output: { log: (line: string) => log.push(line), error: (line: string) => error.push(line) },
        log,
        error,
      };
    }

    test("graphql remaining ≥ requireBudget → proceeds; refresh called once", () => {
      const { output, log } = makeOutput();
      let refreshCalls = 0;
      const code = runTriageClassify(
        { format: "json", limit: 0, requireBudget: 500 },
        output,
        {
          listOpenIssues: () => [
            { number: 1, title: "feat: x", url: "https://github.com/o/r/issues/1", labels: [] },
          ],
          repoNameWithOwner: () => "o/r",
          cwd: () => "/tmp",
          now: () => new Date("2026-05-02T17:36:00Z"),
          refreshBudget: (() => {
            refreshCalls += 1;
            return [
              { bucket: "core", limit: 5000, remaining: 4994, resetAt: 0, fetchedAt: 0 },
              { bucket: "graphql", limit: 5000, remaining: 4500, resetAt: 0, fetchedAt: 0 },
              { bucket: "search", limit: 30, remaining: 30, resetAt: 0, fetchedAt: 0 },
            ];
          }) as never,
        },
      );
      expect(code).toBe(0);
      expect(refreshCalls).toBe(1);
      expect(log).toHaveLength(1);
    });

    test("graphql remaining < requireBudget → exits 1 with structured stderr playbook", () => {
      const { output, log, error } = makeOutput();
      const now = new Date("2026-05-02T17:36:00Z");
      // 6 minutes 12 seconds in the future
      const resetAt = now.getTime() + (6 * 60 + 12) * 1000;
      let listIssuesCalled = false;
      const code = runTriageClassify(
        { format: "json", limit: 0, requireBudget: 500 },
        output,
        {
          listOpenIssues: () => {
            listIssuesCalled = true;
            return [];
          },
          repoNameWithOwner: () => "o/r",
          cwd: () => "/tmp",
          now: () => now,
          refreshBudget: (() => [
            { bucket: "core", limit: 5000, remaining: 4994, resetAt, fetchedAt: 0 },
            { bucket: "graphql", limit: 5000, remaining: 42, resetAt, fetchedAt: 0 },
            { bucket: "search", limit: 30, remaining: 30, resetAt, fetchedAt: 0 },
          ]) as never,
        },
      );
      expect(code).toBe(1);
      expect(log).toHaveLength(0);
      expect(listIssuesCalled).toBe(false);
      const text = error.join("\n");
      expect(text).toContain("triage classify: GraphQL budget below threshold");
      expect(text).toContain("remaining: 42 / required: 500");
      expect(text).toContain("(in 6m 12s)");
      expect(text).toContain("PRX_GITHUB_TOKEN");
      expect(text).toContain("PRX_REST_LITE=1");
    });

    test("--require-budget with refreshBudget returning null fails closed (exit 1, structured error)", () => {
      const { output, log, error } = makeOutput();
      let listIssuesCalled = false;
      const code = runTriageClassify(
        { format: "json", limit: 0, requireBudget: 500 },
        output,
        {
          listOpenIssues: () => {
            listIssuesCalled = true;
            return [];
          },
          repoNameWithOwner: () => "o/r",
          cwd: () => "/tmp",
          now: () => new Date("2026-05-02T17:36:00Z"),
          refreshBudget: (() => null) as never,
        },
      );
      expect(code).toBe(1);
      expect(log).toHaveLength(0);
      expect(listIssuesCalled).toBe(false);
      expect(error.join("\n")).toContain("`gh api rate_limit` failed");
    });

    test("--require-budget with no graphql bucket in snapshot fails closed", () => {
      const { output, log, error } = makeOutput();
      const code = runTriageClassify(
        { format: "json", limit: 0, requireBudget: 500 },
        output,
        {
          listOpenIssues: () => [],
          repoNameWithOwner: () => "o/r",
          cwd: () => "/tmp",
          now: () => new Date("2026-05-02T17:36:00Z"),
          refreshBudget: (() => [
            { bucket: "core", limit: 5000, remaining: 5000, resetAt: 0, fetchedAt: 0 },
          ]) as never,
        },
      );
      expect(code).toBe(1);
      expect(log).toHaveLength(0);
      expect(error.join("\n")).toContain("no graphql bucket");
    });

    test("--require-budget with --from skips the gate (file mode reads no GH)", () => {
      const { output, log } = makeOutput();
      const fixture = JSON.stringify({
        repo: "o/r",
        issues: [
          { number: 1, title: "feat: x", url: "https://github.com/o/r/issues/1", labels: [] },
        ],
      });
      let refreshCalls = 0;
      const code = runTriageClassify(
        {
          format: "json",
          limit: 0,
          requireBudget: 5000,
          from: "/tmp/queue.json",
        },
        output,
        {
          readFileSync: () => fixture,
          cwd: () => "/tmp",
          now: () => new Date("2026-05-02T17:36:00Z"),
          refreshBudget: (() => {
            refreshCalls += 1;
            return [
              { bucket: "graphql", limit: 5000, remaining: 0, resetAt: 0, fetchedAt: 0 },
            ];
          }) as never,
        },
      );
      // Even at remaining=0 with required=5000, --from bypasses the gate.
      expect(code).toBe(0);
      expect(refreshCalls).toBe(0);
      expect(log).toHaveLength(1);
    });
  });
});

// GH-1710: canonical=bd classifier branch. Iterates bd records (not GH
// issues), runs the same `classifyTitle` rule table, and emits a bd-flavored
// LabelPlan keyed by bdId.
describe("classifyBdRecord / classifyBdQueue (GH-1710)", () => {
  test("suggests type/area only at axes the bead is missing", () => {
    const row = classifyBdRecord({
      id: "spd-1",
      title: "feat(prx): add classify verb",
      priority: null,
      issueType: "",
    });
    expect(row.bdId).toBe("spd-1");
    expect(row.type).toBe("feature");
    expect(row.area).toBe("prx");
    expect(row.priority).toBe("none");
    expect(row.priorityConfidence).toBe("unscored");
    expect(row.currentPriority).toBeNull();
    expect(row.currentType).toBe("");
  });

  test("suppresses classifier output when the bead already carries a value", () => {
    const row = classifyBdRecord({
      id: "spd-2",
      title: "feat(prx): foo",
      priority: 1,
      issueType: "feature",
    });
    expect(row.type).toBeUndefined();
    expect(row.priority).toBeUndefined();
    expect(row.currentPriority).toBe(1);
    expect(row.currentType).toBe("feature");
  });

  test("classifyBdQueue parses through bdLabelPlanSchema and tags canonical=bd", () => {
    const plan = classifyBdQueue(
      [
        { id: "a", title: "fix(prx): a thing", priority: null, issueType: "" },
        { id: "b", title: "chore: bump deps", priority: 2, issueType: "" },
      ],
      "demo/demo-repo",
      "2026-05-14T00:00:00.000Z",
    );
    expect(plan.canonical).toBe("bd");
    expect(plan.repo).toBe("demo/demo-repo");
    expect(plan.rows.map((r) => r.bdId)).toEqual(["a", "b"]);
  });

  test("formatBdLabelPlan TSV renders bd-side columns", () => {
    const plan = classifyBdQueue(
      [{ id: "spd-1", title: "feat(prx): foo", priority: null, issueType: "" }],
      "demo/demo-repo",
      "2026-05-14T00:00:00.000Z",
    );
    const tsv = formatBdLabelPlan(plan, "tsv");
    expect(tsv).toContain("#canonical\tbd");
    expect(tsv).toContain("bdId");
    expect(tsv).toContain("spd-1");
  });
});

describe("runTriageClassify — canonical=bd branch (GH-1710)", () => {
  function bdCanonicalLocalRepo() {
    return {
      name: "demo-repo",
      commonDir: "/bare/io.github/demo/demo-repo.git",
      kind: "bare" as const,
      mainWorktree: null,
      worktrees: [],
      localOnlyBranches: [],
      findings: [],
      remotes: [],
      primaryRemote: {
        name: "origin",
        url: "git@github.com:demo/demo-repo.git",
        githubRepo: "demo/demo-repo",
      },
      upstreamRemote: null,
      canonical: "bd" as const,
    };
  }

  function makeExecBdReturning(records: Array<{
    id: string;
    title: string;
    priority: number | null;
    issue_type: string;
  }>) {
    return ((_args: unknown, _env?: unknown) => ({
      exitCode: 0,
      stdout: JSON.stringify(
        records.map((r) => ({
          id: r.id,
          title: r.title,
          status: "open",
          priority: r.priority,
          issue_type: r.issue_type,
          external_ref: null,
          source_system: null,
          metadata: null,
          updated_at: null,
          dependencies: [],
        })),
      ),
      stderr: "",
      policy: null,
    } as BdExecResult)) as never;
  }

  test("iterates bd substrate and never calls listOpenIssues", () => {
    const log: string[] = [];
    let ghCalls = 0;
    const code = runTriageClassify(
      { format: "json", limit: 0 },
      { log: (l) => log.push(l), error: () => {} },
      {
        cwd: () => "/some/cwd",
        now: () => new Date("2026-05-14T00:00:00Z"),
        localRepoForCwd: () => bdCanonicalLocalRepo(),
        execBd: makeExecBdReturning([
          { id: "spd-1", title: "feat(prx): foo", priority: null, issue_type: "" },
          { id: "spd-2", title: "fix(triage): bar", priority: 2, issue_type: "bug" },
        ]),
        listOpenIssues: ((..._a: unknown[]) => {
          ghCalls += 1;
          return [];
        }) as never,
      },
    );
    expect(code).toBe(0);
    expect(ghCalls).toBe(0);
    expect(log).toHaveLength(1);
    const plan = JSON.parse(log[0]!) as { canonical: string; rows: Array<{ bdId: string }> };
    expect(plan.canonical).toBe("bd");
    // spd-2 is fully triaged (priority + type set); filter drops it.
    expect(plan.rows.map((r) => r.bdId)).toEqual(["spd-1"]);
  });
});
