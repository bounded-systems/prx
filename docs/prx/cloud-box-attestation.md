# ADR — attesting the cloud box: what an untrusted Claude-Code-web session can prove

> Status: **proposed** (spike, evidence-backed). Establishes what a Claude Code
> on the web session can and cannot prove about itself, so a privileged action
> — e.g. filing a bead into the Dolt-backed beads DB (see
> `docs/prx/batch-transport.md` for why that comes up) — can be gated by an
> **external broker** without ever placing a credential inside the box. The
> `.claude/attest-box.sh` SessionStart hook emits the attestation this ADR
> specifies. Sibling to `docs/prx/beadsd-door-wiring.md` (the door that would
> consume it) and to the keeper door (`docs/spikes/keeper-door-secret-validation.md`,
> prx-b44y) — one candidate broker. Attenuation is a **multi-party caveat
> chain**, not a box boundary (see *Layered attenuation*); the broker holds the
> DoltHub credential off the cloud entirely (see *Broker realizations*).

## Problem

Work done in a Claude Code on the web session sometimes needs a capability the
box does not hold — canonically, a **DoltHub write credential** to file a bead
(the beads backend is Dolt in server mode; the cloud box has no such
credential, and the repo deliberately forbids the git-JSONL side door). The
docs are explicit that there is **no secrets store**: environment variables and
setup scripts are visible to anyone who can edit the environment. So "inject the
token" is not a safe answer.

The alternative is to have the box **prove properties about itself** to an
external broker that holds the credential, and let the broker decide. That only
works if we are honest about what is actually provable. This ADR pins that down
empirically.

## Evidence — what this box actually is

Probed from inside a live session (2026-07):

| Property | Observation | Consequence |
| --- | --- | --- |
| Hardware root of trust | no `/dev/tpm*`, no `/dev/sev-guest`, no efivars | **no self-attestation**: no vTPM quote, no confidential-compute report |
| Virtualization | `systemd-detect-virt → docker` | the box is a **container**, not a measured VM boot from its own vantage |
| Cloud metadata service | `169.254.169.254 → HTTP 403`; GCP metadata unresolvable | the one hardware-anchored identity surface is **locked down** — no signed instance-identity document |
| Base image identity | `ANT_IMAGE_REPOSITORY=sandbox-ccr-default`, `ANT_IMAGE_TAG=74306e8b…` | image is **named** by Anthropic via env — a tag, not a content digest; forgeable in-box |
| Real credentials at rest | `GITHUB_TOKEN=proxy-…` (a *proxy* token); no `~/.git-credentials` | the real GitHub token is held by Anthropic's proxy, **outside** the box |
| Git transport | `origin → http://…@127.0.0.1:PORT/git/OWNER/REPO`; `url.…insteadOf https://github.com/` | all git auth is **mediated** by a localhost credential-translation proxy |
| Egress | `HTTPS_PROXY` + `CCR_EGRESS_GATEWAY_ENABLED=1` + CA bundle | every outbound byte passes an Anthropic proxy (audited, filtered) |
| Session identity | `CLAUDE_CODE_REMOTE_SESSION_ID=cse_…`, `CLAUDE_SESSION_INGRESS_TOKEN_FILE` (an *ingress* token) | a bearer id + an **inbound** control token — not a key the box can present outward |

**The base image is identifiable but not attestable.** `ANT_IMAGE_TAG` is a
name Anthropic assigned, not a digest the box computed that a third party can
verify; with no TPM/SEV/IMDS, the box cannot bind itself to a measured image.
Any base-image "attestation" is Anthropic-side, verified out-of-band by whoever
trusts Anthropic — not something the box proves.

## The load-bearing conclusion

**The box has no root of trust of its own, so nothing it says about itself is
provable by the box.** Every real anchor lives on the *far side* of a channel
Anthropic authenticates on the box's behalf. Attestation must therefore be built
from those channels and from git content-addressing, treating the box as
untrusted compute throughout.

