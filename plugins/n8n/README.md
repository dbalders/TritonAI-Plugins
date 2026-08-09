# n8n

`@tritonai/plugin-n8n` connects TritonAI Harness directly to UC San Diego's remote n8n MCP
server. It is a thin proxy: n8n owns workflow behavior and authorization, while this package owns
browser OAuth, PKCE, token storage, the reviewed tool surface, input validation, write admission,
and bounded Streamable HTTP transport.

Each user signs in to n8n in their system browser. The provider uses OAuth discovery and dynamic
client registration, requests every currently reviewed instance-MCP scope, and stores tokens only
in the Harness package-scoped encrypted secret store. There is no API key, shared account, client
secret, embedded browser, generic REST client, or n8n API reimplementation.

## Configuration

The endpoint is configuration, not provider code. The production Harness build should supply:

```text
TRITONAI_PLUGIN_CONFIGURATION_JSON={"n8n":{"serverUrl":"https://n8n.tritonai.ucsd.edu/mcp-server/http"}}
```

The factory accepts exactly one reviewed HTTPS `serverUrl`, rejects credentials, query strings,
fragments, and unsafe URL forms, and keeps OAuth discovery and all advertised endpoints on that
origin.

## Access model

All nine capabilities are enabled by default. “Full access” means the complete reviewed MCP
surface that the connected n8n user and their n8n role can access. n8n remains the resource-level
RBAC boundary. Harness still requires task write approval and commit admission before execute,
create, update, publish, archive, data-table write, or other mutating calls.

The package pins the 34 tools exposed by the reviewed UC San Diego n8n 2.34.1 deployment. Every
connection initializes Streamable HTTP and verifies every returned upstream name and input-schema
shape before proxying a call. A user's scopes or disabled instance feature can produce a reviewed
subset. Unknown, renamed, or structurally changed tools fail closed until reviewed.

## Validation

```sh
pnpm --filter @tritonai/plugin-n8n typecheck
pnpm --filter @tritonai/plugin-n8n test
pnpm --filter @tritonai/plugin-n8n build
pnpm validate
pnpm package:dry-run
```
