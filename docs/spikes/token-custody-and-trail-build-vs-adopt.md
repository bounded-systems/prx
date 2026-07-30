# Token custody and the call trail: does custody move into the prx proxy? (ADR)

> Design-only spike. **Answers #1030** — the recorded yes/no on whether GitHub
> token custody moves into the prx proxy — and settles the adopt-vs-build
> question for the STS layer while it is open. No `src/`/`packages/` changes in
> this unit; the decision is the deliverable. Written 2026-07-30.
>
> **Provenance note.** The external pattern landscape (§3) is summarised from
> sources supplied to this spike and is *not* independently verified here.
> Claims about prx's own state (§4) were read from this repository and are cited
> to file. Where the two disagree, §4 wins.

## 0. Status

**Yes — custody moves into the proxy.** #1030's Version 2.

| Question | Decision |
|---|---|
| Does token custody move into the proxy? | **Yes** — clients stop holding GitHub tokens |
| Adopt public `octo-sts.dev`? | **No** — already org policy (#234); not re-litigated here |
| Build self-hosted octo-sts (#234 Tier 2)? | **No — re-scope #234**; its premise was overtaken by cf-token-broker (§4.2) |
| Where does the proxy run? | Cloudflare Worker, co-located with cf-token-broker |
| Scope | `api.github.com` **and** git-over-HTTPS |
| Trail sink | Durable sink chosen up front, not retrofitted |

The spine of the decision: **custody and trail are different problems, and the
component that solves the first is structurally incapable of solving the
second** — but solving the first *in the right place* makes the second fall out
for free. That is the whole argument.

## 1. What forces this

`bounded-systems/github-budget#9`: on 2026-07-30 two Claude Code cloud sessions
spent **10,104 GraphQL points against a 5,000 limit**, and the overage was
discovered by hitting it. `github-budget` had already classified buckets, gated
before spend, and shipped a `GraphqlBudgetExhaustedError`. It wraps `gh`. None
of the traffic used `gh`.

The tool was correct and *not in the path*. Every client-side fix proposed in
that issue shares the property that produced the incident: **coverage depends on
each component opting in.** The component that skipped the trail is the same
component that would skip the new setting. The gap moves; it does not close.

### 1.1 Premise check — no server-side trail to lean on

Server-side API-request audit logging is Enterprise Cloud. `bounded-systems` is
on **GitHub Free**, on three independent measurements recorded in #1030: a live
`422 … Please ensure the billing plan supports the required reviewers protection
rule`; org rulesets containing no `workflows` rule; and `apps.json`'s recorded
finding that the org audit-log API requires Enterprise.

So there is no partial server-side coverage to net off. **The proxy carries the
whole trail.** This settles the question in the direction that makes the proxy
carry more, not less. Revisit only if the org moves to Enterprise; do not design
for it now.

## 2. Custody and trail are not the same problem

1. **Custody — who holds a credential, for how long, scoped to what.** Failure
   mode: a long-lived token leaks and is replayable. Solved by short-lived,
   narrowly-scoped, brokered tokens.
2. **Trail — what was actually *done* with the credential.** Failure mode: a
   token is legitimately minted and then used for operations nobody can
   enumerate afterwards. Solved only by a component that sees the *requests*.

A broker issues credentials, so it can log **issuance**: who got what scope,
when. It never sees the calls made with what it issued. A trail of issuance is
not a trail of use, and reading one as the other is the specific error this ADR
rules out. cf-token-broker's `audit:mint` records are issuance. The 10,104
points were use.

## 3. The four patterns, and which problem each solves

| # | Pattern | Custody | Trail | Notes |
|---|---------|:---:|:---:|---|
| 1 | Token broker / STS (octo-sts) | ✅ | ❌ | Clients still call `api.github.com` directly with the minted token. Issuance log only. |
| 2 | Secretless / credential-injection proxy | ✅ | ✅ | The only pattern where both land at one choke point. Requires TLS termination. |
| 3 | Egress allowlist proxy (Smokescreen, Envoy) | ❌ | ⚠️ | CONNECT tunnels are not terminated, so it logs **domains**, not operations. Enforcement, not visibility. |
| 4 | AI-agent gateways | ✅ | ✅ | Emergent category; sources are largely vendors defining the market they sell into. Treat claims as unverified. |

Pattern 3's limitation is the one most often misread: an allowlist proxy that
cannot see inside TLS gives you "this workload talked to `api.github.com`" and
nothing about which GraphQL operation ran. Since GitHub GraphQL is a single
`POST /graphql`, URL-level logging is worthless here — which is what rules out
the cheap option (Caddy-style access logs) and forces a real proxy.

## 4. What prx already has — and what that does to #229 / #234

### 4.1 Pattern 1 is already shipped, in-house

| Component | What it does | Where |
|---|---|---|
| **cf-token-broker** | Cloudflare Worker; org-wide OIDC→GitHub-App installation token. The App private key lives only in the broker; no key reaches a runner. | prx-26bq; [github-apps-architecture.md](../prx/github-apps-architecture.md) |
| **Runtime broker** | Cache + expiry-aware refresh + concurrency dedupe over a token source; never logs the secret. | `packages/prx/src/github-app/broker.ts` |
| **forge-d door** | Runtime credential-broker door; leases rather than holds. | `src/forge-d/*`, `door-source.ts` |
| **Per-use attenuation** | Every minted token narrowed to the caller's repos + a subset of the bucket's permissions. | `PRX_GH_APP_REPOSITORIES` / `PRX_GH_APP_PERMISSIONS` |

`front-desk-add.yml` already declares `permissions: id-token: write` as *the only
capability the job needs*, and the `prx-projects` bucket app was retired because
the broker superseded it.

### 4.2 #234's premise was overtaken by events

#234 ("standing keyless GitHub token-minting STS — Tier 2") is dated
**2026-06-06** and gated on: *"commit only when Tier 1 is in place and a second
consumer is imminent."* Its north star is a keyless, policy-driven, in-house
org-wide minting capability with audited mints.

**cf-token-broker shipped 2026-06-29** — three weeks later — and is exactly that
capability, reached by a different route. #234's acceptance criteria are largely
already met: keyless from CI via OIDC, in-house trust root, short-lived scoped
tokens, mints audited, adding a consumer is configuration rather than infra.

Nothing appears to have gone back and reconciled the two. So the recommendation
is **not** "build #234" and **not** "adopt octo-sts instead" — it is *re-scope
#234 against what already exists*, and close it if the delta is empty.

Note also that #234 **already rejected the public `octo-sts.dev` SaaS** on TCB
grounds ("a compromise there could mint tokens for our org *within policy*").
That is settled org policy, not a decision this ADR needs to make. What was
still open was self-hosted octo-sts — and that is what §4.2 answers.

### 4.3 #229 is a different problem wearing the same clothes

#229's need is that `GITHUB_TOKEN`-authored PRs don't trigger required `ci`
(GitHub's recursion guard), so the release-hashes bot PR sits un-mergeable. That
is a **workflow-triggering** problem, not a custody one. *Any* App-authored token
fixes it; octo-sts was one route to getting one keylessly.

**To check, not asserted here:** whether cf-token-broker can already mint for the
release-hashes path, which would close #229 with configuration rather than a new
service. Its current `front-desk` app scope may or may not cover it. That check
belongs on #229.

## 5. Decision — custody in the proxy, broker kept underneath

**Keep** cf-token-broker as the minting layer. **Add** a TLS-terminating
injection proxy in front of it that holds the credential and injects
`Authorization` at egress. Clients hold nothing.

Why this is bounded work in prx's case:

- **One upstream host.** `api.github.com`. Not a general-purpose forward proxy.
- **Parse only what is logged.** GraphQL is a single POST endpoint; the trail
  needs the operation name and variables (or a hash of the query text), not a
  schema-aware parser.
- **The credential path already exists.** The proxy is a broker *consumer*,
  reusing `broker.ts`'s cache/refresh/dedupe rather than reimplementing minting.
- **The hard part is not the proxy.** It is §6.

## 6. Why custody is the enforcement mechanism

A proxy that clients are *asked* to use is a convention, and conventions are not
coverage — that is #1030's Version 1, and it reproduces the incident with the
opt-in moved from instrumentation to configuration.

Because the injection proxy is *also* the credential holder, coverage stops
being policy and becomes structural: **a call that does not traverse the proxy is
unauthenticated and fails.** A tool that hardcodes `api.github.com` does not
quietly emit 10k unlogged calls — it errors immediately and identifies itself.
Silent gaps become loud ones.

This is prx's own first value prop applied to API egress rather than git writes:

> An agent cannot perform an action its role doesn't own — a delegated
> capability, not ambient trust; **overreach is a denial, not a hope.**

Version 1 is the hope. Version 2 is the denial.

**Condition on acceptance:** no client retains a directly-usable token once the
proxy is live. While both paths work during migration, the trail is incomplete
for exactly that long, and that should be stated rather than implied.

## 7. Residual gaps — scope, not afterthought

Version 2 makes *our* paths unbypassable. It does not make these visible, and
they stay outside the trail:

1. **GitHub Actions runners calling the API with `GITHUB_TOKEN`.** The token is
   injected by the platform; we do not control that egress.
2. **A developer's personal `gh` auth.** Their own credential, their own path.
3. **Anything running where we do not control egress**, generally.

Closing (1) would mean routing runner traffic through the proxy and denying
`GITHUB_TOKEN` — possible, but a separate decision with its own cost. Not in
scope here; listed so the trail's boundary is documented rather than assumed.

## 8. Concentration risk

The proxy would hold all credentials and sit in every data path: the
highest-value target in the system and a single point of failure. This is a real
cost of the decision, not a footnote.

**Recorded as [`THREATS.md`](../../THREATS.md) T1** (prx#1032), which is where
prx's accepted risks now live — a different genre from `SECURITY.md`, which is a
vulnerability-*reporting* policy. `SECURITY.md` links across to it.

T1 carries the parts this section only gestures at: what the concentration buys
(§6's enforcement property, which is the reason it is accepted rather than
minimised), the §7 boundary restated as what the control does *not* cover, the
migration caveat that a half-migrated deployment has the concentration without
the benefit, and the blast-radius note that keeping the proxy a broker
*consumer* — holding minted short-lived tokens, never the App key — is the
intended shape.

## 9. Build parameters (decided)

| Parameter | Decision | Note |
|---|---|---|
| Runtime | **Cloudflare Worker**, co-located with cf-token-broker | One deployment story; reuses the broker's trust boundary |
| Identity seeding | OIDC for CI now; other seeding **later** | ACT / podman guest-room and Claude Code agent identity are open; non-CI callers are a follow-up, not a blocker |
| Scope | **`api.github.com` + git-over-HTTPS** | Both credential paths, so "no client holds a usable token" is true rather than aspirational |
| Trail sink | **Durable, chosen up front** | A trail nobody can query is a cost, not a control |

Git-over-HTTPS is the larger half: smart-HTTP is a different protocol to proxy
and log than a JSON API, and it is what makes the custody claim complete rather
than API-shaped.

## 10. Consequence

- Record the **yes** on #1030 and close it against this document.
- **Re-scope #234** against cf-token-broker; close it if the delta is empty. Do
  not open octo-sts adoption work.
- Put the #229 question — can cf-token-broker mint for release-hashes? — on
  #229, where it belongs.
- Record the §8 concentration risk in `SECURITY.md` or a new `THREATS.md`.
- Open the proxy build with §9's parameters and §7's gaps as stated scope.
- Revisit pattern 4 (agent gateways) in two quarters; today the sources are too
  close to their own marketing to price.

Relates: #1030 (the decision request this answers), `bounded-systems/github-budget#9`
(the incident), #234 (Tier-2 STS epic — re-scope), #229 (release-hashes bot PR),
prx-26bq (cf-token-broker), [github-apps-architecture.md](../prx/github-apps-architecture.md).
