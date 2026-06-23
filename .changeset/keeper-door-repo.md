---
---

Pass `repo` to `importAndPush` (`runKeeperDoorPush`): door-kit 0.6.0 made `repo`
required on `ImportAndPushOptions` (door-keeper's `import-and-push` always required
it; the omission was a silent wire gap caught by the live chain e2e). Bumps the
door-kit dependency to ^0.6.0. No release.
