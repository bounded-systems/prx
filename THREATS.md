# Threat model

Where prx records **accepted risks** — the ones a design deliberately takes on,
with the reason it was worth taking.

## What belongs here, and what does not

This file is a different genre from [`SECURITY.md`](SECURITY.md), which is a
*reporting* policy: how to tell us privately about a vulnerability, and what
happens next. Nothing here is a vulnerability report, and nothing here is a
known-unfixed bug.

An entry belongs here when **a design decision concentrates risk, and we took it
anyway because of what it buys.** The distinguishing test is that the risk is a
*consequence of the thing working as intended*, not of it being broken. A
concentration that appears only when something malfunctions is a bug; a
concentration that is load-bearing when everything is correct is a threat-model
entry.

Three rules keep this useful rather than decorative:

1. **State what the risk buys.** An accepted risk with no stated benefit is
   either an unaccepted risk or a mistake. If the entry cannot say what would be
   lost by removing the concentration, it does not belong here.
2. **State the boundary.** What the design does *not* cover is as important as
   what it does. A control described without its edges reads as broader than it
   is — which is how a partial control gets treated as a total one.
3. **Record status honestly.** An accepted design is not a deployed one. Say
   which.

Entries are numbered `T<n>` and appended; they are not renumbered, so references
from ADRs and issues stay valid. Supersede rather than delete.

---

## T1 — GitHub credential concentration in the egress proxy

**Status:** accepted design; **not yet deployed.** Decided in
[`docs/spikes/token-custody-and-trail-build-vs-adopt.md`](docs/spikes/token-custody-and-trail-build-vs-adopt.md)
(prx#1029), answering prx#1030.

### What concentrates

Under the accepted design, GitHub token custody moves into an egress proxy.
Clients no longer hold GitHub tokens; the proxy holds the credential — or mints
one from cf-token-broker — and injects `Authorization` on forward.

That makes one component simultaneously:

- the holder of the credentials for every GitHub path we control, and
- a participant in every request on those paths.

Highest-value target in the system, and a single point of failure. Compromise of
the proxy is compromise of GitHub access; an outage of the proxy is an outage of
GitHub access.

### What it buys, and why the concentration is the point

The concentration is not a side effect to be minimised — it *is* the mechanism.

Because the proxy holds the credential, bypassing it stops being a policy and
becomes impossible: a call that does not traverse the proxy is unauthenticated
and fails. A tool that hardcodes `api.github.com` does not quietly emit
unlogged calls; it errors immediately and identifies itself. **Silent coverage
gaps become loud failures.**

This is the property the alternative lacks. A proxy clients are merely
*configured* to use has the same weakness that produced the incident behind
prx#1030 (`bounded-systems/github-budget#9`): on 2026-07-30 two cloud sessions
spent 10,104 GraphQL points against a 5,000 limit, and the budget gate that
would have caught it was correct but *outside the path*, because it wraps `gh`
and none of the traffic used `gh`. Coverage that depends on each component
opting in fails at exactly the component that did not.

It is also prx's first value prop applied to API egress rather than git writes:

> An agent cannot perform an action its role doesn't own — a delegated
> capability, not ambient trust; **overreach is a denial, not a hope.**

Removing the concentration means returning to hope.

### Boundary — what this does not cover

The proxy makes *our* paths unbypassable. These stay outside it, and are
therefore neither covered by its trail nor exposed by its concentration:

1. **GitHub Actions runners calling the API with `GITHUB_TOKEN`.** The platform
   injects that credential; we do not control that egress.
2. **A developer's personal `gh` auth.** Their credential, their path.
3. **Anything running where we do not control egress**, generally.

There is also no server-side trail to fall back on: `bounded-systems` is on
GitHub Free, and org audit-log APIs require Enterprise Cloud (three independent
measurements recorded in prx#1030). The proxy carries the whole trail for the
paths it covers, and nothing carries it for the paths above.

### Migration caveat

While any client retains a directly-usable token, the enforcement property does
not hold and the trail is incomplete — for exactly as long as that is true. The
guarantee is "no client holds a usable token," and it is binary. A partially
migrated deployment has the concentration without the benefit, which is the
worst point on the curve.

### What would reduce it

Not resolved here; recorded so the options are not re-derived:

- Splitting custody by scope, so one compromise does not yield every permission
  (the bucketed-apps direction already accepted in
  [`docs/prx/github-apps-architecture.md`](docs/prx/github-apps-architecture.md)).
- Keeping the proxy a *broker consumer* rather than a key holder, so the App
  private key stays in cf-token-broker and the proxy holds only short-lived
  minted tokens. This is the intended shape and meaningfully caps blast radius:
  compromise yields tokens that expire, not a key that does not.
- Availability is the harder half — the enforcement property means a proxy
  outage is a hard stop by construction, not a degradation.

### References

- prx#1029 — the ADR (§6 custody as enforcement, §7 residual gaps, §8 this risk)
- prx#1030 — the decision request (closed); this entry is its third acceptance
  criterion
- prx#1032 — the task that produced this file
- `bounded-systems/github-budget#9` — the incident
