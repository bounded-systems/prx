/**
 * pin-check — the forcing function behind "every *direct* dependency is pinned
 * exactly" (GH-1039).
 *
 * Why: a caret range makes a version change something a *resolver* does, not
 * something a *reviewer* approves. The manifest never records which version we
 * require, so a re-resolution can move it and a security bump can land — or
 * silently un-land — with no diff naming it. This module makes that mechanical:
 * the declared spec must be an exact version, and the lockfile's `sha512`
 * integrity entry is the content pin beneath it.
 *
 * Scope (deliberate, and narrower than "no ranges anywhere"):
 *   - CHECKED:     dependencies, devDependencies, optionalDependencies
 *   - NOT CHECKED: peerDependencies — a peer range is a *compatibility
 *                  statement to consumers*, not a resolution input. Pinning one
 *                  breaks every consumer that legitimately sits elsewhere in the
 *                  range; that is a different decision (GH-1039 says so).
 *   - NOT CHECKED: overrides / resolutions — those pin *transitive* deps, and
 *                  transitives stay where they are unless there is a specific
 *                  reason (GH-1038 pins hono / fast-uri there). A gate that
 *                  policed `overrides` would fight the very mechanism used to
 *                  pin a transitive.
 *
 * The ratchet (docs/agentic-code-hygiene.md rule 3) is a *shrinking* allowlist:
 * an entry is how a float that genuinely cannot be pinned today survives, and
 * every entry carries a written reason. It can only shrink, because a stale
 * entry — one whose dependency is now pinned, or gone — is itself a failure.
 * So the list drains and can never quietly become the place floats go to live.
 */

/** Manifest fields whose specs are resolution inputs, and so must be pinned. */
export const CHECKED_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export type CheckedField = (typeof CHECKED_FIELDS)[number];

/**
 * Spec prefixes that are not registry ranges at all. A `workspace:*` is a link
 * to a sibling in this repo (its version is whatever that package.json says —
 * pinning it would just duplicate a fact and break on every version bump);
 * `file:`/`link:`/`portal:` are paths; `catalog:` defers to a central catalog
 * that is itself pinned.
 */
const EXEMPT_PROTOCOLS = ["workspace:", "file:", "link:", "portal:", "catalog:"] as const;

/** A full 40-hex commit SHA — the only git ref that names immutable content. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Exact semver: `1.2.3`, `1.2.3-rc.1`, `1.2.3+build`. No operators, no wildcards. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const GIT_PREFIXES = ["git+", "git:", "github:", "gitlab:", "bitbucket:"] as const;

export type Verdict =
  | { kind: "pinned" }
  | { kind: "exempt"; why: string }
  | { kind: "floating"; why: string };

/**
 * Unwrap an aliased spec (`npm:@jsr/scope__name@^0.3.0`) down to the range.
 *
 * The whole JSR surface in this repo is declared this way, so getting the split
 * wrong would silently exempt ~25 direct deps. Split on the LAST `@` so a scoped
 * package name (which itself starts with `@`) is not mistaken for the separator.
 */
export function unwrapAlias(spec: string): string {
  if (!spec.startsWith("npm:")) return spec;
  const rest = spec.slice("npm:".length);
  const at = rest.lastIndexOf("@");
  // `npm:some-pkg` with no `@` means "latest" — a float, not an exemption.
  if (at <= 0) return "";
  return rest.slice(at + 1);
}

/** Classify a single declared spec. */
export function classifySpec(spec: string): Verdict {
  const raw = spec.trim();

  for (const proto of EXEMPT_PROTOCOLS) {
    if (raw.startsWith(proto)) {
      return { kind: "exempt", why: `\`${proto}\` is a local link, not a registry range` };
    }
  }

  const isGit =
    GIT_PREFIXES.some((p) => raw.startsWith(p)) || (raw.includes("://") && raw.includes(".git"));
  if (isGit) {
    const hash = raw.lastIndexOf("#");
    if (hash === -1) {
      return {
        kind: "floating",
        why: "git dependency with no ref — resolves to the default branch",
      };
    }
    const ref = raw.slice(hash + 1).replace(/^commit=/, "");
    if (COMMIT_SHA.test(ref)) return { kind: "pinned" };
    return {
      kind: "floating",
      why: `git ref \`${ref}\` is a branch/tag, not a 40-hex commit SHA — it can move`,
    };
  }

  const range = unwrapAlias(raw);

  if (range === "") return { kind: "floating", why: "no version given — resolves to `latest`" };
  if (EXACT_VERSION.test(range)) return { kind: "pinned" };

  return { kind: "floating", why: `\`${range}\` is a range, not an exact version` };
}

