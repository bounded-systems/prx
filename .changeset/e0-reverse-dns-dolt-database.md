---
"@bounded-systems/prx": patch
---

dolt: canonical `dolt_database` naming standardized on the live reverse-DNS form `io_github_<owner>_<repo>` (D0 of GH-1685). `RepoSlug` now validates that shape (exported as `DOLT_DATABASE_NAME_PATTERN`), and a new `canonicalDoltDatabase()` derives it from a GitHub origin. The legacy `{host}__{owner}__{repo}` form is no longer accepted.
