# Architecture and consumption

## Source layout

Each direct child of `plugins/` is one versioned Harness package. A package contains its strict v2
manifest, Codex skills, optional provider source and tests, compiled distribution files when needed,
and package security documentation. The root framework permits zero plugins so its initial commit
and infrastructure can be reviewed independently.

Repository validation rejects path and version drift, symlinks and special files, malformed skill
frontmatter, unsafe package file lists, source or tests in release tarballs, and undeclared package
shapes. Provider distribution files are reviewed artifacts: packaging compares their bytes to the
working tree and rejects lifecycle-script mutations. Packaging is repeated and hashed to catch
nondeterministic output.

There is intentionally no `marketplace.json`, network catalog, installer, dynamic module loader,
update endpoint, or runtime download path. A catalog file should be added only with a real
deterministic build consumer and schema validation.

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

Every provider PR must expose its exact validated manifest from the compiled module and define a
`contract:harness` script that proves its synchronous factory, provider export, and exact tool set
are structurally assignable to the Harness checkout named by `TRITONAI_HARNESS_ROOT` at the exact
`TRITONAI_HARNESS_COMMIT`. Composition proofs continue to pin the exact source identity, selected
packages, and distribution digests.
