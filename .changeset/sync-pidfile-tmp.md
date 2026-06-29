---
---

Use a private `mkdtempSync` temp dir for pidfile paths in the sync serve tests
instead of predictable `/tmp/*.pid` strings (clears CodeQL alert #60,
`js/insecure-temporary-file`). Test-only — fs is mocked, no release.
