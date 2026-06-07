---
---

internal cleanup: add `prx docs --only <target>` and retire the 5 doc generator
scripts (gen-jsonld/gen-readme/gen-cli-docs/gen-claude-context/render-community).
Per-target npm scripts (jsonld/readme/cli/claude-context/community :render/:check)
now run the verb. No package version change.
