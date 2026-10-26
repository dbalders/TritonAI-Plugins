# Broker SDK2 and separately reviewed host recipes

SDK1's secret facade and legacy Effect factories execute with raw credentials and direct network
access. Neither is compatible with a worker that must have no credential or network authority.
SDK2 is additive to the SDK exports and replaces the ABI of each migrated package. Replacing SDK1
in place would let older hosts silently supply the wrong authority. Older hosts must reject SDK2;
there is no backend import, same-user subprocess or raw-secret fallback.

`@tritonai/plugin-sdk/broker` defines `tritonai.plugin/v2` (manifestVersion 2, SDK major 2, host
contract level >=3) and `tritonai.plugin-broker/v1`. The import-free worker factory receives only
`{configuration, broker}` and returns `id`, `invoke(toolName, input, {signal})` and optional `close`.
It does not receive connection submissions, credential storage, token responses, write approval
booleans or a commit callback. Host-owned connect/poll/status/disconnect owns API-key submissions,
OAuth PKCE/state/nonce, exchange/refresh/revocation, capability grants and credential migration.
Workers may see sanitized connection status and opaque flow handles; never tokens or API keys.

Each tool binds to one reviewed operation `<exact-tool-name>.v1`. Parameters are the exact original
admitted tool input, including confirmation fields, rather than a worker-selected request body.
The host validates the exact tool schema and canonical input digest before evaluating a recipe.
A manifest/recipe is a dependency declaration. The host separately pins its reviewed policy digest
and operation inventory; a plugin release, signature or increased version cannot grant authority.

The host binds plugin, connection and credential generations, worker generation, artifact/descriptor
and policy digests to the inherited pipe. It binds invocation/tool/argument digest, complete F05
approved payload and target, and durable commit receipt to its active invocation. No worker field
selects any of those identities. Initially only one invocation and one broker operation may be
active per channel. Repeated, unknown, stale, cancelled, mismatched or post-exit work fails closed.

## Wire

Frames contain a four-byte unsigned big-endian UTF-8 JSON byte length and at most 524288 payload
bytes. Hosts check length before allocation/parsing, then UTF-8, JSON depth/node/member/string
bounds. Unknown keys fail. Request IDs increase strictly from 1 through 2147483647 per worker
channel; no retry/replay or wrap. The host owns timeout, cancellation, termination and aggregate
quotas outside the worker.

```json
{
  "protocol": "tritonai.plugin-broker/v1",
  "requestId": 1,
  "kind": "operation",
  "operationId": "kuali-build.apps.get.v1",
  "parameters": { "appId": "5d5f337395a039001e48a649" }
}
```

Responses contain `protocol`, `requestId` and either `kind: "result", value: <JSON>` or
`kind: "error", error: {code, message, outcome: "not_dispatched" | "unknown"}`. Errors are bounded,
host-sanitized and contain no raw provider body or token response. The SDK helper correlates
responses and closes its channel after an error; reconnection requires a new host-admitted worker.
Worker output cannot settle the host's commit journal or hide a transport failure. Cancellation or
loss after possible remote acceptance stays unknown, with no automatic retry. A consumed F05
receipt cannot admit a new write after a worker restart.

## Declarative host recipe

The canonical `.tritonai-plugin/broker-policy.json` is hash-bound in the SDK2 artifact. It declares
fixed destination, method, credential placement, limits, known query documents and bounded input
bindings. It contains no JavaScript, arbitrary headers, URL input, token/secret names, generic
fetch, remote RPC proxy or worker-controlled GraphQL. Bindings are `{literal: <JSON>}` or
`{input: <tool property>, default?: <JSON>, transform?: <known enum>}`. `$` means the complete
original input only for the known `kuali-document-filters` transform. No expressions are evaluated.

Kuali's known transforms are lowercase hexadecimal IDs, safe form-key normalization, and document
filters. The host must repeat the bounded form-data constraints, reject prototype/double-normalized
keys and unconfirmed nulls, and normalize only the optional `data.` key prefix. The worker retains
input guards and output projections for correctness, but its checks grant no authority.

Kuali host preconditions are fixed known operations performed before F05 commit admission:

- `kuali-document-version`: read the exact document's `id meta`, require matching ID and usable
  `meta.updatedAt` equal to the original `expectedUpdatedAt`; never dispatch on missing/stale data.
- `kuali-app-exists`: read the exact app's `id name`, require the matching ID before initializing.
- `kuali-draft-binding`: read the exact action's `id appId document { id }`, require matching action
  and document IDs before submission.

These guards are host observations. A worker cannot substitute their results. The version check
remains best effort because Kuali has no documented atomic compare-and-set. Draft initialization,
resolution and submission remain separate operations. Never replay an ambiguous append/create.

The host alone attaches the selected connection credential, validates DNS/socket addresses, denies
redirects, ambient proxies and unapproved endpoints, and bounds responses before and after
decompression. A fixed origin alone does not authorize a different document or changed form data.
No provider JavaScript moves to the trusted host. Known recipe interpreters and precondition
implementations belong to the separately reviewed Harness host contract.

## Artifact and release admission

SDK2 uses `tritonai.plugin-artifact/v3`, artifactVersion 3 and host contract level 4.
Its `quickjs-wasm` runtime explicitly declares `tritonai.quickjs-wasm/v1`; the standalone Node
launcher has a separate compatibility field. This prevents a previously Node-targeted artifact
from being silently admitted to a different JavaScript engine. The provider and broker wire ABIs
remain SDK2 and broker v1. Hosts must reject unsupported profiles rather than infer support from
caller-supplied options.

The descriptor retains its hash-bound broker policy, canonical schema/file hashes and exact
inventory. The actual standalone launcher Node version must be supplied to verification; backend
Node compatibility is not evidence about a separate worker. The host independently pins its
interpreter and guest shim. Fixed Wasm memory does not establish a hard whole-process RSS limit.
Tool schemas and annotations remain equivalent to their prior canonical values.

The source/artifact dependency check rejects known ambient network/credential references and
imports as release hygiene. It is not malicious-code isolation. Hosts require a separately
verified native OS boundary before evaluating any provider bytes, plus source/build/artifact
provenance and an independently pinned policy. Unsupported ABI/platform/limits/policy/runtime
must disable execution without fallback. Signing a plugin does not expand policy authority.

This slice migrates synthetic-api-key and all Kuali Build tools. Jira, Tableau, n8n, Lucid, UCSD
Assistant and synthetic-readonly stay SDK1. GitHub, Microsoft 365 and Google Workspace stay legacy
Effect. They are not sandbox compatible. Their tool catalogs and prepare/apply bindings remain
unchanged; future migration must retain host-owned semantic plan binding rather than exposing
opaque worker-authored plans. Package fixtures prove contract behavior, not Harness integration,
OS confinement, live-provider access, OAuth consent, signed artifacts or release readiness.
