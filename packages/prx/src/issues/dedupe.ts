/**
 * Shared GH⇄bd dedupe primitives. Originally lived in `src/triage/promote.ts`
 * (`buildBeadsLookup`, `lookupBead`) and `src/triage/triage.ts`
 * (`extractIssueNumber`); promoted to `src/issues/` so plan-side search can
 * collapse cross-source duplicates without forking a third copy.
 */

import type { BeadsRecord } from "../triage/triage.ts";

const ISSUE_REF_RE = /\/issues\/(\d+)(?:[/?#].*)?$/;

export function extractIssueNumber(externalRef: string | null | undefined): number | null {
  if (!externalRef) return null;
  const match = externalRef.match(ISSUE_REF_RE);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

export type BeadsLookup = {
  byUrl: Map<string, BeadsRecord>;
  byIssueNumber: Map<number, BeadsRecord>;
  /**
   * Multi-domain index: `domain → (externalId-lowercased → record)`. Populated
   * from `record.externalRefs` (GH-1538), the post-amendment shape that
   * supersedes the GH-only single-pin `external_ref` slot. The legacy `byUrl`
   * / `byIssueNumber` indexes stay populated for the existing GH-only
   * callsites; new callers (resolveUoW, resolveFromBeads) dispatch through
   * this map instead.
   */
  byDomainExternalId: Map<string, Map<string, BeadsRecord>>;
};

export function buildBeadsLookup(records: BeadsRecord[]): BeadsLookup {
  const byUrl = new Map<string, BeadsRecord>();
  const byIssueNumber = new Map<number, BeadsRecord>();
  const byDomainExternalId = new Map<string, Map<string, BeadsRecord>>();
  for (const record of records) {
    if (record.externalRef) byUrl.set(record.externalRef.toLowerCase(), record);
    if (record.externalIssueNumber !== null) {
      byIssueNumber.set(record.externalIssueNumber, record);
    }
    for (const [domain, externalId] of Object.entries(record.externalRefs)) {
      if (typeof externalId !== "string" || externalId.length === 0) continue;
      let perDomain = byDomainExternalId.get(domain);
      if (!perDomain) {
        perDomain = new Map<string, BeadsRecord>();
        byDomainExternalId.set(domain, perDomain);
      }
      perDomain.set(externalId.toLowerCase(), record);
    }
  }
  return { byUrl, byIssueNumber, byDomainExternalId };
}

export function lookupBead(
  hit: { number: number; url?: string | undefined },
  lookup: BeadsLookup,
): BeadsRecord | null {
  if (hit.url) {
    const direct = lookup.byUrl.get(hit.url.toLowerCase());
    if (direct) return direct;
  }
  return lookup.byIssueNumber.get(hit.number) ?? null;
}
