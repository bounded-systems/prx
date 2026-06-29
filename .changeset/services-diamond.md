---
"@bounded-systems/prx": minor
---

Add `prx services diamond` verb and `--by=model` to `prx services status`.

`prx services diamond [--window=Nd] [--format=plain|json]` projects a
cost-vs-outcome table from the audit store: average spend per work unit
on the cost axis, fraction of work units that reached `merged`/`cleaned`
on the outcome axis, grouped by dominant model.

`prx services status --anthropic --by=model` buckets prompt-cache hit
rate and token cost by model (the `model` field was already written to
audit events; this surfaces it as a first-class `--by` dimension).
