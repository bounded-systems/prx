# Claims-calibration audit — instrument v0

**Purpose.** prx's honesty machinery — forcing functions, generated-from-source
docs, shrinking ratchets — is built to stop claims from going **stale** (a doc
drifting from the code). This instrument exists to catch the *other* failure
mode it does **not** cover: **miscalibration** — a claim whose check is real and
green but sized one tier *below* the sentence it backs. A value prop can
self-report `[backed]` because a pure unit test passes, while the property the
prose asserts does not hold in the live system. The drift tests will never flag
that, because nothing drifted; the claim was over-scoped from the start.

This is the sibling of `docs/audit-instrument-v0.md`. That one audits **beads
hygiene** (was closed work Durable / Churn / Learning / Shelved?). This one
audits **claim calibration** (is each public claim Enforced / Partial /
Aspirational / Stale?). Same shape: a generated cohort, a four-bucket verdict, a
dated baseline under `docs/audit/`, scorer judgment over machine pre-computation.

## The failure mode, named

> A check that passes is not the same as a claim that holds. A unit test on a
> pure function, a regex assertion, or a one-line "evidence" citation can all be
> green while the live pipeline does none of what the prose promises.

The 2026-06-09 read that motivated this instrument (epic `prx-suz`) found the gap
concentrated exactly where prx's identity lives — capability security and signed
provenance:

- `verifyEffectOwnership` self-reports the value prop "a privileged effect not
  produced by its owning actor fails verification", but has **zero live call
  sites** — its own header says "Pure + unwired".
- The README tagline says "every privileged effect is verified against its
  signed owner"; live verification covers git effects only, is **opt-in**
  (`PRX_REQUIRE_SIGNED_DERIVATIONS`, fail-open default), and checks signature
  validity, not ownership.
- The seam packages say "the one allowed access point"; ~13 leaf files import
  `node:fs` / `node:os` around the seam with no baseline.

None of these are drift. Each was over-scoped at authoring time. That is what the
verdict below is calibrated to surface.

## Definition (commit before scoring)

> **A claim is *Enforced* when the property the prose asserts is checked on the
> path a user actually exercises — not merely demonstrated by a unit test of a
> pure helper, a one-off historical run, or a check gated behind a non-default
> flag.**

Fill or confirm this one-sentence rule **before** looking at any individual
claim — the instrument's bias mitigation depends on the definition being fixed
before the scorer reads the cohort, exactly as in the beads instrument. If you
sharpen it, record the new wording at the top of the dated baseline.

## The cohort is generated, not listed

A claim left out of the cohort is a claim never audited. So the cohort is
**enumerated from the sources a reader trusts**, by
`packages/prx/scripts/claims_sample.ts`:

| Section | Source | What it captures |
|---|---|---|
| A. Marketing surface | `community/community.json` → `project.{tagline,description,claims}` | The README sentence + headline claims, split into independently-enforceable clauses |
| B. Value props | `src/value_props.ts` → `VALUE_PROPS` | Each value prop **and** each forcing function, with its **self-reported** backing tier as a hint |
| C. Exclusivity claims | `packages/*/package.json` → `description` matching the sanctioning regex | Every "the one allowed / one sanctioned X" package |
| D. STATUS rollup | `STATUS.md` (generated) | The "N of N backed" headline, cross-checked against the open backlog |

Re-run the sampler to refresh — never hand-edit the claim list. New surface →
new claims in the cohort automatically, the same way docs regenerate from
sources.

## The four verdicts

Score each claim into **exactly one** bucket.

- **Enforced** — the asserted property is checked on a real user-exercised path,
  default-on. The check would fail if the property broke in production, not just
  in a contrived unit test. *(The content-addressing value prop is the model: its
  tamper-evidence/determinism/in-toto tests check the actual property.)*
- **Partial** — a real check exists but is narrower than the prose: it covers one
  effect class of several, is opt-in / behind a non-default flag, tests a pure
  helper rather than the wired path, or verifies a weaker property (signature
  validity vs. ownership). The claim is true *if you read it narrowly*.
- **Aspirational** — the claim describes intended behavior with no live check, or
  only an unwired function / a one-line historical "evidence" citation. True as a
  roadmap item, not as a present-tense statement.
- **Stale** — the claim no longer matches the code at all (a renamed flag, a
  removed path, a package that no longer sanctions what it says). This is the
  drift the *other* instruments catch; surface it here and route the fix.

**Self-report reconciliation is the point.** Section B prints each forcing
function's self-reported tier (`[backed]` / `[evidence]` / `[learning goal]`).
The audit's signal is the **mismatch**: a forcing function self-reporting
`[backed]` that you score **Partial** or **Aspirational** is a miscalibrated
claim — count these explicitly in the tally. An `[evidence]`-only forcing
function is almost never **Enforced** (a past PR is not a present check).

## Every non-Enforced claim names a gap and a bd id

A verdict without a remedy is a complaint. For every claim scored **Partial /
Aspirational / Stale**, the baseline requires:

