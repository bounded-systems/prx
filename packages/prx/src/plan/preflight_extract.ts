// GH-1239: deterministic extractors for `prx plan preflight`.
//
// Pure functions over an issue body. Conservative — under-extract rather than
// over-extract, so a noisy false-negative is the safe failure mode (the
// existing planner UX still runs, just without the preflight signal). The
// inverse — false-positives that block real work — is what we have to avoid.
//
// GH-1359: when an `intakeType` is supplied, action and deliverable extraction
// route through `parseStructuredBody` and only feed the regex pipeline with
// content from sections whose schema field has `actionsBearing: true`. Bodies
// with no recognised schema (or with `intakeType` undefined) fall back to the
// legacy whole-body scan so hand-written and pre-schema bodies keep working.
//
// GH-1516: extraction is now mention-shaped. Each match is tagged with a
// `DeliverableContext` (file deliverables) or `ActionPerspective` (planned
// actions) drawn from the H2 heading the match appears under. `preflight.ts`
// reads those tags to suppress false-positives that previously refused healthy
// tickets: reference-only file paths in Acceptance Criteria (`cites X`, `(X)`)
// and executor-time prose verbs in `## Approach`-style sections.
//
// We do not parse markdown beyond H2-heading boundaries. The parser
// recognises headings on `^##\s+<text>$` lines and matches `<text>` against
// the canonical heading set case-insensitively, with trailing whitespace and
// trailing `.`/`:` characters stripped before comparison. The action regex
// still runs over plain prose within a section.

import {
  INTAKE_BODY_FIELDS_META,
  parseStructuredBody,
  type IntakeBodySchemaType,
} from "../intake/schemas/index.ts";
import { isKnownSubcommand } from "@bounded-systems/policy";
import {
  FileDeliverableMention,
  PlannedActionMention,
  type ActionPerspective,
  type DeliverableContext,
} from "./preflight_schema.ts";

// GH-1516: extraction output types now carry verb-context / perspective. The
// non-file deliverable variants are unchanged so existing consumers and tests
// that compare on issue/pr fields keep working.
export type DeliverableTarget =
  | FileDeliverableMention
  | { shape: "issue-comment"; issue: number; anchor?: string }
  | { shape: "issue-body"; issue: number; anchor?: string }
  | { shape: "issue-state"; issue: number; targetState: "closed" | "open" }
  | { shape: "pr-merge"; pr: number };

export type BlockerRef = {
  issue: number;
  source: "issue-body";
};

// A planned action shape — what the operator declared they would *do*. The
// planner profile cannot enumerate the executor's allowlist on its own, so
// the extractor pulls action shapes out of the body and the feasibility check
// in `preflight.ts` is what compares them against the executor profile.
//
// GH-1516: PlannedAction is now PlannedActionMention (every match carries
// section + perspective). Back-compat alias preserved at the type level.
export type PlannedAction = PlannedActionMention;

