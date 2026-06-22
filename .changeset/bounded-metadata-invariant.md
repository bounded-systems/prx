---
---

Add an architecture test asserting every `@bounded-systems/*` package carries a
well-formed `bounded` block — `kind` ∈ {door, room, guest} and `tagline` equal
to the package `description`. Turns the seam-metadata convention (#711) into an
enforced invariant so a new package can't ship without it and the site never
falls back to a stale seed copy. Test only: no API or behavior change, no release.
