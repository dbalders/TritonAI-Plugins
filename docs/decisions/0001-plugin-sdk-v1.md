# Plugin SDK v1

Status: accepted for platform implementation

## Decision

New curated integration providers use an additive, Effect-free ABI from
`@tritonai/plugin-sdk`. Existing Harness v2 packages remain unchanged during migration.

The public boundary is limited to readonly JSON-compatible data, `Promise`, `AbortSignal`, a
package-scoped string secret store, structural errors, and provider lifecycle methods. SDK API
major selects the ABI; `requiredHostContractLevel` is a monotonic feature floor. Harness versions
are not part of compatibility.

Each plugin ships as one deterministic Node 24 ESM artifact. Third-party dependencies are bundled;
remaining `node:` imports are explicit descriptor data. The canonical descriptor binds the
manifest, entry, skills, configuration schema, tool schemas, runtime target, SDK requirement, and
every payload byte. Harness privately imports retained verified bytes only after compatibility and
schema compilation succeed.

Production approval is separate policy. A later catalog change will bind publisher, plugin ID,
deployment policy, and the exact artifact-descriptor digest. Source presence alone never approves
a plugin.

## Safety rules

- SDK schema validation is bounded structural preflight, not a second JSON Schema engine. Harness
  compiles the exact descriptor-bound schemas before importing plugin code.
- `beginCommit()` marks the host-admitted external commit boundary. Write tools additionally require
  user approval; credential maintenance does not inherit that approval. No operation is retried
  after commit admission when the external outcome may be unknown.
- Provider code runs only in the trusted server/Electron-main runtime. It never runs in renderer or
  preload code.
- Curated plugins have backend-code trust. Artifact integrity and review do not provide a sandbox.
- A malformed artifact or provider is quarantined without preventing core application startup.

## Consequences

Ordinary plugin additions can become package plus policy changes with no plugin-specific Harness or
Installer implementation. OAuth and MCP helpers remain separately versioned, fully bundled, and
experimental until an independent second consumer proves their boundary.

Runtime downloads, user-supplied plugins, hot loading, native addons, a service container, and a
general dependency resolver remain out of scope.