// File path — recognise paths under top-level project directories and a
// minimal extension allowlist. The sigil prefixes (`)`, `,`, backtick) keep
// us from grabbing trailing punctuation when the path is inline-quoted in
// prose. Anchored at a word boundary so we don't pull from substrings.
const FILE_PATH_RE =
  /\b((?:src|docs|test|tests|scripts|migrations)\/[^\s)`,;:'"]+\.(?:ts|tsx|js|md|sh|json|yaml|yml|sql))\b/g;

// "post comment on GH-N" / "post comment on #N"
const COMMENT_RE = /\bpost\s+comment\s+on\s+(?:GH-|#)(\d+)/gi;

// "update body of GH-N" / "update body of #N"
const BODY_RE = /\bupdate\s+(?:body|description)\s+of\s+(?:GH-|#)(\d+)/gi;

// "close GH-N" / "close #N" — captured separately from `close` as a verb
// elsewhere because the issue ref disambiguates the intent. We only match
// when the verb is followed by the ref directly.
const CLOSE_RE = /\bclose\s+(?:issue\s+)?(?:GH-|#)(\d+)/gi;

// "merge PR #N" / "merge #N" — second form is broader, but the planner only
// uses it for the PR shape (issue-merge isn't a thing).
const MERGE_PR_RE = /\bmerge\s+(?:PR\s+)?#(\d+)/gi;

// "Blocked by #N" / "Gated on #N" / "gates: #N" — leading-anchor or
// list-item form, not arbitrary mid-sentence references. Conservative on
// purpose: GH-1199's body cites `GH-1238` in prose without intending it as
// a blocker, and we don't want that kind of mention to fail preflight.
const BLOCKER_RE =
  /(?:^|\n)\s*(?:[-*]\s+)?(?:blocked\s+by|gated\s+on|depends\s+on|gates)\s*:?\s*(?:GH-|#)(\d+)/gi;

// Action-shape patterns. Each captures the verb and optional target so the
// feasibility predicate can reason about subcommand-level allowlists.
//
// We accept either backticked verbs or plain inline mentions. The leading
// boundary prevents matching inside a longer word.
const ACTION_GIT_RE = /\bgit\s+([a-z][a-z-]{1,20})\b/gi;
const ACTION_GH_RE = /\bgh\s+(pr|issue)\s+([a-z][a-z-]{1,20})\b/gi;
const ACTION_BD_RE = /\bbd\s+([a-z][a-z-]{1,20})\b/gi;

// Edit/Write tool references. The Claude tool names are capitalised in body
// prose ("use Edit to …", "Write src/foo/bar.ts"). Path capture stops at
// whitespace or trailing punctuation so a sentence-ending period doesn't get
// folded into the target.
const ACTION_EDIT_RE =
  /\b(Edit|Write)\s+((?:src|docs|test|tests|scripts)\/[^\s`,;]*[A-Za-z0-9_/\-])/g;

// GH-1516: structural defense against the GH-1514 false-positive class. After
// the per-tool regex matches a candidate subcommand, drop the match if the
// captured token is an English preposition / conjunction / copula. This is
// layered ABOVE `isKnownSubcommand`: cheaper, and structurally meaningful
// (these tokens cannot legitimately be subcommands of any tool — see the
// invariant comment at POLICY_TABLE in src/tools/policy.ts).
const STOP_VERB_TOKENS = new Set<string>([
  // Prepositions
  "as",
  "to",
  "for",
  "with",
  "from",
  "in",
  "at",
  "of",
  "on",
  "by",
  "into",
  "via",
  "about",
  "after",
  "before",
  // Conjunctions
  "or",
  "and",
  "but",
  "vs",
  "than",
  "if",
  // Articles
  "a",
  "an",
  "the",
  // Copulas / verb-shaped second-tokens that survive `[a-z-]` matching
  "is",
  "was",
  "were",
  "are",
  "be",
  "been",
  "like",
  "not",
]);

// GH-1516: governing-verb vocabulary for file-path context classification.
// `create` deliverables count as "should this exist yet?" axis-1 checks;
// `modify` and `reference` mentions are suppressed.
const CREATE_VERBS = new Set<string>([
  "add",
  "create",
  "introduce",
  "land",
  "ship",
  "write",
  "writes",
  "new",
  "emit",
  "produce",
  "generate",
  "draft",
]);

const MODIFY_VERBS = new Set<string>([
  "edit",
  "edits",
  "modify",
  "modifies",
  "update",
  "updates",
  "change",
  "changes",
  "replace",
  "replaces",
  "refactor",
  "refactors",
  "rewrite",
  "rewrites",
  "patch",
  "patches",
  "fix",
  "fixes",
  "amend",
  "amends",
  "extend",
  "extends",
]);

const REFERENCE_VERBS = new Set<string>([
  "see",
  "sees",
  "per",
  "cite",
  "cites",
  "cited",
  "name",
  "names",
  "named",
  "reference",
  "references",
  "referenced",
  "point",
  "points",
  "from",
  "in",
  "at",
  "inside",
  "within",
  "via",
  "mention",
  "mentions",
  "mentioned",
  "describe",
  "describes",
  "described",
]);