## What is provable to an external broker (ranked)

All achievable with **zero credentials in the box**:

1. **Control of a specific `(repo, branch)` as a specific GitHub identity —
   strong.** The box can push to the PR branch; the proxy authenticates it as
   the connected account and restricts push to the working branch. A broker
   issues a nonce → the box pushes a commit / `signed ref-snapshot` bearing it →
   the broker **re-verifies via the GitHub API, independent of the box**. This
   is the primitive to build on.
2. **Read access to a private ACL repo — strong, and already in production.**
   `.claude/inject-org-context.sh` clones the private `bounded-systems/.github-private`
   through the GitHub proxy; its own comment states the semantics: *"Access
   follows the session's GitHub auth — maintainers succeed, outside contributors
   fail open."* A private repo the broker controls thus becomes an allowlist:
   "can this session read repo X?" = "is this session's GitHub identity
   permitted?" — decided by GitHub, no token in the box.
3. **Origin-from-Anthropic-egress — weak, composable.** The broker endpoint only
   accepts calls from Anthropic's managed egress. Confirms "an Anthropic cloud
   session called me," shared across all sessions — a filter, not an identity.
4. **Session provenance (`cse_…` + transcript URL) — weak, bearer.** Meaningful
   only if the broker trusts Anthropic to attest it; no public verification API,
   env not confidential. A hint, never the proof.

**Not provable:** VM/base-image integrity, that the env or a setup script was
not tampered by its editor, a stable cross-session box identity, or
confidentiality of any injected secret.

## Why the attestation belongs in a hook, not a setup script

The web docs split provisioning by ownership, and that split *is* the trust
boundary:

| | SessionStart hook | Setup script |
| --- | --- | --- |
| Attached to | the **repository** (part of the clone) | the **cloud environment** (mutable config) |
| Bound to | the head commit a broker verifies at GitHub | nothing in git |
| Broker can trust its bytes? | **yes** — content-addressed | **no** — invisible, editor-mutable |

So trusted provisioning belongs in a git-tracked hook. The repo already lives
this: `ensure-beads.sh` and `inject-org-context.sh` are hooks, not setup
scripts. `.claude/attest-box.sh` follows suit — its exact bytes are pinned to
the commit the broker re-verifies, so the attestation *and the code that
produced it* are covered by the same GitHub anchor.

## Decision — the broker protocol

Because the box demonstrably cannot hold a secret, **the door performs the
privileged write; the box only submits an artifact plus proofs.** This is the
`beadsd-door-wiring.md` shape:

1. Box builds the proposed bead as a content-addressed artifact (`signed
   ref-snapshot`) and **pushes it to the PR branch** via the GitHub proxy.
2. Box emits `.claude/attest-box.sh`'s bundle and calls the external broker over
   the egress proxy with `{repo, branch, PR#, head_commit, artifact digest,
   session_url}`.
3. Broker **verifies against GitHub, not the box**: the commit is on branch B of
   repo R under the expected identity (proof 1), the identity can read the ACL
   repo (proof 2), the digest matches — optionally with a fresh-nonce round
   trip.
4. Broker — holding the DoltHub credential **outside** the box — performs the
   bead write and stamps provenance (`session_url`, `head_commit`). The raw
   token never touches the box.

This maps onto primitives prx already has: the proxy's per-branch push
restriction *is* capability attenuation (`git-gateway-permission-intersection`),
and `signed-ref-snapshot` / `worktree-provenance` are the artifact-identity
layer the broker checks.

## Layered attenuation — a caveat chain, not a box boundary

Attenuating "what Claude can do" **only** at the box boundary is too weak: the
box's one authenticated power (push to its branch) is a coarse grant, and a
single boundary is a single point of forgery. Attenuation must be a **chain of
caveats**, each narrowed and — critically — **verified by a different party**, so
that no single compromise (not the box, not Anthropic's platform, not GitHub
alone) is sufficient to effect the privileged write. Two slogans capture the two
directions this must extend:

