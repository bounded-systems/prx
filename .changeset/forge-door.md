---
"@bounded-systems/prx": minor
---

Runtime door serves the prx-forge bucket (prx-zee7 Phase 4). broker-config now REQUIRES PRX_GH_INSTALLATION_ID when an app is configured (no default — each bucket app has its own installation; the union app was split). ghappd-box reads the installation from /run/secrets/ghapp-installation too, so one image serves any bucket (the mounts pick the app). ghappd-room retargets to prx-forge (host secrets prx-forge-key/id/installation), making the runtime ambient GH_TOKEN least-privilege forge scopes instead of the broad union app.