// GH-1516: H2-heading → action-perspective map. Sections describing what the
// executor will eventually run get `executor-later`; sections committing
// planner-time contracts get `planner-now`. `documentary` is for sections
// that mix both (e.g. Description); we treat them as planner-now downstream
// so we don't relax the gate for mixed prose.
const PERSPECTIVE_BY_HEADING: Record<string, ActionPerspective> = {
  "acceptance criteria": "planner-now",
  "success criteria": "planner-now",
  approach: "executor-later",
  "proposed approach": "executor-later",
  implementation: "executor-later",
  plan: "executor-later",
  design: "executor-later",
  description: "documentary",
};

function normalizeHeading(text: string): string {
  return text
    .replace(/[:.\s]+$/, "")
    .trim()
    .toLowerCase();
}

function derivePerspective(heading: string | undefined): ActionPerspective {
  if (!heading) return "unknown";
  const norm = normalizeHeading(heading);
  return PERSPECTIVE_BY_HEADING[norm] ?? "unknown";
}

// Strip fenced and indented code blocks before extracting. Action and file
// references inside fenced examples (e.g. "```bash\n  git rebase main\n```")
// are illustrative, not declared deliverables — folding them in produced too
// many false positives in dry-runs against the GH-1239 body itself.
function stripCodeBlocks(body: string): string {
  let out = body;
  // Fenced blocks (```...``` or ~~~...~~~)
  out = out.replace(/```[\s\S]*?```/g, "");
  out = out.replace(/~~~[\s\S]*?~~~/g, "");
  // Inline code spans — preserve the visible word but drop the backticks so
  // the regex anchors still hit. We keep the content because the body uses
  // `Edit` / `Write` inline as type names.
  out = out.replace(/`([^`\n]+)`/g, "$1");
  return out;
}

// GH-1516: section-aware iteration. Returns the actions-bearing prose
// fragments paired with the canonical H2 heading they came from. For schema
// bodies the heading list comes from `INTAKE_BODY_FIELDS_META`; for legacy
// bodies (no `intakeType` or unmatched) we walk the H2 lines directly so
// prose under non-canonical headings like `## Approach` still feeds extraction
// but with a derived perspective.
type ActionsBearingSection = {
  heading: string;
  content: string;
  perspective: ActionPerspective;
};

const HEADING_LINE_RE = /^##\s+(.+?)\s*$/;

function walkLegacySections(body: string): ActionsBearingSection[] {
  const lines = body.split("\n");
  const sections: ActionsBearingSection[] = [];
  let currentHeading = "";
  let currentContent: string[] = [];
  const flush = () => {
    const content = currentContent.join("\n");
    if (content.trim().length === 0 && currentHeading === "") {
      return;
    }
    sections.push({
      heading: currentHeading,
      content,
      perspective: derivePerspective(currentHeading),
    });
  };
  for (const line of lines) {
    const m = line.match(HEADING_LINE_RE);
    if (m) {
      flush();
      currentHeading = m[1]!;
      currentContent = [];
      continue;
    }
    currentContent.push(line);
  }
  flush();
  if (sections.length === 0) {
    return [{ heading: "", content: body, perspective: "unknown" }];
  }
  return sections;
}

function walkActionsBearingSections(
  body: string,
  intakeType: IntakeBodySchemaType | undefined,
): ActionsBearingSection[] {
  if (!intakeType || !INTAKE_BODY_FIELDS_META[intakeType]) {
    return walkLegacySections(body);
  }
  const meta = INTAKE_BODY_FIELDS_META[intakeType];
  const { fields } = parseStructuredBody(body, intakeType);
  const out: ActionsBearingSection[] = [];
  for (const [name, content] of Object.entries(fields)) {
    if (content === undefined) continue;
    if (meta[name]?.actionsBearing !== true) continue;
    const heading = meta[name]?.heading ?? "";
    out.push({
      heading,
      content,
      perspective: derivePerspective(heading),
    });
  }
  return out;
}

// GH-1516: tokenize backward from a path occurrence to find the nearest
// governing verb. The "fragment" is the slice from the most recent sentence
// boundary (`.` / `!` / `?` / `\n\n` / list-item bullet) up to the path.
function findFragmentStart(text: string, pos: number): number {
  for (let i = pos - 1; i >= 0; i--) {
    const ch = text[i] ?? "";
    if (ch === "." || ch === "!" || ch === "?") return i + 1;
    if (ch === "\n" && i > 0 && text[i - 1] === "\n") return i + 1;
    if (ch === "\n") {
      const next = text[i + 1] ?? "";
      const next2 = text[i + 2] ?? "";
      if ((next === "-" || next === "*") && next2 === " ") return i + 1;
      if (/\d/.test(next) && (text[i + 2] === "." || text[i + 2] === ")")) {
        return i + 1;
      }
    }
  }
  return 0;
}