- **More than the box.** Authority is narrowed at every hop, not just at the
  sandbox edge: launch → box → artifact → broker → DoltHub.
- **More than the cloud.** The *roots of trust* are distributed off the cloud:
  GitHub (signer + branch/ACL authority), the launch origin (the operator's
  pre-registration / launch key), the broker's own host-backed key, and an
  optional human gate. Anthropic's cloud channel *mediates* but is never the sole
  root.

| Hop | Authority it holds | Attenuated to | Verified by |
| --- | --- | --- | --- |
| Launch origin | operator account + optional launch key | one session, one `(repo, branch)` | operator (pre-registration) |
| Box | GitHub-proxy push | its working branch only | the proxy (per-branch restriction) |
| Artifact | a web-flow-signed commit | one bead request + its digest | GitHub (`verification.verified`) |
| Broker | the DoltHub secret | one scoped write per verified request | itself, re-checking GitHub |
| Human gate (opt.) | approval | release / deny | reviewer (Environment / keeper lease) |
| keeperd | host-backed signing key | the signed push, nothing else | a key that never entered the cloud |

Each row is a caveat over the last — the `git-gateway-permission-intersection`
model, extended past the git edge to the DoltHub write.

## Signing on the token's authority — GitHub web-flow

A GitHub token is a bearer credential, not a signing key, and the box holds only
a `proxy-…` translation of it — so the box cannot *sign* with it. But a commit
**created through the GitHub API** (contents endpoint / merge) is signed by
GitHub's `web-flow` GPG key and returns `verification.verified = true`,
attributed to the session's authenticated identity. So the broker upgrades step
1: the box **creates the bead-artifact commit via the API** (web-flow signed) on
its branch rather than `git push`-ing it, and the broker checks
`verification.verified == true && reason == "valid"` and that the signer is
GitHub's web-flow key. This is a *portable cryptographic signature* over the
artifact — evidence that survives outside the branch context — with still no
secret in the box.

Caveat on what it attests: the signature is **GitHub's**, asserting "GitHub made
this commit on behalf of the token-holder," *not* "the user's private key signed
this." It proves account-authorized-via-this-session, mediated by GitHub. Local
`git push` commits are **not** web-flow signed — they are attributed only by
spoofable email→account mapping — so attestation must use API-created commits.

## Passing a root of trust from the launch origin

The box has no innate root of trust, but the **operator who launches it does**,
and can seed one at launch (`claude --remote`, the Remote/Routines SDK):

- **Correlation key (no secret).** The launch returns `{session_id, repo,
  branch, account}`; pre-register it with the broker. A submission proving
  GitHub-verified control of that `(repo, branch)` and reporting that
  `session_id` is bound to the job the operator actually started — turning
  "*some* session controls this branch" into "the session **I launched** does."
- **Delegated launch key (strong).** Mint an ephemeral keypair on the trusted
  machine; inject the private half at launch, register the public half with the
  broker. Now the box can sign the artifact / a broker challenge, verified
  against the pre-registered key. Best form: use it as a git commit-signing key
  (`git commit -S`), optionally registered to the account via the token
  (`POST /user/gpg_keys`) so it *also* verifies on GitHub — two independent
  anchors on one object.

Boundary: a launch key protects against a forging third party, not against the
platform itself (a compromised base image could read it from the env within its
validity window — there is no TPM/SEV/IMDS to detect that). This is acceptable
only because the same platform already holds the real GitHub token behind the
proxy — the launch key rides trust already extended, it does not widen it. Scope
it **single-use, session-scoped, short-lived**.

## Broker realizations

Three ways to stand up the door that holds the DoltHub credential outside the
box and performs the write on verified evidence:

