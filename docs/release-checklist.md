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
9. Run `pnpm smoke:live` on the release commit (see below) and confirm every Google Workspace and
   Microsoft 365 tool passes or is skipped for a stated reason.

## Live read-only smoke

Provider tests use canned responses, so they pass whatever the outgoing request looks like.
`pnpm smoke:live` (optionally `--plugin google-workspace` or `--plugin microsoft-365`) loads each
plugin's committed `dist/index.js` from this checkout and calls every manifest read tool once
against the account already connected in a local TritonAI Harness desktop app. Run it on a Mac
where the plugin is connected in the stable or nightly Harness; it is not a CI job.

- **Read-only, structurally.** It invokes only tools the manifest marks `effect: "read"` and the
  provider marks read-only, and `tests/live-smoke.test.mjs` fails when a read tool has no smoke
  input. Every outgoing request other than GET/HEAD is refused, except an OAuth token refresh. The
  Microsoft 365 mail-move probe runs the move's read-only folder check, then must be refused at the
  move request itself; its message id does not exist.
- **Inputs** are bounded: small result limits, a short calendar window, and samples (a Doc, a
  message with an attachment, a file under 256 KB) taken from earlier list results. A tool whose
  sample does not exist in the account, or whose capability is not granted, is skipped.
- **Output** is one line per tool: PASS, FAIL or SKIP, with HTTP status, host, provider error code
  and the provider's fixed public error sentence. Results stay in memory and are never printed.
- **Credentials.** The script reads `integration-<plugin>--oauth` from that Harness profile's
  encrypted secret store and the plugin's build configuration from the installed app bundle. macOS
  asks for Keychain access to "TritonAI Harness Safe Storage" on each run; choose **Allow**, not
  **Always Allow**. A refreshed token stays in memory and is never written back to Harness.

Tradeoff: unwrapping the Harness data key gives the script process access to every Harness secret
on that Mac for the run, and the approach is macOS-only. The alternative is a Harness-side command
that runs a supplied provider inside the server with its own secret store; that is a larger
cross-repository change and is not built yet.

Publication and release actions are manual owner decisions. Passing this checklist does not mean the
repository is published, deployed, signed, bundled, or penetration-tested.