export type Manifest = {
  /** Repo-relative path, e.g. `packages/prx/package.json`. */
  path: string;
  json: Record<string, unknown>;
};

export type Violation = {
  manifest: string;
  field: CheckedField;
  name: string;
  spec: string;
  why: string;
};

export type AllowlistEntry = {
  manifest: string;
  field: string;
  name: string;
  reason?: string;
};

export type Allowlist = { entries: AllowlistEntry[] };

/**
 * What the lockfile actually resolved each direct dep to, keyed by
 * `keyOf(manifest, field, name)`. Built by the caller (the lockfile lives on
 * disk; this module stays pure).
 */
export type ResolvedVersions = Map<string, string>;

export type LockDrift = {
  manifest: string;
  field: CheckedField;
  name: string;
  declared: string;
  resolved: string;
};

export type PinReport = {
  /** Floats with no allowlist entry — these fail the gate. */
  violations: Violation[];
  /** Floats covered by an allowlist entry — reported so the backlog stays visible. */
  allowed: (Violation & { reason: string })[];
  /** Allowlist entries that no longer describe a float — they must be deleted. */
  stale: (AllowlistEntry & { why: string })[];
  /** Allowlist entries missing a written reason. */
  unexplained: AllowlistEntry[];
  /** Deps pinned to a version the lockfile does not actually resolve. */
  lockDrift: LockDrift[];
  /** Total direct specs examined, for the "what did this actually look at" line. */
  examined: number;
};

const keyOf = (manifest: string, field: string, name: string) =>
  JSON.stringify([manifest, field, name]);

/**
 * Run the check over already-parsed manifests. Pure — no fs, no network — so
 * the gate can be driven against fixture trees (including a deliberately
 * floated one, which is what proves it actually fails).
 */
export function checkPins(
  manifests: Manifest[],
  allowlist: Allowlist = { entries: [] },
  resolved: ResolvedVersions = new Map(),
): PinReport {
  const floats = new Map<string, Violation>();
  const lockDrift: LockDrift[] = [];
  let examined = 0;

  for (const m of manifests) {
    for (const field of CHECKED_FIELDS) {
      const block = m.json[field];
      if (!block || typeof block !== "object") continue;
      for (const [name, rawSpec] of Object.entries(block as Record<string, unknown>)) {
        const spec = typeof rawSpec === "string" ? rawSpec : String(rawSpec);
        examined += 1;
        const key = keyOf(m.path, field, name);
        const verdict = classifySpec(spec);
        if (verdict.kind === "floating") {
          floats.set(key, { manifest: m.path, field, name, spec, why: verdict.why });
          continue;
        }
        // An exact spec the lockfile does not resolve is the same defect this
        // gate exists to stop, wearing a pin: the manifest does not record what
        // the tree installs.
        //
        // Honest scope: `bun install --frozen-lockfile` also rejects both cases
        // this was tested against, so this is defence in depth rather than a
        // hole only we can see. It earns its place by being a pure file read —
        // no install, no network — and by naming the two versions instead of
        // "lockfile had changes", which is what rule 2 asks a gate to do.
        // (The *range* drift GH-1040 describes on `main` is invisible to
        // --frozen-lockfile, but ranges are floats here and fail earlier.)
        const actual = resolved.get(key);
        if (verdict.kind === "pinned" && actual !== undefined) {
          const declared = unwrapAlias(spec.trim());
          if (declared !== actual) {
            lockDrift.push({ manifest: m.path, field, name, declared, resolved: actual });
          }
        }
      }
    }
  }

  const violations: Violation[] = [];
  const allowed: (Violation & { reason: string })[] = [];
  const stale: (AllowlistEntry & { why: string })[] = [];
  const unexplained: AllowlistEntry[] = [];

  const seen = new Set<string>();
  for (const entry of allowlist.entries) {
    const k = keyOf(entry.manifest, entry.field, entry.name);
    const float = floats.get(k);
    if (!float) {
      stale.push({
        ...entry,
        why: "no longer floating (pinned, removed, or renamed) — delete this entry",
      });
      continue;
    }
    if (!entry.reason || entry.reason.trim() === "") {
      unexplained.push(entry);
      continue;
    }
    seen.add(k);
    allowed.push({ ...float, reason: entry.reason });
  }

  for (const [k, float] of floats) {
    if (!seen.has(k)) violations.push(float);
  }

  const order = (a: Violation, b: Violation) =>
    a.manifest.localeCompare(b.manifest) ||
    a.field.localeCompare(b.field) ||
    a.name.localeCompare(b.name);
  violations.sort(order);
  allowed.sort(order);

  lockDrift.sort((a, b) => a.manifest.localeCompare(b.manifest) || a.name.localeCompare(b.name));

  return { violations, allowed, stale, unexplained, lockDrift, examined };
}