| Realization | Where the secret lives | Reaches the box how | Attenuation layers it adds | Cost |
| --- | --- | --- | --- | --- |
| **GitHub Actions + Environments** | repo **Actions secret** (`DOLTHUB_TOKEN`) | box pushes / dispatches → workflow runs on GitHub's runners | branch protection, CODEOWNERS, **Environment required-reviewers** (human gate), secret scoped to the workflow | **lowest** — no new infra |
| **Cloudflare Worker / Tunnel** | Worker secret (or Access-gated origin) | box calls the Worker over egress (allowlist its domain); or a **Tunnel** fronts a local keeperd | Cloudflare Access (mTLS/service tokens), edge rate-limit, Worker re-verifies at GitHub, DoltHub write via its HTTP SQL API | medium — deploy a Worker |
| **keeperd (prx-native)** | **host-backed** podman secret → tmpfs (never in image/git) | door-bridge (authenticated TCP/vsock) from the pod; from cloud, via a Cloudflare Tunnel ingress | caveat-based leases (`forge-d` scoping), the keeper door signs/pushes and nothing else, key is a **separate** root of trust | highest — run keeperd + tunnel |

Recommended sequencing:

1. **Start with GitHub Actions + Environments.** It uses the GitHub secret store
   you already have, needs zero new infrastructure, and its **Environment
   required-reviewer** gate is the "human approval" caveat — realizing *more than
   the box* immediately. The box produces a web-flow-signed request commit; a
   workflow (not the box) verifies it, installs bd+dolt, and writes the bead with
   the secret. This is the fastest path to a working, multi-party broker.
2. **Graduate to keeperd fronted by a Cloudflare Tunnel** as the end-state — the
   prx-native door already validated by `prx-b44y` (host-backed secret + live
   push), with the Tunnel giving the cloud box an authenticated ingress to reach
   a keeperd you run. Richest attenuation (lease caveats) and the strongest
   *more than the cloud* posture: the signing key never touches Anthropic infra.

A standalone **Cloudflare Worker** is the middle option when you want an
always-on edge broker without running keeperd — but to stay aligned it must
still route the write **through bd** (see *Data plane*), not hand-write SQL.

## Data plane — bd is the writer; the box holds no dolt

A bead write is **not raw SQL**: bd owns id allocation, dependency edges, the
events audit trail, JSONL export, and high-water marks. So the write must go
*through bd*, or it drifts from bd's invariants (the same drift the repo's
dolt-canonical rule forbids). This ranks the deployment shapes — and note the
**cloud box never needs dolt**; it holds nothing and only submits the signed
artifact. dolt lives in the *broker's* domain:

| Shape | dolt instance | Who writes | Aligned? |
| --- | --- | --- | --- |
| keeperd + `dolt-box` (local) | a real dolt server you run, ingress-fronted | **bd** → local dolt; keeper pushes | **best** — this *is* `beadsd-box`+`dolt-box`+keeper |
| bd → remote dolt sql-server | dolt as a shared service (hosted / managed `dolt-box`); no local clone | **bd** over MySQL protocol (`dolt_mode: server`) | aligned — bd stays the writer |
| raw DoltHub HTTP SQL API | none | reimplements bd's schema + events | **off-model** — bypasses bd |

Chosen: **bd is always the writer.** Run it against a local `dolt-box` (richest,
prx-native) or point it at a remote dolt sql-server (lighter ops) — but never the
raw HTTP SQL path.

## Scaffold — the bead-write broker contract

Mirrors keeperd's spec-as-schema seam (`packages/prx/src/keeperd/contract.ts`):
both ends `parse()` every frame, so a malformed request is a validation error at
the seam, never a half-executed write. The box holds no dolt and no secret; it
submits the bead plus the GitHub-anchored proof the door **re-verifies**.

