# Local publication readiness checklist

## Framework changes

1. Confirm the intended source root and review all tracked and untracked changes.
2. Confirm the framework still supports a repository with zero plugins.
3. Confirm no marketplace, runtime-install, or unconsumed catalog semantics were added.
4. Run `pnpm install --frozen-lockfile --ignore-scripts` in a clean dependency state.
5. Run `pnpm readiness`.
6. Update `scripts/reviewed-harness.mjs` to the reviewed Harness head, then run
   `pnpm readiness:local` with both that exact clean worktree and matching commit SHA.
7. Review dependency advisories, licenses, lifecycle scripts, and lockfile changes.
8. Run structured review and the requested security review for the changed boundary.

## Plugin additions and updates

1. Confirm the manifest, package version, API/manifest contract, capabilities, skills, provider ID,
   and exact tool sets agree.
2. Confirm each authorization boundary has its own plugin and credential namespace.
3. Verify the package contains only declared documentation, manifest, skills, and reviewed compiled
   output; source and tests must not ship, and `prepack` must not change the compiled bytes.
4. Run all provider tests plus deterministic package dry-runs.
5. Run the package's `contract:harness` proof for the provider export, exact tool set, and
   secret-store facade against the exact supported Harness head.
6. Prove the Harness-owned catalog descriptor, deployment configuration, and lifecycle composition.
7. Complete secret scanning, structured review, and security validation for the full plugin diff.

Publication and release actions are manual owner decisions. Passing this checklist does not mean the
repository is published, deployed, signed, bundled, or penetration-tested.
