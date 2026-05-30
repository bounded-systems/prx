import { describe, expect, test } from "bun:test";

import {
  extractAll,
  extractBlockers,
  extractDeliverables,
  extractPlannedActions,
  type DeliverableTarget,
} from "../../src/plan/preflight_extract.ts";

type FileEntry = Extract<DeliverableTarget, { shape: "file" }>;
const isFileEntry = (d: DeliverableTarget): d is FileEntry => d.shape === "file";

describe("extractDeliverables", () => {
  test("pulls file paths from prose mentions", () => {
    const body = `
We will land:
- src/plan/preflight.ts (new)
- docs/prx/help-surface.md (updated)
- test/plan/preflight.test.ts
`;
    const out = extractDeliverables({ body });
    const paths = out
      .filter(isFileEntry)
      .map((d) => d.path);
    expect(paths).toEqual([
      "src/plan/preflight.ts",
      "docs/prx/help-surface.md",
      "test/plan/preflight.test.ts",
    ]);
  });

  test("skips fenced code-block paths to avoid example false-positives", () => {
    const body = [
      "Here is an example:",
      "```bash",
      "edit src/example/skip-me.ts",
      "```",
      "",
      "Real deliverable:",
      "- src/real/landed.ts",
    ].join("\n");
    const paths = extractDeliverables({ body })
      .filter(isFileEntry)
      .map((d) => d.path);
    expect(paths).toEqual(["src/real/landed.ts"]);
  });

  test("captures issue close + body update + comment", () => {
    const body = `
Steps:
1. Update body of GH-100 with new content
2. Post comment on #200 announcing the change
3. Close GH-100 on completion
`;
    const out = extractDeliverables({ body });
    expect(out).toContainEqual({ shape: "issue-body", issue: 100 });
    expect(out).toContainEqual({ shape: "issue-comment", issue: 200 });
    expect(out).toContainEqual({
      shape: "issue-state",
      issue: 100,
      targetState: "closed",
    });
  });

  test("merge PR shape", () => {
    const body = "Final step: merge PR #999 into main.";
    const out = extractDeliverables({ body });
    expect(out).toContainEqual({ shape: "pr-merge", pr: 999 });
    // Non-file deliverables keep their pre-GH-1516 wire shape — no context tag.
    expect(out.filter((d) => d.shape === "pr-merge").length).toBe(1);
  });

  test("dedupes identical deliverables", () => {
    const body =
      "src/foo.ts is the target. We will edit src/foo.ts in two passes.";
    const out = extractDeliverables({ body });
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ shape: "file", path: "src/foo.ts" });
  });

  test("ignores ordinary prose mentions of a path-like string", () => {
    // No top-level dir prefix → not extracted.
    const body = "See utils/helper.ts for the helper.";
    expect(extractDeliverables({ body })).toEqual([]);
  });
});

describe("extractBlockers", () => {
  test("recognises 'Blocked by #N' list items", () => {
    const body = `
## Dependencies

- Blocked by #1247
- Gated on #1244
- Depends on GH-998
`;
    const out = extractBlockers(body);
    expect(out.map((b) => b.issue).sort((a, b) => a - b)).toEqual([
      998, 1244, 1247,
    ]);
  });

  test("does not match arbitrary mid-sentence #N references", () => {
    const body = "We renamed #100 last quarter; this work follows from that.";
    expect(extractBlockers(body)).toEqual([]);
  });

  test("ignores blockers inside fenced code blocks", () => {
    const body = [
      "Real list:",
      "- Blocked by #500",
      "",
      "Example output (not real):",
      "```",
      "Blocked by #999",
      "```",
    ].join("\n");
    const issues = extractBlockers(body).map((b) => b.issue);
    expect(issues).toEqual([500]);
  });
});

