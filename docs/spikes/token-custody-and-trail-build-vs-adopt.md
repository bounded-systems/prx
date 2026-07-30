# Token custody and the call trail: adopt Octo STS, or build the injection proxy? (ADR)

> Design-only spike. Settles whether prx adopts a third-party GitHub STS
> (Octo STS) as part of closing the credential-custody + audit-trail gap, before
> any broker or proxy code is written. No `src/`/`packages/` changes in this
> unit — the decision is the deliverable. Written 2026-07-30.
>
> **Provenance note.** The external landscape in §2 is summarised from sources
> supplied to this spike, not independently verified here. The claims about
> *prx's own* current state (§3) were read from this repository and are cited to
> file. Where the two disagree, §3 wins.

## 0. Status

**Partially rejected.**

- **Reject** adopting **Octo STS**. Not because it is weak — it is the mature
  reference implementation — but because prx already operates its own OIDC→App
  token broker with a stricter attenuation model than Octo STS provides. This
  would be a *replacement*, not an addition, and it would cost the two-layer
  least-privilege design already accepted in
  [github-apps-architecture.md](../prx/github-apps-architecture.md).
- **Accept** building the **thin TLS-terminating injection proxy**. This is the
  only one of the four patterns that delivers the thing prx does not have, and
  no amount of broker work substitutes for it.
- **Defer** OS-level egress enforcement to a follow-up, with the caveat in §6.

The headline: **custody is solved; the trail is not.** They are separate
problems, and the pattern that solves the first cannot solve the second.

## 1. The two problems, named separately

Conflating these is the trap this spike exists to avoid.

1. **Custody — who holds a credential, for how long, scoped to what.** Failure
   mode: a long-lived PAT leaks and is replayable. Solved by short-lived,
   narrowly-scoped, brokered tokens.
2. **Trail — what was actually *done* with the credential.** Failure mode: a
   token is legitimately minted and then used for operations nobody can
   enumerate afterwards. Solved only by a component that sees the *requests*.

A broker issues credentials, so it can log **issuance**: who got what scope,
when. It never sees the calls made with what it issued. A trail of issuance is
not a trail of use, and reading one as the other is the specific error this ADR
rules out.

## 2. The four patterns, and which problem each solves

| # | Pattern | Custody | Trail | Notes |
|---|---------|:---:|:---:|---|
| 1 | Token broker / STS (Octo STS) | ✅ | ❌ | Clients still call `api.github.com` directly with the minted token. Issuance log only. |
| 2 | Secretless / credential-injection proxy | ✅ | ✅ | The only pattern where both land at one choke point. Requires TLS termination. |
| 3 | Egress allowlist proxy (Smokescreen, Envoy) | ❌ | ⚠️ | CONNECT tunnels are not terminated, so it logs **domains**, not operations. Enforcement, not visibility. |
| 4 | AI-agent gateways | ✅ | ✅ | Emergent category; sources are largely vendors defining the market they sell into. Treat claims as unverified. |

Pattern 3's limitation is the one most often misread: an allowlist proxy that
cannot see inside TLS gives you "this workload talked to `api.github.com`" and
nothing about which GraphQL operation ran. For a body-level trail it is inert
unless it also terminates — at which point it is pattern 2.

## 3. What prx already has — the reason this ADR rejects pattern 1

Pattern 1 is **already implemented and deployed**, in-house:

| Component | What it does | Where |
|---|---|---|
| **cf-token-broker** | Cloudflare Worker; org-wide OIDC→GitHub-App installation token. The App private key lives only in the broker; no key reaches a runner. | prx-26bq; [github-apps-architecture.md](../prx/github-apps-architecture.md) |
| **Runtime broker** | Cache + expiry-aware refresh + concurrency dedupe over a token source; never logs the secret. | `packages/prx/src/github-app/broker.ts` |
| **forge-d door** | Runtime credential-broker door; leases rather than holding. | `src/forge-d/*`, `door-source.ts` |
| **Per-use attenuation** | Every minted token narrowed to the caller's repos + a subset of the bucket's permissions. | `PRX_GH_APP_REPOSITORIES` / `PRX_GH_APP_PERMISSIONS` |

