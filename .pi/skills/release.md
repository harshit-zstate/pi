---
name: release
description: Prepare, publish, verify, and recover pi releases. Use for release preparation, local release smoke tests, publishing, and failed release CI.
---

# Releasing pi

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

   Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow. Start each release binary from `/tmp`, not the repo root.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   If the test suite already passed in `npm run release:local` and only fails from machine load, `PI_RELEASE_SKIP_TESTS=1` skips `./test.sh` in the release script; checks and the packed install check still run. Use it only with the user's approval.

   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or install lock diffs the release creates before push.

   The release script pins the newest published model catalog for Nix (`nix/model-catalog.json`) and builds the checkout with it as the Nix build does (it fails if that catalog predates main's model changes; publish one first), bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI builds the GitHub Release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml` on https://github.com/harshit-zstate/pi. It builds the Linux x64 and arm64 binaries and smoke-tests each on a native Ubuntu runner (including the tool-folder smoke test), while `verify-and-pack` builds, checks, and tests the workspace and packs every public package with `scripts/pack-packages.mjs`. `publish-github-release` then creates the release with the binaries, tarballs, and `SHA256SUMS` and publishes it; a failed upload deletes the draft. A tag push needs Actions enabled for the repository; otherwise dispatch the workflow with `gh workflow run build-binaries.yml -f tag=vX.Y.Z`. Nothing is published to npm. Installed builds check `releases/latest` of this repository for updates, and `pi update` links to the release.

5. **CI builds the Nix release**: the tag push also triggers `.github/workflows/nix.yml`, which builds the tagged flake on Linux and macOS and then fast-forwards the `stable` branch to the release commit. `nix run github:harshit-zstate/pi/stable` runs the latest release. If the Nix build fails, `stable` stays on the previous release; the tag cannot be fixed, so fix `main` and ship the fix in the next release.

6. **If CI fails**: inspect the failed job, fix the cause on `main`, and rerun the workflow for the tag with `workflow_dispatch` (`tag`, and `source_ref` for a fixed commit). A published release is never mutated. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.