```ts
// Box → broker (keeperd). The door NEVER trusts these fields — proof.* is
// re-verified against GitHub before any write.
export const BeadWriteRequestSchema = z.object({
  kind: z.literal("bead-write"),
  // The proposed bead — these become `bd create` args (bd is the writer).
  bead: z.object({
    title: z.string().min(1),
    type: z.enum(["bug", "feature", "task", "chore", "epic"]),
    body: z.string().default(""),
    // optional: labels, priority, dependency edges — whatever bd create accepts
  }),
  // The evidence, re-checked at GitHub (an authority independent of the box).
  proof: z.object({
    repo: z.string().min(1),            // owner/repo
    branch: z.string().min(1),          // the box's working branch (push-restricted)
    artifactCommit: Sha1,               // web-flow-signed commit carrying the bead artifact
    artifactDigest: z.string().min(1),  // sha256 of the canonical bead artifact
    sessionId: z.string().min(1),       // cse_… — matched to the operator's launch pre-registration
    // optional delegated-launch-key signature over (artifactDigest || nonce)
    launchSig: z.object({ alg: z.string(), sig: z.string(), nonce: z.string() }).optional(),
  }),
});
// Response mirrors KeeperRemoteResponse: ok { beadId, doltPushRef, signedDerivation? }
// | error { code, message }.
```

Keeper-side pipeline — **fail closed**, each step a caveat verified by a
different party:

1. **`parse()`** the frame (schema seam).
2. **Ingress auth** — the call arrived over an authenticated channel (door-bridge
   TCP/vsock, or a Cloudflare Tunnel service token), not an open port.
3. **GitHub re-verify** (independent authority): `artifactCommit` is on `branch`
   of `repo` with `verification.verified == true && reason == "valid"` and signer
   = GitHub web-flow; its tree contains the artifact whose sha256 ==
   `artifactDigest`; and the authenticated identity can read the ACL repo (the
   `inject-org-context.sh` maintainer gate).
4. **Launch binding** — `sessionId` ∈ the operator's pre-registered launches for
   `(repo, branch)`; if `launchSig` is present, verify it against the
   pre-registered launch pubkey.
5. **Policy caveats** — idempotency/replay guard keyed on `artifactCommit` (a
   web-flow-signed commit is unique + tamper-evident, so a replay writes no second
   bead), rate-limit, optional human gate (Environment reviewer / keeper lease).
6. **Write via bd** — `bd create --type … --title … …` against `dolt-box` (or the
   remote sql-server). bd owns ids/events/schema.
7. **Signed push** — keeperd performs ONLY the security-sensitive step, the push
   to DoltHub with the **host-backed secret** (`prx-b44y`: podman secret → tmpfs,
   never in an image/git/host-plaintext). Optionally emit a signed
   `beadwrite/v1` derivation into a ledger ref, mirroring keeper's `push/v1`.
8. **Provenance return** — reply `ok` with `{ beadId, doltPushRef }`, stamped with
   the `session_url` for traceability.

Reuses, end to end: the box's push-restriction (proxy) → the web-flow signature
(GitHub) → the door's GitHub re-verification → bd's write correctness → keeper's
host-backed signed push. No single party — box, Anthropic platform, or GitHub
alone — can effect the write.

## Alternatives considered

- **Inject the credential into the environment.** Rejected: no secrets store —
  proven that env is visible to any environment editor, so any token here is
  exposed.
- **Self-host Dolt / SSH.** Rejected: a self-hosted DB forks canonical
  `bounded-systems/prx` and still needs DoltHub push creds to sync back — more
  infra for the same requirement.
- **TPM / SEV / IMDS attestation.** Unavailable: empirically no TPM, no
  SEV-guest, and the metadata service returns 403 — there is no hardware-anchored
  attestation surface to build on.
- **Trust base-image self-measurement.** Rejected as an anchor: a package BOM /
  `ANT_IMAGE_TAG` fingerprint is useful for comparison against a reference, but
  untrusted compute can fabricate it; base-image trust is Anthropic-side,
  out-of-band.
