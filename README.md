# TritonAI Plugins

Framework, versioned plugin SDKs, and curated source packages for TritonAI Harness.

Created and maintained by David Balderston for UC San Diego.

Legacy Harness v2 and SDK1 packages are trusted backend components, not isolated workers.
SDK2 packages require a separate host-owned credential/operation broker and verified native isolation. A Harness build pins
an immutable commit or tag from this repository and includes only packages named by its exact signed
composition and digest allowlist. Provider construction stays inside each selected package through
its reviewed `dist/index.js` entrypoint. Users can enable or disable an included plugin and its
skills; they cannot download or install runtime code.

## Broker SDK2 compatibility

Kuali Build 2.0.0 and synthetic-api-key 2.0.0 use `tritonai.plugin/v2` and sealed artifact v2.
Their workers receive no credentials or direct network APIs. Host-owned lifecycle, independently
reviewed recipe digests, exact admitted tool payloads and F05 commit receipts remain authoritative.
Older hosts must reject these packages; SDK1 and legacy Effect providers remain unchanged and are
not sandbox compatible. This is a package implementation, with host integration and native
acceptance still required. See [the contract](docs/decisions/0002-broker-sdk-v2.md).

## Repository contract

Each direct child of `plugins/` is an independent package. A plugin may contribute skills only, or
it may also provide server-side tools through the Harness provider contract. Harness v2 production
packages must include:

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

For legacy packages, manifest `apiVersion` and `manifestVersion` identify the Harness v2 contract. That contract
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

## UCSD Assistant

The [UCSD Assistant plugin](plugins/ucsd-assistant/README.md) searches public campus sources directly,
with a source catalog, public support-article search, original-page reading and anonymous maps,
Walking/ADA routing and busyness tools. It requires no sign-in or Onyx connection. Its skills run
broader source searches with the session's available web search or browser.

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

CI runs the same `contract:harness` proof for both reviewed release commits pinned in
`.github/workflows/ci.yml`: stable `v0.3.7` at
`65966171c1b6388d8bb6619369865ab2c8cf6ddb` and nightly `v0.3.8-nightly.20261014.78` at
`ef03a9e243b17b682b29f117585db5278878a318`. Each job installs the selected host's locked server
dependencies without lifecycle scripts and records the plugin and host commit identities in its
run summary. These are legacy compatibility baselines, not moving `latest` refs. They do not implement SDK2;
a positive full-host contract gate remains incomplete until a reviewed broker-capable host is pinned. Update each release label
and full commit together after verifying the published tag resolves to that trusted commit; rerun
the proof before accepting a new baseline. A newer host remains unverified until its pin advances.

The regular test gate also exercises the packaged Jira provider through real local HTTP requests
with separate READ-only and WRITE OAuth grants. The server enforces READ method restrictions, so
a regression to POST-based search fails even when the same operation works with a WRITE grant.
This proves the packaged provider's scoped HTTP behavior; it does not prove live tenant access,
OAuth consent, or a released Harness connection. Live verification must use an existing authorized
connection without printing credentials or creating production records.

Publication, GitHub repository creation, tags, pushes, Harness composition, and releases remain
explicit owner actions.

## Additive plugin SDK v1

`@tritonai/plugin-sdk` defines an Effect-free ABI using only promises, `AbortSignal`, readonly
plain objects, JSON values and tagged structural failures. Its strict `tritonai.plugin/v1`
manifest in `.tritonai-plugin/plugin.json` carries inline draft 2020-12 configuration and input
schemas, skills, SDK API major, and minimum host contract level. The factory module has one stable export:
`createIntegrationProvider`.

Builds produce a sealed Node 24 ESM directory with one reviewed `plugin.mjs`, declared skill files,
canonical manifest and canonical `artifact.json`. Release-ready bytes are committed at
`artifacts/<plugin-id>/`; `pnpm artifacts:sdk` refreshes them and `pnpm artifacts:sdk:check` proves
they exactly match source. Third-party code is bundled; static `node:`
imports are enumerated in the descriptor. The descriptor binds every payload byte, target,
configuration schema, and input schema by SHA-256. The verifier checks the complete inventory and
compatibility before importing executable code. Curated providers retain backend-code trust: this
integrity check is not a JavaScript sandbox or a dynamic-loading policy. `plugins/synthetic-readonly`
is the dependency-free conformance example.
