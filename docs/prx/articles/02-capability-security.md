# SLSA-for-agents: capability-security as the unsolved half

> Draft (Article #2 of the prx portfolio set, bead prx-3yy). This piece is
> deliberately split into **what's built and verified in code** and **what's
> still design** — because an article about governance that overclaims its own
> governance would refute itself. The verified mechanisms are cited to real
> files; the design-stage ones are labelled as direction, not shipped.

The first article in this set made a claim: durable agents are an engineering
problem, and two systems — lra and prx — independently get the durability half
right. This one is about the half almost nobody is building: **authority**.

Durability answers *"did the work survive?"* It says nothing about *"was this
privileged effect allowed, and attributable to whom?"* As soon as you let an
agent touch real systems — push to git, mint a token, hit an API with your
credentials — that second question is the one that should keep you up at night.
The model is the *least* trustworthy component in the loop, and we keep handing
it ambient access.

The framing I find useful is **SLSA-for-agents**: the same supply-chain rigor
that secured *build systems* — provenance, signing, a verifying gate — applied
to *what an agent is allowed to do*. Build security stopped trusting "the binary
came out of CI" and started demanding a signed, verifiable derivation. Agent
security has to make the same move.

## What's built (and verified in code)

These are the load-bearing mechanisms. I checked each against the source rather
than the README:

**Single-writer credential custody.** The agent never holds the credential. A
broker daemon — `keeperd` — holds the signing key and performs the git-write on
the agent's behalf (`keeperd/daemon.ts`). The container is credential-free by
design: the wire contract never returns key material (`keeperd/contract.ts`),
and the agent's own docs say it plainly — "you hold NO git credentials and NO
signing key… a raw `git push` cannot work; there is nothing in the box to push
with" (`claude-box CAPABILITIES.md`). The agent holds a *socket*, not a secret.

**Signed, content-addressed provenance.** A git-write carries a verifiable
in-toto / SLSA provenance derivation: `ocap-provenance/slsa.ts` emits in-toto
Statement v1 envelopes around SLSA Provenance v1, signed per actor, and
`anchored-chain` stores them in a content-addressed derivation ledger. This is
the literal SLSA shape, not an analogy.

**A policy gate the model cannot talk around.** The correctness boundary is a
fail-closed merge gate: `canEnterReadyToMerge` returns false while provenance is
`unsigned`, and `merge-guard.ts` re-verifies before anything lands. The agent
can be as persuasive as it likes; the gate checks signatures, not rhetoric.

**Attenuate-only authority.** Authority narrows, never widens — the attenuation
model in `github-apps-architecture.md` and the scout interaction-space spike. A
confused or compromised agent can subtract capability from what it was granted;
it has no path to add any.

## What's still design (labelled, not shipped)

If I'm going to write about governance, I have to grade my own:

- **Signed spawn — "no artifact, no spawn."** The intended rule: an agent can't
  bring a new actor into existence unless the spawn is signed, so authority is
  always *derived*, never conjured. This is direction. By name it isn't in the
  code yet — it's the natural next node on the same chain the provenance work
  already builds.
- **Rule-of-Two.** A design principle (two independent controls before a
  privileged effect), not an implemented gate today.
- **Unconditional enforcement.** Even the built mechanisms have a named gap:
  provenance *emission and enforcement are opt-in* until keyless signing fully
  lands — the project grades this "partial," not "enforced," and says so on its
  own homepage. The mechanism is real and tested; making it the unconditional
  default is the remaining work.

## Why the split is the point

It would be easy to write this article as if the whole capability-security stack
shipped. It mostly *works* — but "mostly works, opt-in" is exactly the gap
between a demo and a guarantee, and pretending otherwise is the failure mode this
entire project is a reaction to. The credibility of "SLSA-for-agents" depends on
holding yourself to SLSA's standard: a claim is only as good as the signature and
the gate behind it.

So here's the honest state. The custody boundary is real and hard — the agent
genuinely cannot push or sign. The provenance is real in-toto/SLSA, content-
addressed and verifiable. The gate genuinely fails closed. What's not yet
unconditional is the *enforcement posture* — and the spawn/Rule-of-Two layer is
design, not deployment.

That's still, I'd argue, further than almost anyone has taken **authority** as an
engineering property for agents. Durability has a healthy ecosystem. Governance —
provenance, custody, attenuation, a gate the model can't argue with — is the open
frontier, and it's the one worth building toward. That's the bet.

---

*Honesty note: every "built" claim above is grounded in a named file and graded
on the bounded.tools honesty section (enforced vs partial). The "design" claims
are labelled as such. If a mechanism isn't cited, treat it as aspiration.*
