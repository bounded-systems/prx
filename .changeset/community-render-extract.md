---
---

internal refactor: extract community-health rendering into a reusable, binary-safe
src/community/build.ts (renderCommunityTargets), shared by the render-community
script. Prepares the `prx docs` verb. No output change (byte-identical), no package change.
