---
"@bounded-systems/prx": patch
---

Add the correctness core of the bd→GH push-leg short-circuit (GH-296, prx-lzw): pure, tested decisions (`shouldSkipPush`, `pushFullySucceeded`, `advanceLastPushedHead`) that let the reconcile skip the push leg — and its GitHub write requests — when the bead store (the daemon's dolt HEAD etag) hasn't moved since the last *successful* push. Retry-safe: a deferred (`--limit`) or errored push never advances the watermark, so transient failures retry rather than being skipped forever. The `runBeadsSync` wiring (read the etag, persist the watermark) is a thin follow-up over these.