- **Gap** — one line: what the prose promises minus what the check delivers.
- **Tracking bd id** — an existing or newly-filed beads issue that closes the
  gap. (File against epic `prx-suz` or its successor.) Re-verify any reused bd
  short-id before citing it — bd recycles short-ids after close (GH-2254 /
  invariant I-BD4); persist canonical long-ids.

That requirement is what turns this audit from an observation into a backlog.

## Ratios to compute

After scoring, fill the tally:

- The four bucket counts over N.
- **Calibration ratio** = Enforced / total. The headline number; track it across
  runs the way the beads instrument tracks Durable:Churn.
- **Self-report mismatches** = claims self-reporting `[backed]` but scored
  Partial/Aspirational. The miscalibration count — the single number this
  instrument was built to produce. Target is zero; a non-zero value names the
  claims to re-tier or the checks to strengthen.

## Cadence

- **Every release tag.** Claims change when the surface ships; the audit belongs
  on the same trigger as the docs regen. A release that adds a value prop or a
  tagline clause should not merge without that claim in a scored cohort.
- **The ~2-month habit** carried over from the beads instrument.
- **Ad-hoc** after a capability-security or provenance change — the two areas
  where miscalibration has historically clustered.

## Running it cost-efficiently (model tiering)

The spend rule is **not** "always pick the cheapest model." Cost-vs-outcome is a
Pareto frontier, not a slope: the *better outcome can be the better spend* on hard
work, and within one model, more spend (higher effort / more tokens) buys score
**non-monotonically** — past a point, extra cost *lowers* the result. The rule is:
**match the model to where the task half sits on that frontier, and isolate the
expensive half so it stays small.**

**This audit must measure that frontier from prx's own ledger, not borrow it.**
Eating the dog food: prx already projects per-unit token usage + USD cost from the
audit ledger (`services/anthropic.ts:projectAnthropicUsage`, value prop #5). The
self-measured cost-vs-outcome view — bucket by **model** (sonnet / opus / fable /
haiku), trace a series across **effort / token** levels, plot against the audit's
own outcome (the calibration ratio) — is prx's own version of a score-vs-cost
diamond, and it is the *correct* basis for the tiering call below. **It is not
built yet** — the projector buckets by `profile` / `actor` / `workUnitId` only,
carries the token columns but no `model` field, and has no outcome axis. So this
cost-tiering guidance is itself a **learning goal**, tracked by `prx-b2n`; an
external diamond (Cognition's *FrontierCode*) is borrowed as the *shape*, not as
prx's data. Until `prx-b2n` lands, use the qualitative two-tier split:

- **Enumerate (mechanical → cheap is on-frontier).** `claims_sample.ts` is
  deterministic — it reads sources and scaffolds. The supporting greps (call-site
  counts, seam escapes, flag defaults) are retrieval with verifiable answers. A
  bigger model buys nothing here, so cheap *is* the efficient choice: run these on
  **Haiku** (or Sonnet for light reasoning), or as an `Explore` subagent so the
  token cost is isolated from the main session.
- **Score (judgment → capability is on-frontier).** Deciding Enforced vs Partial
  and reconciling a self-report against enforcement is exactly the hard half where
  the capability premium pays back: a correct one-pass verdict beats several
  cheap-but-wrong ones that trigger a re-audit (the re-audit is the real cost). So
  reserve **Fable 5 / Opus** for this, and only this — it operates on the *small
  generated cohort*, never the whole repo, so the expensive pass stays short.
  `effort: high` is the sweet spot; treat `max` as a contested-verdict escape
  hatch, not a default — effort is **non-monotonic** (a top model's score can
  *dip* from `high` to `max`), so more tokens is not reliably more correct.

The lesson, and the reason the two-tier split beats a blanket "go cheap":
cost-efficiency is *outcome per dollar*, not *dollars*. Spend the cheap tier where
capability is wasted and the capable tier where it changes the verdict — and once
`prx-b2n` lands, let prx's *own* per-model cost-vs-outcome curve pick the tier,
rather than this prose.

## Limitations (v0)

- **Judgment, not automation.** Like the beads instrument, v0 trusts the scorer.
  The Enforced/Partial line is the hard call and is deliberately left to a human +
  a capable model, not a heuristic. If a verdict rule proves stable enough to
  encode (e.g. "any forcing function whose only backing is `evidence` is at most
  Partial"), that is the v1 automation trigger — fold it into `value_props.ts` as
  a real tier, not into the scorer's head.
- **Cohort completeness rides on the sources.** A claim made somewhere the
  sampler doesn't read (a blog post, a slide, a code comment) is out of scope.
  When a new claim surface appears, extend `claims_sample.ts` first.
- **No verdict is auto-committed.** The baseline is a draft for the user to
  accept, edit, or discard — scoring is judgment, the command scaffolds.

## References

- `packages/prx/scripts/claims_sample.ts` — the cohort enumerator.
- `packages/prx/src/value_props.ts` — the forcing-function model this audits.
- `docs/audit-instrument-v0.md` — the beads-hygiene sibling.
- `docs/bd-id-stability.md` — short-id recycling caveat.
- epic `prx-suz` — the calibration backlog this instrument feeds.
