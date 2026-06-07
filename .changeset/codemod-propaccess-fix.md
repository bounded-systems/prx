---
---

tooling: fix `extract-module` carrying a spurious import when a moved block uses
a same-named *member* (e.g. `.join()` while the source imports `join`). The
used-identifier scan now excludes the name side of property accesses, qualified
type names, and property/method declaration names, so only true free references
carry their imports. No package change.