function classifyPathContext(
  text: string,
  pathStart: number,
): { context: DeliverableContext; governingVerb?: string } {
  // Immediate paren wrap → cited reference. FILE_PATH_RE's negated class
  // already drops the closing `)`, so the path body never includes the paren.
  const charBefore = text[pathStart - 1] ?? "";
  if (charBefore === "(") {
    return { context: "reference" };
  }
  const fragmentStart = findFragmentStart(text, pathStart);
  const before = text.slice(fragmentStart, pathStart).toLowerCase();
  const tokens = before.split(/[^a-z-]+/).filter((t) => t.length > 0);
  // Scan from end backwards, max 10 tokens. Empirically the governing verb
  // is within the previous handful of words; widening past ~10 starts to
  // pull verbs from earlier sentences that the fragment splitter missed.
  const window = tokens.slice(Math.max(0, tokens.length - 10));
  for (let i = window.length - 1; i >= 0; i--) {
    const tok = window[i]!;
    if (CREATE_VERBS.has(tok)) return { context: "create", governingVerb: tok };
    if (MODIFY_VERBS.has(tok)) return { context: "modify", governingVerb: tok };
    if (REFERENCE_VERBS.has(tok)) return { context: "reference", governingVerb: tok };
  }
  return { context: "unknown" };
}

export type ExtractDeliverablesInput = {
  body: string;
  // The issue itself — used to interpret bare `close`/`update body` mentions
  // as referring to the planning issue when no explicit ref is attached.
  selfIssue?: number | undefined;
  // GH-1359: when supplied, restrict deliverable extraction to the bodies of
  // schema fields whose `actionsBearing` flag is true. Sections describing the
  // current broken path (Repro / Expected / Actual / Environment / Notes) do
  // not feed the extractor and therefore cannot generate false-positive
  // findings.
  intakeType?: IntakeBodySchemaType | undefined;
};

export function extractDeliverables(input: ExtractDeliverablesInput): DeliverableTarget[] {
  const sections = walkActionsBearingSections(input.body, input.intakeType);
  const out: DeliverableTarget[] = [];
  const seen = new Set<string>();

  const push = (target: DeliverableTarget) => {
    const key = `${target.shape}:${
      target.shape === "file" ? target.path : target.shape === "pr-merge" ? target.pr : target.issue
    }`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(target);
  };

  for (const section of sections) {
    const stripped = stripCodeBlocks(section.content);

    for (const m of stripped.matchAll(FILE_PATH_RE)) {
      const path = m[1]!;
      const start = m.index ?? 0;
      const { context, governingVerb } = classifyPathContext(stripped, start);
      const mention: FileDeliverableMention = {
        shape: "file",
        path,
        context,
      };
      if (governingVerb) mention.governingVerb = governingVerb;
      if (section.heading) mention.section = section.heading;
      push(FileDeliverableMention.parse(mention));
    }

    for (const m of stripped.matchAll(COMMENT_RE)) {
      push({ shape: "issue-comment", issue: Number(m[1]) });
    }

    for (const m of stripped.matchAll(BODY_RE)) {
      push({ shape: "issue-body", issue: Number(m[1]) });
    }

    for (const m of stripped.matchAll(CLOSE_RE)) {
      push({ shape: "issue-state", issue: Number(m[1]), targetState: "closed" });
    }

    for (const m of stripped.matchAll(MERGE_PR_RE)) {
      push({ shape: "pr-merge", pr: Number(m[1]) });
    }
  }

  return out;
}

export function extractBlockers(body: string): BlockerRef[] {
  const stripped = stripCodeBlocks(body);
  const out: BlockerRef[] = [];
  const seen = new Set<number>();
  for (const m of stripped.matchAll(BLOCKER_RE)) {
    const issue = Number(m[1]);
    if (seen.has(issue)) continue;
    seen.add(issue);
    out.push({ issue, source: "issue-body" });
  }
  return out;
}

