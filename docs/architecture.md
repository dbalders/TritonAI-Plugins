# Architecture and consumption

The SDK trust and compatibility decision is recorded in
[`decisions/0001-plugin-sdk-v1.md`](decisions/0001-plugin-sdk-v1.md).

## Source layout

Each direct child of `plugins/` is one versioned package. Existing packages use the strict Harness
v2 contract. New portable packages may use the additive plugin SDK v1 contract and sealed artifact
format. The two manifest versions have distinct `apiVersion` values and validation paths.

Repository validation rejects path and version drift, symlinks and special files, malformed skill
frontmatter, unsafe package file lists, source or tests in release tarballs, and undeclared package
shapes. Provider distribution files are reviewed artifacts: packaging compares their bytes to the
working tree and rejects lifecycle-script mutations. Packaging is repeated and hashed to catch
nondeterministic output.

There is intentionally no `marketplace.json`, network catalog, installer integration, update
endpoint, or runtime download path. The SDK verifier is a reference artifact admission primitive,
not Harness wiring. A catalog file should be added only with a real deterministic build consumer
and schema validation.

## Build-time composition

```text
immutable TritonAI-Plugins ref
  -> exact signed package composition and digest allowlist
  -> strict manifest, skill, provider, and package validation
  -> reviewed dist/index.js entrypoint inclusion
  -> package-scoped secrets and opaque private build configuration
  -> synchronous package-owned provider construction
  -> immutable in-process catalog
  -> user enable/disable and capability controls
```

Every provider entrypoint exports the exact validated `manifest` and a synchronous
`createIntegrationProvider({ secrets, configuration })` factory. Harness deep-compares that
manifest with the composed package and passes only the package-scoped secret-store facade and the
package's opaque configuration object. The plugin owns the configuration schema, validation, and
provider construction. The complete catalog exists before registry startup; runtime registration
remains a non-goal.

## Contract and versioning

Manifest `apiVersion` and `manifestVersion` select the one current package contract. Package
semantic version tracks plugin behavior and assets. Breaking provider ABI or trust-boundary changes
require a new Harness contract version or a jointly reviewed source change and contract proof.

Harness owns exact composition and digest validation plus the generic registry, lifecycle,
secret-store, RPC, MCP, and installer boundaries. Plugins own their provider implementation,
construction, configuration validation, and provider-specific recovery behavior. Providers that
declare write tools implement `connect` and `disconnect`; each write invocation requires
`writeApproved` and `beginCommit()` admission immediately before its fixed mutation.

Provider packages declare only the shared Effect peer range and keep beta.102 as their exact local
development baseline. Contract verification derives the Harness server's Effect runtime from the
workspace catalog, importer, package and snapshot keys, patch metadata, installed package version,
and exact pnpm realpath. Compatible runtime updates inside the peer range do not change plugin
identity; incompatible versions, additional production/private/optional/bundled dependencies, and
dependency aliases fail closed for every provider plugin.

Every provider PR must expose its exact validated manifest from the compiled module and define a
`contract:harness` script that proves its synchronous factory, provider export, and exact tool set
are structurally assignable to the Harness checkout named by `TRITONAI_HARNESS_ROOT` at the exact
`TRITONAI_HARNESS_COMMIT`. Composition proofs continue to pin the exact source identity, selected
packages, and distribution digests.

The checkout path and commit are trusted maintainer inputs because verification imports code from
that checkout. Exact-commit and clean-tree enforcement proves immutability for the verification run,
not repository provenance or safety of caller-selected code.

## Plugin SDK v1 boundary

The SDK v1 public surface has no Effect types or runtime dependency. It uses promises,
`AbortSignal`, readonly JSON-compatible objects, bounded self-contained inline JSON Schema draft
2020-12 data, and tagged structural failures. The SDK performs structural preflight; Harness owns
authoritative schema compilation before provider import. Secret methods are asynchronous and
injected through a package-scoped facade. Write invocations and credential-mutating lifecycle work
receive a host-controlled `beginCommit()` gate. If a commit
may have reached the external system but cannot be confirmed, providers return the non-retryable
`external_commit_outcome_unknown` failure; blind replay is not safe.

SDK API major is an exact ABI selector. `requiredHostContractLevel` is monotonic: a host may load a
plugin at or below its implemented level, but rejects newer requirements. Provider status,
connection lifecycle, invocation and closure are Promise-based. Logging, network clients, update
catalogs and process isolation are deliberately outside v1.

The builder inspects the full source tree, then emits the canonical manifest, declared skills and
one reviewed Node 24 ESM entry. It rejects links, special and native-addon files, traversal,
duplicate or case-colliding paths, lifecycle installers, unresolved static ESM dependencies,
dynamic imports, and bounded-size violations. Third-party helpers are bundled; static `node:`
imports are bound in the descriptor. `artifact.json` has no timestamp or environment-dependent field; it
records the sorted payload inventory with byte sizes and SHA-256, exact runtime target, and
canonical schema digests. Verification repeats every check, retains the verified entry bytes,
validates compatibility, and imports those bytes only after admission. Artifact admission remains
a host responsibility; verification does not sandbox trusted plugin code or police dynamic access
through JavaScript runtime globals after import.
