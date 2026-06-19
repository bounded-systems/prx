// Help-surface component projections (GH-976).
//
// Each function takes data, returns a string. No I/O, no module state. The two
// renderers (`HelpOverview`, `HelpAll`) compose these.
//
// IA decisions of record (`docs/prx/help-surface.md`):
//   §6.1   identity at top of overview
//   §6.3   command + one-line description, no flag dumps in either surface
//   §7     four domain clusters in help-all
//   §8     deprecation aliases in a dedicated help-all section

import type { CommandSpec, SessionContext, SessionRole } from "../../cli/registry.ts";

const INDENT = "  ";
const COL_GAP = "  ";

function formatRow(name: string, description: string, nameWidth: number): string {
  const padded = `prx ${name}`.padEnd(nameWidth);
  return `${INDENT}${padded}${COL_GAP}${description}`;
}

function nameWidthFor(specs: CommandSpec[]): number {
  let max = 0;
  for (const s of specs) {
    const len = `prx ${s.name}`.length;
    if (len > max) max = len;
  }
  return max;
}

export function Identity(subtitle?: string): string {
  if (subtitle) {
    return [subtitle, "=".repeat(subtitle.length)].join("\n");
  }
  return ["prx", "=========="].join("\n");
}

export function SessionContextLine(_ctx: SessionContext): string {
  // §6.1: identity sits at the top of the overview. Today the line is
  // ctx-agnostic — it states the canonical shape of work-unit IDs. When future
  // contexts need different identity copy, we branch on `_ctx` here.
  return "Work-unit identity: GH-NNN (for example GH-456). GitHub issue identity is canonical.";
}

export function PromotedList(specs: CommandSpec[]): string {
  if (specs.length === 0) return `${INDENT}(no promoted commands)`;
  const width = nameWidthFor(specs);
  return specs.map((s) => formatRow(s.name, s.description, width)).join("\n");
}

export function DomainSection(label: string, specs: CommandSpec[]): string {
  const header = `${label}:`;
  if (specs.length === 0) {
    return [header, `${INDENT}(none)`].join("\n");
  }
  const width = nameWidthFor(specs);
  const rows = specs.map((s) => formatRow(s.name, s.description, width));
  return [header, ...rows].join("\n");
}

// GH-1311: actor-scoped help (`prx plan --help`) groups its children by
// `session_role` so the lifecycle / toolset / preflight cleavage is visible
// instead of a flat verb dump. Section order is fixed:
//   1. Lifecycle  — boots/closes the session pane
//   2. Toolset    — called from inside an open session
//   3. Preflight  — introspection / validation hybrids
// Specs without a session_role are listed under a trailing "Other" bucket
// so the renderer stays robust if a future actor namespace adopts the
// component before tagging all of its children.
const SESSION_ROLE_ORDER: ReadonlyArray<{ role: SessionRole; label: string }> = [
  { role: "lifecycle", label: "Lifecycle" },
  { role: "toolset", label: "Toolset" },
  { role: "preflight", label: "Preflight" },
];

export function ActorSection(label: string, specs: CommandSpec[]): string {
  const header = `${label}:`;
  if (specs.length === 0) {
    return [header, `${INDENT}(none)`].join("\n");
  }
  // Compute width across the whole spec set so subsection rows stay aligned.
  const width = nameWidthFor(specs);
  const sections: string[] = [];
  const seen = new Set<CommandSpec>();
  for (const { role, label: subHeader } of SESSION_ROLE_ORDER) {
    const bucket = specs.filter((s) => s.session_role === role);
    if (bucket.length === 0) continue;
    for (const s of bucket) seen.add(s);
    sections.push(`${INDENT}${subHeader}:`);
    for (const s of bucket) {
      sections.push(`${INDENT}${formatRow(s.name, s.description, width)}`);
    }
    sections.push("");
  }
  const remainder = specs.filter((s) => !seen.has(s));
  if (remainder.length > 0) {
    sections.push(`${INDENT}Other:`);
    for (const s of remainder) {
      sections.push(`${INDENT}${formatRow(s.name, s.description, width)}`);
    }
    sections.push("");
  }
  while (sections.length > 0 && sections[sections.length - 1] === "") {
    sections.pop();
  }
  return [header, ...sections].join("\n");
}

export function DeprecationSection(specs: CommandSpec[]): string {
  const header = "Deprecated spellings:";
  if (specs.length === 0) {
    return [header, `${INDENT}(none)`].join("\n");
  }
  const rows = specs.map((s) => {
    const dep = s.deprecation!;
    return `${INDENT}prx ${s.name} — alias for \`prx ${dep.alias_for}\`; removal: ${dep.removal_target}`;
  });
  return [header, ...rows].join("\n");
}

export type FooterKind = "overview" | "help-all";

export function FooterPointers(kind: FooterKind): string {
  if (kind === "overview") {
    return [
      "Pointers:",
      `${INDENT}prx help-all              Full command sitemap, grouped by domain`,
      `${INDENT}prx <cmd> --help          Flags and full semantics for one command`,
    ].join("\n");
  }
  return [
    "Common flow:",
    `${INDENT}prx contract init`,
    `${INDENT}prx plan session GH-<n>`,
    `${INDENT}prx chain status --remote && prx session next`,
    `${INDENT}prx contract update --apply`,
    "",
    "Work-unit identity:",
    `${INDENT}Canonical IDs use GH-NNN format (for example GH-456).`,
    `${INDENT}GitHub issue identity is canonical; ticket/unit/worktree/PR projections share it.`,
    "",
    "Interactive:",
    `${INDENT}prx tui`,
  ].join("\n");
}
