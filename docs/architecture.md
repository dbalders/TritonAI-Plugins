# Architecture and consumption

## Source layout

Each direct child of `plugins/` is one versioned Harness package. A package contains its strict v1
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
  -> Harness-owned package selection and source inclusion
  -> strict manifest, skill, provider, and package validation
  -> package-scoped secrets and deployment configuration injection
  -> immutable in-process catalog
  -> user enable/disable and capability controls
```

The Harness descriptor constructs an `IntegrationPackage` containing the validated manifest,
optional provider instance, and source root or deterministic bundled files. The complete catalog
exists before registry startup. Runtime registration is a non-goal.

## Contract and versioning

Manifest `apiVersion` and `manifestVersion` select the one current package contract. Package
semantic version tracks plugin behavior and assets. Breaking provider ABI or trust-boundary changes
require a new Harness contract version or a jointly reviewed source change and contract proof.

Harness owns the final structural assignment and static catalog adapter. Generic registry,
lifecycle, secret-store, RPC, MCP, and installer changes remain in Harness, not in individual
plugins.

Every provider PR must expose its exact validated manifest from the compiled module and define a
`contract:harness` script that proves its provider export and exact tool set are structurally
assignable to the Harness checkout named by `TRITONAI_HARNESS_ROOT` at the exact
`TRITONAI_HARNESS_COMMIT`. It must also include focused
Harness-owned composition tests for any lifecycle extension it needs.
