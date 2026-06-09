# /claims-audit

Run the **claims-calibration** audit (`docs/claims-audit-instrument-v0.md`):
enumerate every public claim prx makes from its own sources, score each into
Enforced / Partial / Aspirational / Stale, and scaffold a dated baseline under
`docs/audit/`.

This is the calibration sibling of `/audit-baseline`. That one audits beads
hygiene (was closed work Durable/Churn/Learning/Shelved?). This one audits
whether each shipped claim is actually enforced on a path a user exercises — the
miscalibration the drift tests can't see (a claim sized one tier above its check).

## Run

Generate the cohort and drop a dated scoring template:

```bash
bun run packages/prx/scripts/claims_sample.ts --write docs/audit/
```

This writes `docs/audit/claims-YYYY-MM-DD.md`. The script refuses to overwrite an
existing same-day file unless you pass `--force`. The cohort is **generated from
sources** (community.json, value_props.ts, package descriptions, STATUS) — never
hand-edit the claim list; re-run to refresh it.

## Workflow

When invoked, the agent should:

1. **Confirm or fill the "Enforced" definition first.** The working rule lives in
   `docs/claims-audit-instrument-v0.md` under "Definition" (a claim is *Enforced*
   when the asserted property is checked on a real user-exercised path, default-on
   — not a pure-helper unit test, a one-off run, or a flag-gated check). If you
   sharpen it, record the new wording at the top of the baseline **before scoring**
   — the bias mitigation depends on the definition being fixed before the scorer
   reads the cohort.
2. **Run the sampler:** `bun run packages/prx/scripts/claims_sample.ts --write docs/audit/`.
   The path it prints is the baseline to score.
3. **Score each claim.** Fill exactly one **Verdict** checkbox (Enforced / Partial
   / Aspirational / Stale) per the rubric. For Section B, the printed
   **Self-report** is the value prop's own backing tier — your job is to reconcile
   it: a forcing function self-reporting `[backed]` that you score Partial/
   Aspirational is the miscalibration signal. Verify call sites and flag defaults
   with targeted greps (`rg verifyEffectOwnership`, `rg PRX_REQUIRE_SIGNED`) rather
   than trusting the prose.
   - **Re-verify any reused bd short-id before citing it** — bd recycles short-ids
     after close (GH-2254 / invariant I-BD4). Resolve to the canonical long-id and
     confirm the title matches before you cite it as a tracking id. See
     `docs/bd-id-stability.md`.
4. **Name a gap + a tracking bd id for every non-Enforced claim.** This is
   mandatory (the rubric requires it) — a verdict without a remedy is a complaint,
   not an audit. File new gaps against epic `prx-suz` (or its successor). Surface
   the proposed bd titles to the user; **do not create the issues without
   confirmation.**
5. **Compute the tally.** The four bucket counts, the **calibration ratio**
   (Enforced / total), and the **self-report mismatch count** (claims
   self-reporting `[backed]` scored Partial/Aspirational) — the headline number
   this instrument exists to produce. Track it across runs.
6. **Do not auto-commit or PR.** The baseline is a draft for the user to accept,
   edit, or discard. Scoring is judgment; the command scaffolds, it doesn't decide.

## Cost — tier the two halves (see the instrument's "Running it cheaply")

- **Enumerate on a cheap tier.** `claims_sample.ts` + the supporting greps are
  deterministic retrieval — run them on Haiku/Sonnet or as an `Explore` subagent
  to isolate the token cost.
- **Score on the capable tier.** Reserve Fable 5 / Opus for the Enforced-vs-Partial
  judgment, operating only on the small generated cohort. On hard judgment the top
  model is often the *better* spend, not a splurge — one correct pass beats several
  cheap-but-wrong verdicts that trigger a re-audit. Use `effort: high`; `max` only
  for a genuinely contested verdict (effort is non-monotonic — `max` can score
  *below* `high`).
- **Basis = prx's own ledger, not a borrowed chart.** The tiering call should be
  grounded in prx's self-measured cost-vs-outcome (per-model, per-effort, from the
  audit ledger) — the prx-native diamond tracked by `prx-b2n`. Until that lands the
  two-tier split above is the qualitative stand-in.

## When to invoke

- **Every release tag** — claims change when the surface ships; this belongs on
  the same trigger as the docs regen. A release adding a value prop or tagline
  clause shouldn't merge without that claim in a scored cohort.
- **The ~2-month habit** carried from the beads instrument.
- **After any capability-security or provenance change** — the two areas where
  miscalibration has historically clustered (epic `prx-suz`).

## References

- `docs/claims-audit-instrument-v0.md` — full rubric, definition, verdict buckets,
  ratios, limitations.
- `packages/prx/scripts/claims_sample.ts` — the cohort enumerator.
- `packages/prx/src/value_props.ts` — the forcing-function model this audits.
- `/audit-baseline` + `docs/audit-instrument-v0.md` — the beads-hygiene sibling.
- epic `prx-suz` — the calibration backlog this feeds.