export function extractPlannedActions(
  body: string,
  intakeType?: IntakeBodySchemaType,
): PlannedAction[] {
  const sections = walkActionsBearingSections(body, intakeType);
  const out: PlannedAction[] = [];
  const seen = new Set<string>();
  const push = (action: PlannedAction) => {
    const key =
      action.shape === "git" || action.shape === "bd"
        ? `${action.shape}:${action.subcommand}`
        : action.shape === "gh-issue" || action.shape === "gh-pr"
          ? `${action.shape}:${action.subcommand}`
          : `${action.shape}:${action.target ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(PlannedActionMention.parse(action));
  };

  // GH-1832: filter matches against the per-tool vocabulary so noun-as-verb
  // prose ("bd records", "gh issues", "git commits") doesn't surface as a
  // planned action. Under-extraction is the right failure mode here (per the
  // file header); a real subcommand that no role's allowlist mentions cannot
  // be carried out anyway.
  //
  // GH-1516: layered ABOVE the vocab filter, drop STOP_VERB_TOKENS first —
  // "bd as" (in "names bd as canonical") never reaches isKnownSubcommand.

  // Attach `section` only when it has a value so Zod-parsed outputs don't
  // carry an explicit `section: undefined` key (would defeat `toContainEqual`
  // exact-match assertions in existing test fixtures).
  const withSection = <T extends PlannedAction>(action: T, heading: string): T =>
    heading ? ({ ...action, section: heading } as T) : action;

  for (const section of sections) {
    const stripped = stripCodeBlocks(section.content);
    const perspective = section.perspective;
    const heading = section.heading;

    for (const m of stripped.matchAll(ACTION_GIT_RE)) {
      const sub = m[1]!.toLowerCase();
      if (STOP_VERB_TOKENS.has(sub)) continue;
      if (!isKnownSubcommand("git", sub)) continue;
      push(withSection({ shape: "git", subcommand: sub, perspective }, heading));
    }

    for (const m of stripped.matchAll(ACTION_GH_RE)) {
      const group = m[1]!.toLowerCase();
      const sub = m[2]!.toLowerCase();
      if (STOP_VERB_TOKENS.has(sub)) continue;
      if (!isKnownSubcommand("gh", sub)) continue;
      const ghAction: PlannedAction =
        group === "pr"
          ? { shape: "gh-pr", subcommand: sub, perspective }
          : { shape: "gh-issue", subcommand: sub, perspective };
      push(withSection(ghAction, heading));
    }

    for (const m of stripped.matchAll(ACTION_BD_RE)) {
      const sub = m[1]!.toLowerCase();
      if (STOP_VERB_TOKENS.has(sub)) continue;
      if (!isKnownSubcommand("bd", sub)) continue;
      push(withSection({ shape: "bd", subcommand: sub, perspective }, heading));
    }

    for (const m of stripped.matchAll(ACTION_EDIT_RE)) {
      const editAction: PlannedAction =
        m[1] === "Edit"
          ? { shape: "edit", target: m[2], perspective }
          : { shape: "write", target: m[2], perspective };
      push(withSection(editAction, heading));
    }
  }

  return out;
}

// Composite — extract once, return all three shapes. The preflight runner
// uses this so a single body scan feeds every axis.
export type ExtractAllResult = {
  deliverables: DeliverableTarget[];
  blockers: BlockerRef[];
  actions: PlannedAction[];
};

export function extractAll(
  body: string,
  selfIssue?: number,
  intakeType?: IntakeBodySchemaType,
): ExtractAllResult {
  return {
    deliverables: extractDeliverables({ body, selfIssue, intakeType }),
    blockers: extractBlockers(body),
    actions: extractPlannedActions(body, intakeType),
  };
}

// GH-1516: exported for tests. Pinning the deny-list at module boundary so
// `test/tools/policy.test.ts` can assert no `POLICY_TABLE` entry leaks an
// English preposition that would defeat the layered defense.
export { STOP_VERB_TOKENS };
