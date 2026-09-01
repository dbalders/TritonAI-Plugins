# Local publication readiness checklist

## Framework changes

1. Confirm the intended source root and review all tracked and untracked changes.
2. Confirm the framework still supports a repository with zero plugins.
3. Confirm no marketplace, runtime-install, or unconsumed catalog semantics were added.
4. Run `pnpm install --frozen-lockfile --ignore-scripts` in a clean dependency state.
5. Run `pnpm artifacts:sdk`, review the sealed artifact diff, then run `pnpm readiness` and confirm
   the artifact check leaves the worktree unchanged.
6. Run `pnpm readiness:local` with a trusted, exact clean Harness worktree and its matching full
   commit SHA; confirm the installed server runtime matches its catalog, lockfile, patch, and pnpm
   realpath identity.
7. Review dependency advisories, licenses, lifecycle scripts, and lockfile changes.
8. Run structured review and the requested security review for the changed boundary.

## Plugin additions and updates

1. Confirm the manifest, package version, API/manifest contract, capabilities, skills, provider ID,
   and exact tool sets agree.
2. Confirm each authorization boundary has its own plugin and credential namespace.
3. Verify Harness v2 packages contain only declared documentation, manifest, skills, and reviewed
   compiled output. For SDK v1, verify `artifacts/<plugin-id>/` contains only the canonical
   descriptor and its exact declared payload inventory.
4. Run all provider tests plus deterministic package dry-runs.
5. Run the package's `contract:harness` proof for the exact `manifest`, synchronous
   `createIntegrationProvider` factory, provider export, exact tool set, and secret-store facade
   against the exact supported Harness head.
6. Prove the exact signed composition, source identity, and distribution digests; verify the private
   build input is keyed exactly by selected package IDs and each plugin rejects malformed
   configuration.
7. For providers with write tools, prove `connect`/`disconnect` recovery and `writeApproved` plus
   `beginCommit()` admission immediately before each remote mutation.
8. Complete secret scanning, structured review, and security validation for the full plugin diff.

Publication and release actions are manual owner decisions. Passing this checklist does not mean the
repository is published, deployed, signed, bundled, or penetration-tested.
