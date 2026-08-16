/**
 * `prx submit body-template` (GH-1318, Option A — pre-merge prevention).
 *
 * Pure function: takes a list of `--closes <id>` args (each accepts GH-N,
 * #N, bare N, GitHub URL, or any registered adapter's canonical surface id),
 * resolves them through `resolveIssueId` + the adapter registry, and emits
 * markdown ready to paste into `gh pr create --body-file`.
 *
 * GH-numbered ids emit `Closes #N` (GitHub's auto-close keys off
 * `closes`/`fixes`/`resolves` + `#<gh-number>`). bd and notion ids emit
 * `Refs <id>` (a non-keyword cross-reference). Closes lines render before
 * Refs lines; within each block input order is preserved with per-kind
 * dedupe. The `bd close` projection on merge is owned by `prx submit
 * postmerge` (GH-1773), which sweeps `Refs <bd-id>` lines from merged PR
 * bodies — see docs/architecture/bd-canonical-pr-linkage.md.
 */

import { z } from "zod";

import { resolveIssueId, IssueResolveError } from "../issues/resolver.ts";

export const bodyTemplateOptionsSchema = z.object({
  closes: z.array(z.string().trim().min(1)).default([]),
  repo: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type BodyTemplateOptions = z.infer<typeof bodyTemplateOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type BodyTemplateRender = {
  closesLines: string[];
  refsLines: string[];
  numbers: number[];
  refs: string[];
  prefix?: string;
  suffix?: string;
};

export class BodyTemplateError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "BodyTemplateError";
    this.exitCode = exitCode;
  }
}

type ResolvedClose =
  | { kind: "gh"; number: number }
  | { kind: "bd"; id: string }
  | { kind: "notion"; refValue: string };

function resolveOneClosesArg(raw: string): ResolvedClose {
  let resolved;
  try {
    resolved = resolveIssueId(raw, "prx submit body-template");
  } catch (err) {
    if (err instanceof IssueResolveError) {
      throw new BodyTemplateError(err.message, err.exitCode);
    }
    throw err;
  }
  if (resolved.kind === "gh") {
    return { kind: "gh", number: resolved.number };
  }
  if (resolved.kind === "bd") {
    return { kind: "bd", id: resolved.id };
  }
  return { kind: "notion", refValue: resolved.id.value };
}

export function renderBodyTemplate(opts: BodyTemplateOptions): BodyTemplateRender {
  const seenGh = new Set<number>();
  const numbers: number[] = [];
  const closesLines: string[] = [];
  const seenRef = new Set<string>();
  const refs: string[] = [];
  const refsLines: string[] = [];
  for (const raw of opts.closes) {
    const resolved = resolveOneClosesArg(raw);
    if (resolved.kind === "gh") {
      if (seenGh.has(resolved.number)) continue;
      seenGh.add(resolved.number);
      numbers.push(resolved.number);
      closesLines.push(`Closes #${resolved.number}`);
      continue;
    }
    const refValue = resolved.kind === "bd" ? resolved.id : resolved.refValue;
    if (seenRef.has(refValue)) continue;
    seenRef.add(refValue);
    refs.push(refValue);
    refsLines.push(`Refs ${refValue}`);
  }
  const render: BodyTemplateRender = { closesLines, refsLines, numbers, refs };
  if (opts.prefix !== undefined) render.prefix = opts.prefix;
  if (opts.suffix !== undefined) render.suffix = opts.suffix;
  return render;
}

export function formatBodyTemplateRender(
  render: BodyTemplateRender,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  const parts: string[] = [];
  if (render.prefix !== undefined && render.prefix.length > 0) {
    parts.push(render.prefix);
  }
  if (render.closesLines.length > 0) {
    parts.push(render.closesLines.join("\n"));
  }
  if (render.refsLines.length > 0) {
    parts.push(render.refsLines.join("\n"));
  }
  if (render.suffix !== undefined && render.suffix.length > 0) {
    parts.push(render.suffix);
  }
  return parts.join("\n\n");
}

export function runBodyTemplate(opts: BodyTemplateOptions, output: Output): number {
  if (opts.closes.length === 0) {
    output.error("prx submit body-template: at least one --closes <id> is required");
    return 1;
  }
  let render: BodyTemplateRender;
  try {
    render = renderBodyTemplate(opts);
  } catch (err) {
    if (err instanceof BodyTemplateError) {
      output.error(err.message);
      return err.exitCode;
    }
    throw err;
  }
  output.log(formatBodyTemplateRender(render, opts.format));
  return 0;
}
