# TritonAI Plugins

Framework and curated source packages for TritonAI Harness plugins. The foundation intentionally
contains no production plugins; each plugin is introduced through its own reviewed change.

These are trusted Harness backend components, not Codex marketplace packages. A Harness build pins
an immutable commit or tag from this repository, includes selected plugin packages in its build,
and constructs providers through Harness-owned catalog descriptors. Users can enable or disable an
included plugin and its skills; they cannot download or install runtime code.

## Repository contract

Each direct child of `plugins/` is an independent package. A plugin may contribute skills only, or
it may also provide server-side tools through the Harness provider contract. Production packages
must include:

- a strict `.tritonai-plugin/plugin.json` Harness v2 manifest;
- package and manifest versions that agree;
- normal Codex skills under `skills/` when skills are declared;
- a narrow compiled provider export under `dist/` when tools are declared; and
- package-specific README and security documentation.

Provider code receives a package-scoped secret-store facade. Skills and tool descriptions are user
guidance, not authorization boundaries. The Harness remains responsible for plugin enablement,
capability grants, exact tool allowlisting, executable input decoding, lifecycle admission, and
runtime cancellation.

See [architecture.md](docs/architecture.md), [release-checklist.md](docs/release-checklist.md), and
[SECURITY.md](SECURITY.md).

## Harness v2 contract

Manifest `apiVersion` and `manifestVersion` identify the one current Harness contract. That contract
owns capability access policy, catalog, package-scoped secrets, lifecycle, skill materialization,
write approval, and tool invocation. Provider packages prove structural conformance against a
clean Harness checkout at the repository-owned commit in `scripts/reviewed-harness.mjs`, while the
Harness build owns final composition. The current reviewed target is Harness PR #89 at
`576772545954ef7e131bc4528aa520f190ec262f`.

This foundation validates the generic Harness v2 boundary but deliberately makes no claim about a
production provider. A provider plugin must commit its reviewed `dist/` output, export its exact
validated manifest as `manifest`, and define a `contract:harness` script. The script must prove
the provider export and declared tool set against `TRITONAI_HARNESS_ROOT` at
`TRITONAI_HARNESS_COMMIT`; `readiness:local` runs it against that exact clean Harness checkout. A
plugin PR must also add its Harness-owned composition proof.

## Local verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm readiness
TRITONAI_HARNESS_ROOT=/path/to/pinned-harness \
TRITONAI_HARNESS_COMMIT=<full-reviewed-commit-sha> \
pnpm readiness:local
```

`readiness` supports both an empty foundation and populated plugin workspaces. It checks formatting,
lint, repository/package structure, workspace typechecks, plugin tests, and deterministic package
contents. `readiness:local` additionally requires the expected Harness commit to match the
repository-owned pin, checks a clean Harness worktree at that exact commit, and reports the commit
used for the proof.

Publication, GitHub repository creation, tags, pushes, Harness composition, and releases remain
explicit owner actions.
