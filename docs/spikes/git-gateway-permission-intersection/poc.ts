/**
 * Spike — the git-gateway permission INTERSECTION model (prx-0wsf round 5)
 * =============================================================================
 *
 * PR #969 shipped forge-d's `repos=`/`perms=` caveats: real, working scoping of
 * WHAT a signed grant may ask an already-authenticated caller to lease. This
 * spike proves out the next layer up — a full git HTTP gateway's authority is
 * never any ONE of these checks, it's the INTERSECTION of five independent
 * layers, each of which can only narrow, never widen:
 *
 *   gateway JWT capability
 *     ∩ gateway server policy           (an org-wide floor, e.g. "no force ever")
 *     ∩ GitHub App installation scope   (the ceiling forge-d's App actually has)
 *     ∩ minted installation-token scope (what forge-d actually asked GitHub for)
 *     ∩ GitHub repository rules         (rulesets — the FINAL authority)
 *
 * The canonical example from the design discussion:
 *   JWT:          write repository 67890
 *   GitHub token: contents:write for repository 67890
 *   ruleset:      cannot directly update main
 *   effective:    may push allowed feature refs, may not push main
 *
 * No layer can be skipped and no layer can widen what an earlier layer denied
 * — that's what makes this an OCAP-shaped model rather than "check the JWT and
 * trust the rest": a bug that widens the installation scope, or a caller that
 * requests a broader token than its JWT permits, is caught by a DIFFERENT
 * layer, not silently compounded.
 *
 * Deterministic + offline ($0): every layer here is a plain in-memory stub
 * (no real GitHub call, no real signing) — the point is the INTERSECTION
 * logic, not the transport. The `refs=<glob>,...` caveat prototyped here does
 * not exist on forge-d's wire contract yet (see docs/spikes/README note below)
 * — proving the model first, shipping it is the next slice.
 *
 * Run (bun on PATH):  bun docs/spikes/git-gateway-permission-intersection/poc.ts
 */

const log = (line: string) => console.log(line);

// ---------------------------------------------------------------------------
// 1. The five layers, each a plain data shape (no signing — pure model proof)
// ---------------------------------------------------------------------------

type GitOp = "read" | "write" | "archive";
type RefAction = "update" | "create" | "delete" | "force";
type ContentsLevel = "none" | "read" | "write";

/** Layer 1 — the gateway JWT: what the CALLER'S capability claims to permit. */
interface GatewayJwt {
  readonly ownerId: number;
  readonly repositoryId: number;
  readonly git: readonly GitOp[];
  /** Ref-pattern scoping for writes — glob patterns per action. */
  readonly refs?: {
    readonly update: readonly string[];
    readonly create: readonly string[];
    readonly delete: readonly string[];
    readonly force: readonly string[];
  };
}

/** Layer 2 — the gateway's own server-side policy: an org-wide FLOOR that no
 *  JWT, however permissive, can widen past (e.g. force-push is simply off). */
interface GatewayPolicy {
  readonly forceAllowed: boolean;
}

/** Layer 3 — the GitHub App installation's actual ceiling for this repo. */
interface InstallationScope {
  readonly contents: ContentsLevel;
}

/** Layer 4 — what forge-d actually minted (must be ⊆ installation ceiling,
 *  and ⊇ what this operation needs — both directions are checked). */
interface MintedTokenScope {
  readonly contents: ContentsLevel;
}

/** Layer 5 — GitHub repository rules (rulesets): the FINAL authority over
 *  specific refs, independent of what every other layer already agreed to. */
interface RepositoryRules {
  readonly protectedRefPatterns: readonly string[];
}

interface GitRequest {
  readonly op: GitOp;
  readonly ref: string;
  readonly action: RefAction;
}

type Verdict = { ok: true } | { ok: false; layer: string; reason: string };

// ---------------------------------------------------------------------------
// 2. Each layer owns its own value grammar — a simple trailing-`*` glob, the
//    same "comma-separated OR-set, verifier owns the grammar" convention
//    forge-d's `repos=`/`perms=` caveats already use (checkCaveats).
// ---------------------------------------------------------------------------

function globMatches(pattern: string, ref: string): boolean {
  if (!pattern.endsWith("*")) return pattern === ref;
  return ref.startsWith(pattern.slice(0, -1));
}

const CONTENTS_RANK: Record<ContentsLevel, number> = { none: 0, read: 1, write: 2 };
const neededContentsLevel = (op: GitOp): ContentsLevel => (op === "read" || op === "archive" ? "read" : "write");

// ---------------------------------------------------------------------------
// 3. The intersection — every layer runs in order; the FIRST denial wins and
//    is reported (mirrors guest-room's checkCaveats: conjunction, fail fast,
//    fail closed). No layer is ever consulted to WIDEN a prior layer's denial.
// ---------------------------------------------------------------------------

