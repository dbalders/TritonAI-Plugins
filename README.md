# TritonAI Plugins

Framework and curated source packages for TritonAI Harness plugins. The root framework supports
zero plugins; each production package is introduced through its own reviewed change.

These are trusted Harness backend components, not Codex marketplace packages. A Harness build pins
an immutable commit or tag from this repository and includes only packages named by its exact signed
composition and digest allowlist. Provider construction stays inside each selected package through
its reviewed `dist/index.js` entrypoint. Users can enable or disable an included plugin and its
skills; they cannot download or install runtime code.

## Repository contract

Each direct child of `plugins/` is an independent package. A plugin may contribute skills only, or
it may also provide server-side tools through the Harness provider contract. Production packages
must include:

- a strict `.tritonai-plugin/plugin.json` Harness v2 manifest;
- package and manifest versions that agree;
- normal Codex skills under `skills/` when skills are declared;
- a compiled `dist/index.js` export of the exact `manifest` and, when a provider is declared, a
  synchronous `createIntegrationProvider({ secrets, configuration })` factory; and
- package-specific README and security documentation.

Provider code receives a package-scoped secret-store facade. Skills and tool descriptions are user
guidance, not authorization boundaries. The Harness remains responsible for plugin enablement,
capability grants, exact tool allowlisting, executable input decoding, lifecycle admission, write
commit admission, and runtime cancellation. Each plugin owns provider construction and exact
validation of its opaque build configuration.

See [architecture.md](docs/architecture.md), [release-checklist.md](docs/release-checklist.md), and
[SECURITY.md](SECURITY.md).

## Harness v2 contract

Manifest `apiVersion` and `manifestVersion` identify the one current Harness contract. That contract
owns capability access policy, catalog, package-scoped secrets, lifecycle, skill materialization,
write approval, and tool invocation. Provider packages prove structural conformance against a
caller-selected trusted Harness checkout at one exact clean commit, while the Harness build owns
final composition. Compatible Harness Effect updates inside the shared provider peer range do not
change an immutable plugin package or require a plugin release solely to repeat a Harness SHA.

A provider plugin must commit its reviewed `dist/` output and export its exact validated manifest as
`manifest` plus its synchronous `createIntegrationProvider({ secrets, configuration })` factory.
The Harness passes the factory only a package-scoped secret-store facade and that package's opaque
configuration object from the private, package-ID-keyed build input. The plugin rejects missing,
extra, or malformed configuration itself. Its `contract:harness` script must prove the entrypoint
and declared tool set against `TRITONAI_HARNESS_ROOT` at `TRITONAI_HARNESS_COMMIT`;
`readiness:local` runs it against that exact clean Harness checkout. Exact composition, source
identity, and distribution digests remain build allowlists rather than runtime discovery.

Contract verification imports and executes modules from `TRITONAI_HARNESS_ROOT`. The caller must
therefore select a maintainer-reviewed, trusted TritonAI-Harness checkout. The full commit and clean
worktree checks prove that one immutable input was used; they do not establish repository
provenance or make an untrusted checkout safe.

## Local verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm readiness
TRITONAI_HARNESS_ROOT=/path/to/trusted-clean-harness \
TRITONAI_HARNESS_COMMIT=<full-trusted-commit-sha> \
pnpm readiness:local
```

`readiness` supports both an empty foundation and populated plugin workspaces. It checks formatting,
lint, repository/package structure, workspace typechecks, plugin tests, and deterministic package
contents. `readiness:local` additionally checks the caller-supplied trusted Harness worktree at the
exact supplied commit, binds the server's installed Effect package to its catalog, lockfile patch,
snapshot, and pnpm realpath identity, and reports the commit used for the proof.

Publication, GitHub repository creation, tags, pushes, Harness composition, and releases remain
explicit owner actions.
