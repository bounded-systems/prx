// `prx help-all` sitemap renderer (GH-976).
//
// Pure projection over the registry: re-cluster commands under four domains
// (help-surface.md §7), surface deprecations in a dedicated section (§8), hide
// `internal: true` entries.

import type { CommandDomain, CommandSpec } from "../../cli/registry.ts";
import { DeprecationSection, DomainSection, FooterPointers, Identity } from "./components.ts";

const DOMAIN_ORDER: ReadonlyArray<readonly [CommandDomain, string]> = [
  ["state", "State"],
  ["work-units", "Work units"],
  ["repo-plumbing", "Repo plumbing"],
  ["system", "System"],
];

export function HelpAll(registry: CommandSpec[]): string {
  const visible = registry.filter((c) => !c.internal && !c.deprecation);

  const sections = DOMAIN_ORDER.map(([domain, label]) => {
    const specs = visible.filter((c) => c.domain === domain);
    return DomainSection(label, specs);
  });

  const deprecated = registry.filter((c) => c.deprecation);

  return [
    Identity("prx — full command catalog"),
    ...sections,
    DeprecationSection(deprecated),
    FooterPointers("help-all"),
  ].join("\n\n");
}