function effectiveAuthority(args: {
  request: GitRequest;
  jwt: GatewayJwt;
  policy: GatewayPolicy;
  installation: InstallationScope;
  mintedToken: MintedTokenScope;
  rules: RepositoryRules;
}): Verdict {
  const { request, jwt, policy, installation, mintedToken, rules } = args;

  // Layer 1: gateway JWT capability — reject before EVER contacting GitHub.
  if (!jwt.git.includes(request.op)) {
    return { ok: false, layer: "gateway JWT", reason: `JWT does not grant git:${request.op}` };
  }
  if (request.op === "write") {
    const patterns = jwt.refs?.[request.action] ?? [];
    if (!patterns.some((p) => globMatches(p, request.ref))) {
      return {
        ok: false,
        layer: "gateway JWT",
        reason: `JWT does not permit ${request.action} on ${request.ref}`,
      };
    }
  }

  // Layer 2: gateway server policy — an org-wide floor, independent of the JWT.
  if (request.action === "force" && !policy.forceAllowed) {
    return { ok: false, layer: "gateway policy", reason: "force pushes are disabled gateway-wide" };
  }

  // Layer 3: GitHub App installation scope — the ceiling forge-d's App holds.
  const needed = neededContentsLevel(request.op);
  if (CONTENTS_RANK[installation.contents] < CONTENTS_RANK[needed]) {
    return {
      ok: false,
      layer: "installation scope",
      reason: `installation holds contents:${installation.contents}, need contents:${needed}`,
    };
  }

  // Layer 4: the minted installation token — checked BOTH directions. Not
  // just "is it enough" (sufficiency) but "is it too much" (defense in depth:
  // a minting bug that hands back a broader token than the installation's own
  // ceiling, or broader than what was needed, is caught HERE, not silently
  // compounded by a later layer trusting it).
  if (CONTENTS_RANK[mintedToken.contents] < CONTENTS_RANK[needed]) {
    return {
      ok: false,
      layer: "minted token",
      reason: `minted token holds contents:${mintedToken.contents}, need contents:${needed}`,
    };
  }
  if (CONTENTS_RANK[mintedToken.contents] > CONTENTS_RANK[installation.contents]) {
    return {
      ok: false,
      layer: "minted token",
      reason: "minted token exceeds the installation's own ceiling — minting bug, fail closed",
    };
  }

  // Layer 5: GitHub repository rules — the FINAL authority. Every layer above
  // already agreed; a ruleset can still deny (never widen past a prior denial).
  if (request.op === "write" && rules.protectedRefPatterns.some((p) => globMatches(p, request.ref))) {
    return {
      ok: false,
      layer: "repository rules",
      reason: `ruleset protects ${request.ref} — direct push not allowed`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. Demo — the canonical example plus each layer's independent denial.
// ---------------------------------------------------------------------------

function main() {
  const jwt: GatewayJwt = {
    ownerId: 12345,
    repositoryId: 67890,
    git: ["read", "write"],
    refs: {
      update: ["refs/heads/users/bobby/*"],
      create: ["refs/heads/users/bobby/*"],
      delete: [],
      force: [],
    },
  };
  const policy: GatewayPolicy = { forceAllowed: false };
  const installation: InstallationScope = { contents: "write" };
  const mintedToken: MintedTokenScope = { contents: "write" };
  const rules: RepositoryRules = { protectedRefPatterns: ["refs/heads/main"] };

  log("── git-gateway permission intersection (prx-0wsf round 5) ──────────");
  log(`jwt: repo=${jwt.repositoryId} git=[${jwt.git.join(",")}] refs.update=${jwt.refs?.update.join(",")}`);
  log(`installation.contents=${installation.contents}  mintedToken.contents=${mintedToken.contents}`);
  log(`rules.protectedRefPatterns=${rules.protectedRefPatterns.join(",")}\n`);

  const base = { jwt, policy, installation, mintedToken, rules };

  const run = (name: string, request: GitRequest, overrides: Partial<typeof base> = {}) => {
    const verdict = effectiveAuthority({ request, ...base, ...overrides });
    const line = verdict.ok
      ? `ALLOW  ${request.op} ${request.action} ${request.ref}`
      : `DENY   ${request.op} ${request.action} ${request.ref}  [${verdict.layer}] ${verdict.reason}`;
    log(`${name.padEnd(28)} ${line}`);
  };

  // Happy path — everything agrees.
  run("happy.feature-push", { op: "write", ref: "refs/heads/users/bobby/feature", action: "update" });

  // Layer 1 (JWT): read-only JWT can't write at all.
  run(
    "deny.jwt-read-only",
    { op: "write", ref: "refs/heads/users/bobby/feature", action: "update" },
    { jwt: { ...jwt, git: ["read"] } },
  );

  // Layer 1 (JWT refs): JWT permits users/bobby/* but not this ref.
  run("deny.jwt-ref-pattern", { op: "write", ref: "refs/heads/someone-else/feature", action: "update" });

  // Layer 2 (gateway policy): force disabled gateway-wide, regardless of JWT.
  run(
    "deny.policy-no-force",
    { op: "write", ref: "refs/heads/users/bobby/feature", action: "force" },
    { jwt: { ...jwt, refs: { ...jwt.refs!, force: ["refs/heads/users/bobby/*"] } } },
  );

  // Layer 3 (installation ceiling): App installation itself only has read.
  run(
    "deny.installation-ceiling",
    { op: "write", ref: "refs/heads/users/bobby/feature", action: "update" },
    { installation: { contents: "read" } },
  );

  // Layer 4 (minted token, defense in depth): a read request satisfies the
  // installation ceiling (contents:read is sufficient) but the token forge-d
  // actually minted is broader (contents:write) — a minting-side bug that
  // Layer 3 alone would never see (it only checks whether the ceiling meets
  // what's NEEDED, not what was ACTUALLY minted). Caught independently here.
  run(
    "deny.token-exceeds-ceiling",
    { op: "read", ref: "refs/heads/users/bobby/feature", action: "update" },
    { installation: { contents: "read" }, mintedToken: { contents: "write" } },
  );

  // Layer 5 (repository rules): the canonical example — every layer above
  // agrees, but the ruleset still denies a direct push to main.
  run(
    "deny.ruleset-protects-main",
    { op: "write", ref: "refs/heads/main", action: "update" },
    { jwt: { ...jwt, refs: { ...jwt.refs!, update: ["refs/heads/main", "refs/heads/users/bobby/*"] } } },
  );

  // Read is unaffected by any of the write-side layers.
  run("happy.read", { op: "read", ref: "refs/heads/main", action: "update" });
}

main();