describe("extractPlannedActions", () => {
  test("captures git/gh/bd action shapes", () => {
    const body = `
Steps:
- git commit the changes
- gh issue close GH-1199 on completion
- bd update --status in_progress
`;
    const out = extractPlannedActions(body);
    // GH-1516: mentions carry perspective. Legacy whole-body scan has no
    // recognised heading → perspective="unknown".
    expect(out).toContainEqual({ shape: "git", subcommand: "commit", perspective: "unknown" });
    expect(out).toContainEqual({ shape: "gh-issue", subcommand: "close", perspective: "unknown" });
    expect(out).toContainEqual({ shape: "bd", subcommand: "update", perspective: "unknown" });
  });

  test("captures Edit/Write tool references", () => {
    const body = "Use Edit src/foo/bar.ts to land the change; Write src/new/file.ts.";
    const out = extractPlannedActions(body);
    expect(out).toContainEqual({ shape: "edit", target: "src/foo/bar.ts", perspective: "unknown" });
    expect(out).toContainEqual({ shape: "write", target: "src/new/file.ts", perspective: "unknown" });
  });

  test("dedupes repeated subcommand mentions", () => {
    const body = "Run git commit, then git commit again with the fix.";
    const out = extractPlannedActions(body);
    expect(out.filter((a) => a.shape === "git").length).toBe(1);
  });
});

describe("extractAll", () => {
  test("returns all three buckets in one pass", () => {
    const body = `
Plan:
- Edit src/plan/preflight.ts
- gh issue close GH-1199
- Blocked by #1247
`;
    const out = extractAll(body);
    expect(out.deliverables.some((d) => d.shape === "file")).toBe(true);
    expect(out.actions.some((a) => a.shape === "gh-issue")).toBe(true);
    expect(out.blockers.map((b) => b.issue)).toEqual([1247]);
  });
});