/** True when the report should fail CI. */
export function isFailing(report: PinReport): boolean {
  return (
    report.violations.length > 0 ||
    report.stale.length > 0 ||
    report.unexplained.length > 0 ||
    report.lockDrift.length > 0
  );
}

/**
 * Render the report. Per rule 2 the failure message must *teach the fix* — an
 * agent reading this should know exactly what to type, without opening the doc.
 */
export function renderReport(report: PinReport): string {
  const lines: string[] = [];

  if (report.violations.length > 0) {
    lines.push(`✗ ${report.violations.length} direct dependency/-ies carry a floating range:`);
    lines.push("");
    for (const v of report.violations) {
      lines.push(`  ${v.manifest}  ${v.field}.${v.name}`);
      lines.push(`      declared: ${v.spec}`);
      lines.push(`      problem:  ${v.why}`);
    }
    lines.push("");
    lines.push("  Fix — replace the range with the version the lockfile already resolved:");
    lines.push("      bun pm ls            # or read the `packages` block of bun.lock");
    lines.push(
      "      # edit package.json so the spec is the exact version, e.g. ^8.20.0 -> 8.20.0",
    );
    lines.push("      # for a JSR alias keep the alias: npm:@jsr/scope__name@0.2.2");
    lines.push("      bun install          # refresh bun.lock's manifest mirror");
    lines.push("");
    lines.push("  If it genuinely cannot be pinned, add it to the allowlist WITH a reason:");
    lines.push("      .dep-pins-allowlist.json");
  }

  if (report.unexplained.length > 0) {
    lines.push(`✗ ${report.unexplained.length} allowlist entry/-ies have no written reason:`);
    for (const e of report.unexplained) {
      lines.push(`  ${e.manifest}  ${e.field}.${e.name}`);
    }
    lines.push("  Every allowlist entry must say why the dep cannot be pinned today.");
  }

  if (report.stale.length > 0) {
    lines.push(`✗ ${report.stale.length} allowlist entry/-ies are stale:`);
    for (const e of report.stale) {
      lines.push(`  ${e.manifest}  ${e.field}.${e.name} — ${e.why}`);
    }
    lines.push("  The allowlist only shrinks: remove entries once the dep is pinned or gone.");
  }

  if (report.lockDrift.length > 0) {
    lines.push(
      `✗ ${report.lockDrift.length} dep(s) pinned to a version the lockfile does not resolve:`,
    );
    lines.push("");
    for (const d of report.lockDrift) {
      lines.push(`  ${d.manifest}  ${d.field}.${d.name}`);
      lines.push(`      package.json declares: ${d.declared}`);
      lines.push(`      bun.lock resolves:     ${d.resolved}`);
    }
    lines.push("");
    lines.push("  The manifest is pinned but does not record what the tree installs.");
    lines.push("  `bun install --frozen-lockfile` normally also rejects this; this check runs");
    lines.push("  without a network install and names the two versions outright.");
    lines.push("");
    lines.push("  Fix — pick the one you mean, then re-run:");
    lines.push("      bun install     # keep the declared version, move the lock to match");
    lines.push("      # …or edit package.json to the resolved version if the lock is right");
  }

  if (report.allowed.length > 0) {
    lines.push(`▸ ${report.allowed.length} allowlisted float(s) still draining:`);
    for (const a of report.allowed) {
      lines.push(`  ${a.manifest}  ${a.field}.${a.name} (${a.spec}) — ${a.reason}`);
    }
  }

  if (!isFailing(report)) {
    lines.push(
      `✓ all ${report.examined} direct dependency specs are pinned exactly` +
        (report.allowed.length > 0 ? ` (${report.allowed.length} allowlisted)` : ""),
    );
    lines.push("  (peerDependencies and overrides are out of scope by design — see pin-check.ts)");
  }

  return lines.join("\n");
}
