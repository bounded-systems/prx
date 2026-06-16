---
---

`jsr-sync` reads a generated manifest (`jsr-manifest.generated.ts`) instead of the filesystem at runtime, clearing the CodeQL `js/file-access-to-http` finding by removing the file→network dataflow. Tooling/tests only, no package release.