describe("schema-aware extraction (GH-1359)", () => {
  // GH-1345 repro: a bug body whose Repro/Expected sections describe the
  // current broken codepath ("the path replaced by gh api graphql") must not
  // emit infeasible-action findings for `gh pr merge` mentioned in those
  // descriptive sections.
  const bug1345Body = [
    "## Description",
    "",
    "Direct-merge fallback for already-clean PRs.",
    "",
    "## Repro Steps",
    "",
    "1. Open a PR with a clean branch.",
    "2. Run `gh pr merge` — fails because automerge gate is over-strict.",
    "",
    "## Expected",
    "",
    "`gh pr update-branch` brings the PR up to date and merge succeeds.",
    "",
    "## Acceptance Criteria",
    "",
    "PR merges cleanly.",
  ].join("\n");

  test("GH-1345 repro: gh pr merge in Repro Steps does not feed actions when type=bug", () => {
    const actions = extractPlannedActions(bug1345Body, "bug");
    const ghPr = actions.filter((a) => a.shape === "gh-pr");
    expect(ghPr).toEqual([]);
  });

  // GH-1379 repro: a bug body whose Description / Repro mention `bd prime` and
  // `git push` (descriptive of the broken SessionStart hook + the standard
  // operator workflow, not planned planner writes).
  const bug1379Body = [
    "## Description",
    "",
    "SessionStart hook breaks because of a pushd-shape collision.",
    "",
    "## Repro Steps",
    "",
    "1. Open a session — `bd prime` runs and exits with a stale code.",
    "2. After a fix, `git push` to land the change.",
    "",
    "## Acceptance Criteria",
    "",
    "Hook runs cleanly on session open.",
  ].join("\n");

  test("GH-1379 repro: bd prime / git push in Repro Steps do not feed actions when type=bug", () => {
    const actions = extractPlannedActions(bug1379Body, "bug");
    const bdActions = actions.filter((a) => a.shape === "bd");
    const gitActions = actions.filter((a) => a.shape === "git");
    expect(bdActions).toEqual([]);
    expect(gitActions).toEqual([]);
  });

  test("legacy fallback: same body with no intakeType still scans whole body", () => {
    // GH-1832: the original `bug1345Body` only mentions `gh pr merge` /
    // `gh pr update-branch`, both of which are now phantom verbs dropped by
    // Layer 1's vocabulary filter. To keep pinning the legacy-fallback
    // contract (no intakeType → no schema-section filter), append a
    // vocab-known canary (`gh pr view`) inside a non-actions-bearing section.
    const bodyWithKnownVerb = `${bug1345Body}\n\n## Repro Steps\n\nAlso \`gh pr view\` to confirm the PR state.`;
    const actions = extractPlannedActions(bodyWithKnownVerb);
    const ghPr = actions.filter((a) => a.shape === "gh-pr");
    // GH-1516: section heading walks into the mention; legacy scan exposes
    // the H2 heading text verbatim.
    expect(ghPr).toContainEqual({
      shape: "gh-pr",
      subcommand: "view",
      perspective: "unknown",
      section: "Repro Steps",
    });
  });

  test("mixed: prose action in non-actions-bearing section is dropped, action in Acceptance is kept", () => {
    const body = [
      "## Description",
      "",
      "feature: add a thing.",
      "",
      "## Repro Steps",
      "",
      "Run `gh pr merge` to see the failure.",
      "",
      "## Acceptance Criteria",
      "",
      "Edit src/plan/feature.ts to land the change.",
    ].join("\n");
    const actions = extractPlannedActions(body, "bug");
    expect(actions).toContainEqual({
      shape: "edit",
      target: "src/plan/feature.ts",
      perspective: "planner-now",
      section: "Acceptance Criteria",
    });
    const ghPr = actions.filter((a) => a.shape === "gh-pr");
    expect(ghPr).toEqual([]);
  });

  test("schema-aware extractDeliverables filters out file paths in non-actions-bearing sections", () => {
    const body = [
      "## Description",
      "",
      "Land src/feature/landed.ts.",
      "",
      "## Environment",
      "",
      "Examples: src/old/example.ts is the prior path.",
    ].join("\n");
    const out = extractDeliverables({ body, intakeType: "bug" });
    const paths = out
      .filter(isFileEntry)
      .map((d) => d.path);
    expect(paths).toEqual(["src/feature/landed.ts"]);
  });

  test("extractAll threads intakeType into actions and deliverables", () => {
    const out = extractAll(bug1345Body, undefined, "bug");
    expect(out.actions.filter((a) => a.shape === "gh-pr")).toEqual([]);
  });

  // GH-1353 repro: verb-supply ticket bodies (GH-1187 / GH-998 / GH-1186 /
  // GH-1235 / GH-1242 family) carry a `type::*` label but their H2 headings
  // (`## Why`, `## Proposal`, `## Mirror of`, `## Out of scope`) don't match
  // any schema field. parseStructuredBody returns empty `fields` →
  // selectActionsBearingProse returns "" → no extraction.
  //
  // This test pins the empty-fields path independently of the
  // canonical-headings tests above. A future refactor that defaulted unparsed
  // prose into an actions-bearing field would silently re-introduce the
  // original false-positive class without breaking the GH-1345 / GH-1379
  // cases.
  const verbSupply1353Body = [
    "## Why",
    "",
    "Today operators run raw `bd create --external-ref` and",
    "`bd dep add --type=parent-child` directly when promoting children.",
    "",
    "## Proposal",
    "",
    "Wrap those calls behind `prx triage promote-children`.",
    "",
    "## Mirror of",
    "",
    "- GH-1186 (`prx plan supply` — planner-side equivalent)",
    "",
    "## Out of scope",
    "",
    "Changes to `gh issue create` itself.",
  ].join("\n");

  test("GH-1353 repro: feature-typed verb-supply body extracts 0 actions/deliverables", () => {
    const out = extractAll(verbSupply1353Body, undefined, "feature");
    expect(out.actions).toEqual([]);
    expect(out.deliverables).toEqual([]);
  });

  test("GH-1353 repro: epic-typed verb-supply body extracts 0 actions/deliverables", () => {
    // GH-1187 / GH-998 / GH-1186 / GH-1235 / GH-1242 are all `type::epic`.
    const out = extractAll(verbSupply1353Body, undefined, "epic");
    expect(out.actions).toEqual([]);
    expect(out.deliverables).toEqual([]);
  });

  // GH-1832 repro: GH-1829's body uses bd/gh/git words as nouns ("bd records",
  // "gh issues that are closed-as-dup", "git commits") — the action regex
  // greedily captures `record`/`records`/`issues`/`commits` as subcommands and
  // the planner-side preflight refuses entry. The vocabulary filter in
  // extractPlannedActions must drop these at extraction time so no
  // infeasible-action finding is ever synthesised.
  const bug1832Body = [
    "## Description",
    "",
    "When ingest sees a row whose closed-as-dup target also has bd records,",
    "we should ignore closed-as-dup bd records and emit a single bd record",
    "per external_ref. The current path opens gh issues that are closed-as-dup,",
    "duplicating git commits on the parity chain.",
    "",
    "## Acceptance Criteria",
    "",
    "- Skip all bd records sharing the row's external_ref.",
    "- Surface a single bd record per external_ref.",
    "- Do not reopen gh issues that are closed-as-dup.",
  ].join("\n");

  test("GH-1832 repro: noun-as-verb prose (bd records, gh issues, git commits) is dropped under type=bug", () => {
    const actions = extractPlannedActions(bug1832Body, "bug");
    const bdActions = actions.filter((a) => a.shape === "bd");
    const ghActions = actions.filter(
      (a) => a.shape === "gh-pr" || a.shape === "gh-issue",
    );
    const gitActions = actions.filter((a) => a.shape === "git");
    expect(bdActions).toEqual([]);
    expect(ghActions).toEqual([]);
    expect(gitActions).toEqual([]);
  });

  test("GH-1832 repro: vocabulary filter also fires on the legacy whole-body scan (no intakeType)", () => {
    // Pin the layer independently of the schema-section filter — the vocab
    // filter, not selectActionsBearingProse, is what's doing the work here.
    const actions = extractPlannedActions(bug1832Body);
    const phantom = actions.filter(
      (a) =>
        (a.shape === "bd" && (a.subcommand === "records" || a.subcommand === "record")) ||
        ((a.shape === "gh-issue" || a.shape === "gh-pr") && a.subcommand === "issues") ||
        (a.shape === "git" && a.subcommand === "commits"),
    );
    expect(phantom).toEqual([]);
  });

  // GH-1516: extraction-time fixes for false-positives surfaced by GH-1514 /
  // GH-1515 / GH-1548. Verb-context (deliverables) and section-derived
  // perspective (actions) replace the unconditional "any matching token"
  // shape that drove operators to routine `--skip-preflight`.
  describe("GH-1516: verb-context + perspective + STOP_VERB_TOKENS", () => {
    test("GH-1514 repro: 'names bd as canonical' — `bd as` dropped by STOP_VERB_TOKENS", () => {
      const body = [
        "## Description",
        "",
        "This ADR names bd as the canonical authority for issue identity.",
        "",
        "## Acceptance Criteria",
        "",
        "Author docs/architecture/Architecture.md.",
      ].join("\n");
      const actions = extractPlannedActions(body, "chore");
      const bdAs = actions.filter(
        (a) => a.shape === "bd" && a.subcommand === "as",
      );
      expect(bdAs).toEqual([]);
    });

    test("GH-1514 repro: cited ADR path tagged context=reference (not emitted as a create deliverable)", () => {
      const body = [
        "## Description",
        "",
        "The architecture document will be authored. We cite",
        "docs/spikes/GH-1500-authority.md as the source of truth.",
        "",
        "## Acceptance Criteria",
        "",
        "Land docs/architecture/Architecture.md as the canonical document.",
      ].join("\n");
      const out = extractDeliverables({ body, intakeType: "chore" });
      const fileMentions = out.filter(isFileEntry);
      const adr = fileMentions.find(
        (d) => d.path === "docs/spikes/GH-1500-authority.md",
      );
      expect(adr).toBeDefined();
      expect(adr?.context).toBe("reference");
    });

    test("GH-1515 repro: parenthetical ADR path tagged context=reference", () => {
      const body = [
        "## Description",
        "",
        "Land the architecture doc.",
        "",
        "## Acceptance Criteria",
        "",
        "The ADR (docs/spikes/GH-1500-authority.md) must be referenced.",
      ].join("\n");
      const out = extractDeliverables({ body, intakeType: "chore" });
      const adr = out
        .filter(isFileEntry)
        .find((d) => d.path === "docs/spikes/GH-1500-authority.md");
      expect(adr).toBeDefined();
      expect(adr?.context).toBe("reference");
    });

    test("GH-1548 repro: 'edit src/pr-state/github.ts' tagged context=modify", () => {
      const body = [
        "## Description",
        "",
        "Modify the existing helper.",
        "",
        "## Acceptance Criteria",
        "",
        "Edit src/pr-state/github.ts to add `repoNameWithOwner`.",
      ].join("\n");
      const out = extractDeliverables({ body, intakeType: "chore" });
      const target = out
        .filter(isFileEntry)
        .find((d) => d.path === "src/pr-state/github.ts");
      expect(target).toBeDefined();
      // ACTION_EDIT_RE strips "Edit src/..." from the section before
      // deliverables sees it; the path is then governed by the next nearest
      // verb in scope ("add"). Either way the mention must NOT be context=
      // create — the file pre-exists.
      expect(target?.context).not.toBe("create");
    });

    test("GH-1548 repro: git verbs under ## Approach tagged perspective=executor-later (legacy fallback)", () => {
      const body = [
        "## Description",
        "",
        "Add a helper that needs git introspection.",
        "",
        "## Approach",
        "",
        "Run `git remote get-url origin` to read the remote, then",
        "`git rev-parse --git-common-dir` to resolve the .git directory.",
        "",
        "## Acceptance Criteria",
        "",
        "Helper exposes `repoNameWithOwner`.",
      ].join("\n");
      // Legacy scan — no intakeType — so the section walker picks up the
      // non-canonical `## Approach` heading and tags it executor-later.
      const actions = extractPlannedActions(body);
      const gitRemote = actions.find(
        (a) => a.shape === "git" && a.subcommand === "remote",
      );
      expect(gitRemote).toBeDefined();
      expect(gitRemote?.perspective).toBe("executor-later");
      expect(gitRemote?.section).toBe("Approach");
    });

    test("STOP_VERB_TOKENS: every preposition / copula is rejected before isKnownSubcommand", () => {
      const stopBody = [
        "## Acceptance Criteria",
        "",
        "Tickets that mention bd as authoritative, gh issue is wrong,",
        "and git to the remote should not produce action mentions.",
      ].join("\n");
      const actions = extractPlannedActions(stopBody, "chore");
      // None of `as` / `is` / `to` are real subcommands; STOP_VERB_TOKENS is
      // the structural layer that drops them even before `isKnownSubcommand`.
      const offenders = actions.filter(
        (a) =>
          (a.shape === "bd" && a.subcommand === "as") ||
          ((a.shape === "gh-issue" || a.shape === "gh-pr") && a.subcommand === "is") ||
          (a.shape === "git" && a.subcommand === "to"),
      );
      expect(offenders).toEqual([]);
    });
  });

  test("GH-1832: real bd/gh/git subcommands still extract under the legacy scan", () => {
    // Vocab filter must not over-prune — every real subcommand referenced in
    // real plan bodies stays extractable.
    const realBody = [
      "We will `bd update` after acceptance, `gh pr view` to confirm CI,",
      "and `git push` to publish the branch.",
    ].join("\n");
    const actions = extractPlannedActions(realBody);
    expect(actions).toContainEqual({
      shape: "bd",
      subcommand: "update",
      perspective: "unknown",
    });
    expect(actions).toContainEqual({
      shape: "gh-pr",
      subcommand: "view",
      perspective: "unknown",
    });
    expect(actions).toContainEqual({
      shape: "git",
      subcommand: "push",
      perspective: "unknown",
    });
  });
});
