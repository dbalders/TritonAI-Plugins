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

Read access covers the complete reviewed inspection and design surface. Write adds workflow
execution, creation, updates, publishing, archiving, and Data Table changes. n8n's OAuth consent is
the single service-access choice, and the plugin accepts only its complete Read-only or All grant
bundles. n8n remains the resource-level RBAC boundary. The SDK host still requires explicit approval
and one commit admission before execute, create, update, publish, archive, Data Table write, or other
mutating calls.

The package pins the 34 tools exposed by the reviewed UC San Diego n8n 2.34.1 deployment. Every
connection initializes Streamable HTTP and verifies every returned upstream name and input-schema
shape before proxying a call. A user's scopes or disabled instance feature can produce a reviewed
subset. Unknown, renamed, or structurally changed tools fail closed until reviewed.

## Validation

```sh
pnpm --filter @tritonai/plugin-n8n typecheck
pnpm --filter @tritonai/plugin-n8n test
pnpm --filter @tritonai/plugin-n8n build
pnpm readiness
```
