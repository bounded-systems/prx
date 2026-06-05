/**
 * SPIKE — namespaced router for the spec-driven CLI.
 *
 * Real prx verb ids are multi-token: `plan session`, `intake spike`,
 * `triage classify`. `dispatch` in verbspec.ts only resolves single-token ids;
 * this resolves the **longest matching verb id** as a token prefix of argv, and
 * surfaces namespaces (`prx plan` with no subcommand → list its children) so
 * the whole registry is reachable from one router.
 *
 * Resolution rule: an exact verb id wins over a namespace at the same prefix
 * (`plan` the verb beats `plan` the namespace); a longer verb id wins over a
 * shorter one (`plan session` beats `plan`). Everything after the matched id is
 * the verb's argv.
 */

import { parseArgs, toHelp, type Registry, type VerbSpec } from "./verbspec.ts";

export type ResolveResult =
  | { kind: "verb"; verb: VerbSpec; rest: string[] }
  | { kind: "namespace"; path: string[]; children: string[] }
  | { kind: "unknown"; token: string };

/** Resolve argv to a verb, a namespace, or unknown. */
export function resolveVerb(reg: Registry, argv: readonly string[]): ResolveResult {
  const ids = Object.keys(reg);
  const tokens = [...argv];

  // 1. Longest exact verb-id prefix wins.
  let best: { verb: VerbSpec; n: number } | null = null;
  for (const id of ids) {
    const idTok = id.split(" ");
    if (idTok.length <= tokens.length && idTok.every((t, i) => t === tokens[i])) {
      if (!best || idTok.length > best.n) best = { verb: reg[id]!, n: idTok.length };
    }
  }
  if (best) return { kind: "verb", verb: best.verb, rest: tokens.slice(best.n) };

  // Empty argv → top-level listing (all first tokens).
  if (tokens.length === 0) {
    const children = [...new Set(ids.map((id) => id.split(" ")[0]!))].sort();
    return { kind: "namespace", path: [], children };
  }

  // 2. Otherwise the longest NON-EMPTY token prefix that names a namespace (an
  //    id with more tokens sharing this prefix) — list its distinct next tokens.
  for (let n = tokens.length; n >= 1; n--) {
    const prefix = tokens.slice(0, n);
    const matches = ids.filter((id) => {
      const idTok = id.split(" ");
      return idTok.length > n && prefix.every((t, i) => t === idTok[i]);
    });
    if (matches.length) {
      const children = [...new Set(matches.map((id) => id.split(" ")[n]!))].sort();
      return { kind: "namespace", path: prefix, children };
    }
  }

  // A leading token that matches no verb and no namespace prefix.
  return { kind: "unknown", token: tokens[0] ?? "" };
}

/** Render a namespace listing (the `prx plan` group help). */
export function renderNamespace(path: string[], children: string[]): string {
  const head = ["prx", ...path].join(" ");
  return [`${head} <subcommand>`, "", "Subcommands:", ...children.map((c) => `  ${c}`)].join("\n");
}

export type TreeDispatchResult =
  | { kind: "help"; text: string }
  | { kind: "namespace"; text: string }
  | { kind: "ok"; id: string; output: unknown };

/** The namespaced router — resolve (multi-token) → parse → run, or group help. */
export async function dispatchTree(reg: Registry, argv: readonly string[]): Promise<TreeDispatchResult> {
  const r = resolveVerb(reg, argv);
  if (r.kind === "unknown") throw new Error(`unknown verb: ${r.token || "(none)"}`);
  if (r.kind === "namespace") return { kind: "namespace", text: renderNamespace(r.path, r.children) };
  if (r.rest.includes("--help") || r.rest.includes("-h")) return { kind: "help", text: toHelp(r.verb) };
  const input = parseArgs(r.verb, r.rest);
  const output = await r.verb.run(input);
  return { kind: "ok", id: r.verb.id, output };
}
