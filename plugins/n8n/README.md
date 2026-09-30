# n8n

`@tritonai/plugin-n8n` is the first production integration built on the TritonAI Plugin SDK. It
connects TritonAI Harness to UC San Diego's remote n8n MCP server without n8n-specific Harness or
Installer code. n8n owns workflow behavior and authorization; this package owns browser OAuth,
PKCE, the reviewed tool surface, input validation, and bounded Streamable HTTP transport.

Each user signs in to n8n in their system browser. The provider uses OAuth discovery and dynamic
client registration, requests the reviewed Read and Write scope ceiling, and stores tokens only
through the SDK's package-scoped secret facade. The user's n8n consent choice is authoritative:
Read only grants the complete read bundle, while All grants Read and Write. Harness reflects that
grant instead of offering a competing capability switch. There is no API key, shared account,
client secret, embedded browser, generic REST client, or n8n API reimplementation.

## Configuration

The reviewed endpoint is declared in the sealed SDK manifest:

The factory accepts exactly `https://n8n.tritonai.ucsd.edu/mcp-server/http`, rejects extra
configuration, and keeps OAuth discovery and all advertised endpoints on that origin.

The n8n instance administrator must add `http://127.0.0.1/oauth2/callback` under
**Settings → Instance-level MCP → Allowed OAuth Redirect URLs**. The provider uses an ephemeral
loopback port for each sign-in; n8n permits that varying port while still matching the callback's
scheme, host, and path. Without this entry, n8n rejects authorization with
`Redirect URI not in allowed list` before the user can approve access.

## Access model

The provider requests every reviewed scope the instance advertises, and the user's n8n consent
choice is authoritative. n8n lets the user approve all of them, Read only, or any narrower subset;
Harness reports Read when any read scope was granted and Write when any write scope was, and n8n's
own tool list decides which individual tools that grant unlocks. n8n remains the resource-level RBAC
boundary. The SDK host still requires explicit approval and one commit admission before every
mutating call, including workflow execution, Agent chat, publishing, and community-node installs.

Read covers workflows, executions, projects, folders, tags, credential metadata, node references,
Data Tables, Agents, instance activity, and saved building preferences. Write adds workflow
execution, creation, updates, publishing, and archiving; folder and Data Table changes; building,
publishing, and chatting with Agents; and installing verified community nodes.

## Upstream catalog

The package reviews all 60 tools exposed by n8n 2.41.3. `src/upstream-tools.ts` pins that release's
tool catalog. The 33 long-standing tools keep hand-written, tighter-bounded schemas; newer tools are
decoded directly from the pinned upstream schemas. Tests hold every reviewed tool to the pinned
catalog.

Every connection initializes Streamable HTTP and compares each returned upstream name, input-schema
shape, and effect hint against the reviewed catalog before proxying a call. The comparison degrades
per tool so the connection survives an n8n upgrade:

- Scopes n8n adds later are ignored, and reviewed scopes it stops advertising are skipped.
- Tools n8n adds later stay unavailable until a plugin update reviews them.
- A reviewed tool whose schema or effect hints changed is paused on its own and listed in the
  connection status. The rest keep working.

To review a new n8n release, run it with MCP enabled, recapture the catalog, and let the tests point
at the differences:

```sh
N8N_MCP_URL=http://localhost:5678/mcp-server/http N8N_MCP_TOKEN=<instance MCP API key> \
  N8N_VERSION=<version> node scripts/capture-upstream-tools.mjs
pnpm --filter @tritonai/plugin-n8n test
```

An instance-level MCP API key lists every registered tool. Some tools register only when their
feature is on (the agents module, the folders license, instance activity, verified community
packages, and AI preferences), so enable those on the capture instance.

## Validation

```sh
pnpm --filter @tritonai/plugin-n8n typecheck
pnpm --filter @tritonai/plugin-n8n test
pnpm --filter @tritonai/plugin-n8n build
pnpm readiness
```