Consumers already run this way: `front-desk-add.yml` declares
`permissions: id-token: write` as *the only capability the job needs* and
exchanges the OIDC token at the broker. The org-projects bucket app was retired
because the broker superseded it.

So the accepted architecture is already **two layers of least privilege** —
app-bucket blast radius (layer 1) plus per-use attenuation (layer 2). Octo STS
delivers layer 1 well. It does not bring layer 2's `repositories` +
`permissions` narrowing as a first-class part of prx's own config surface, which
`github-apps-architecture.md` treats as load-bearing rather than incidental.

**Adopting Octo STS would therefore mean:** migrating every OIDC consumer,
re-homing the App key into a third-party trust root, and re-expressing layer-2
attenuation in someone else's policy language — to gain maturity in the one
layer prx has already shipped, and to gain **nothing at all** on the trail. The
cost is real and the benefit is a wash.

*(This is a reversal of the framing this spike started from, which treated
"adopt Octo STS + build a thin injection proxy" as the composite candidate. The
first half is redundant against what is already deployed.)*

## 4. What is actually missing

The trail. Concretely: today a brokered token is handed to a client that calls
GitHub directly, so the record stops at "a token with scopes S was minted for
workload W at time T." What ran under it — which GraphQL operations, against
which resources, in what volume — is not reconstructible from anything prx
holds.

Only pattern 2 closes this, and it closes custody at the same time: if the proxy
holds the credential and injects at egress, the client never possesses a token
at all, and every request necessarily passes the point that can log it.

## 5. Decision — build the thin injection proxy, keep the broker

**Keep** cf-token-broker as the minting layer. **Add** a TLS-terminating
injection proxy in front of it, holding the brokered token and injecting
`Authorization` at egress.

Why this is small in prx's case, and where the work actually is:

- **One upstream host.** `api.github.com`. Not a general-purpose forward proxy.
- **Parse only what is logged.** GraphQL is a single POST endpoint; the trail
  needs the operation name and variables, not a full schema-aware parser.
- **The credential path already exists.** The proxy becomes a broker *consumer*,
  reusing `broker.ts`'s cache/refresh/dedupe rather than reimplementing minting.
- **The hard part is not the proxy.** It is making the direct route fail — §6.

## 6. The enforcement caveat — why this is "accept, with a condition"

A proxy that clients are *asked* to use is a convention, and conventions are not
coverage. This is the same failure the client-side trail had: it recorded what
went through it, which is not the same as what happened.

The supplied sources note repeated bypasses of Claude Code's network sandbox as
the illustration. The generalisable lesson is narrower than "sandboxes are
broken": **coverage is only guaranteed by credential custody or OS-level egress
control, never by a proxy clients could route around.** Since the injection
proxy is *also* the credential holder, it gets custody-based coverage for free —
a client that bypasses it has no token and simply fails. That is the property
worth protecting; it should be a stated invariant, not an emergent one.

Condition on acceptance: no client retains a directly-usable token once the
proxy is live. If both paths work during migration, the trail is incomplete for
exactly as long as that is true, and the doc should say so rather than imply
coverage it does not have.

## 7. Consequence

- Do **not** open work to adopt Octo STS. Record it as evaluated-and-rejected so
  it is not re-proposed; the rejection is about redundancy, not quality.
- Open the injection-proxy build as the next unit, scoped to: one upstream host,
  broker-backed credential, operation-level request log, and the §6 invariant.
- Revisit pattern 4 (agent gateways) in two quarters. The category may mature
  into something worth adopting for exactly this job; today the sources are too
  close to their own marketing to price.

## 8. Open

- **Where the proxy runs.** Cloudflare Worker (co-located with the broker) vs
  sidecar. The Worker path keeps one deployment story; the sidecar path is the
  only one that can also serve non-CI workloads.
- **What the log is written to, and its retention.** A trail nobody queries is a
  cost, not a control.
- **Whether `git` traffic is in scope,** or only the API. Git-over-HTTPS is a
  different credential path and is not closed by an API-only proxy.

Relates: prx-26bq (cf-token-broker), [github-apps-architecture.md](../prx/github-apps-architecture.md)
(bucketed apps + per-use attenuation), `forge-d` (runtime credential-broker door).
