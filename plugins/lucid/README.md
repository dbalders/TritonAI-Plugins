# Lucid

`@tritonai/plugin-lucid` connects TritonAI Harness to Lucid's official hosted MCP server
(`https://mcp.lucid.app`) so agents can search, read, create, edit, comment on, organize, and share
Lucidchart and Lucidspark documents with the connected user's own Lucid access. It needs no
Lucid-specific Harness or Installer code. Lucid owns document behavior and permissions; this
package owns browser sign-in, the reviewed tool surface, input validation, and bounded Streamable
HTTP transport.

Each user signs in to Lucid in their system browser. The provider uses OAuth discovery, dynamic
client registration as a public client, PKCE, and an ephemeral `127.0.0.1` loopback redirect, and
stores tokens only through the SDK's package-scoped secret facade. There is no Lucid developer-portal
app, client secret, API key, shared account, or embedded browser.

## Configuration

The factory accepts exactly `{ "serverOrigin": "https://mcp.lucid.app" }` and rejects anything
else. Discovery and every OAuth endpoint must stay on that origin.

On Lucid Team and Enterprise accounts, a Lucid admin must first turn on **Admin → Security → AI
controls → MCP access → Allow users to connect**. If the account uses Lucid's Enterprise MCP domain
allowlist, the admin must also turn on **Allow local authentication**, because Harness signs in
through a local loopback redirect.

## Access model

| Ability         | Harness access | Lucid endpoint  | Tools                                        |
| --------------- | -------------- | --------------- | -------------------------------------------- |
| Read            | default        | `/mcp/readonly` | 15 read tools (9 on the read-only server)    |
| Create and edit | opt-in         | `/mcp`          | 13 write tools, including `lucid.run_script` |
| Share           | opt-in         | `/mcp`          | 2 sharing tools                              |

Lucid's MCP OAuth has no per-feature scopes, so the endpoint is the boundary Lucid enforces. When
the user signs in with only Read selected, the provider connects to Lucid's read-only server, which
cannot edit or delete anything. That server lists 9 of the 15 read tools; the connection status
names the ones it does not offer (the authoring guides, style, script reference, and integration
tools). Turning on Create and edit or Share starts a new sign-in to the full server. Turning those
abilities off later keeps the full grant while Harness withholds their tools; disconnect and
reconnect to return to a read-only grant. Harness still requires the matching ability, write
approval, and one commit admission before every Lucid change.

Lucid edits existing documents through `lucid.run_script`, which runs JavaScript against one
document using APIs described by `lucid.get_script_catalog` and `lucid.load_script_documentation`.
Scripts cannot reach the network or DOM, are limited to 25 seconds, and are atomic. Every script
run is a destructive write that needs approval, even one that only reads.

## Revocation

Lucid's revocation endpoint is not plain RFC 7009 (observed 2026-10-07):

- It requires a bearer access token from the grant being revoked. A grant held only as a refresh
  token is refreshed first, then both the new and the spent refresh token are revoked.
- It refuses every grant for the read-only server ("Token not valid for this MCP endpoint"), even
  with that grant's own access token. Read-only grants are therefore deleted locally on disconnect
  or upgrade and left to expire at Lucid, rather than retried forever.
- Refresh tokens rotate, but Lucid still accepts a spent refresh token.

## Upstream catalog

`src/upstream-tools.ts` pins each Lucid tool's input schema and safety hints, captured live from
Lucid on 2026-10-07 (server build `20261006-224022`, MCP protocol `2025-06-18`). Every connection
initializes the MCP session and compares Lucid's live tool list with that pin:

- Tools Lucid adds later stay unavailable until a plugin update reviews them.
- A reviewed tool whose input contract changes (a new required field, a removed or retyped field,
  or a changed default) or whose safety hints change is paused on its own and listed in the
  connection status. New optional fields and wording changes do not pause a tool.
- The local manifest, names, descriptions, and effect classification are authoritative. Lucid's
  own tool descriptions are never passed to the model.

Not exposed: `_lucid_create_embed` and `_lucid_create_embed_session_token` (internal MCP Apps
widget helpers).

To capture or review a Lucid change, sign in when the browser opens (once per endpoint) and let the
tests point at the differences:

```sh
node scripts/capture-upstream-tools.mjs
pnpm --filter @tritonai/plugin-lucid test
```

The capture writes the raw lists to `$TMPDIR/lucid-tools-{full,readonly}.json`, reports Lucid's
token and revocation behavior without printing token values, and revokes the full-server grant. It
cannot revoke the read-only grant (see Revocation).

## Validation

```sh
pnpm --filter @tritonai/plugin-lucid typecheck
pnpm --filter @tritonai/plugin-lucid test
pnpm --filter @tritonai/plugin-lucid build
pnpm readiness
```

`src/remote-mcp/` is a provider-neutral remote MCP proxy driven by `LUCID_POLICY`. It is kept inside
this package until a second plugin (n8n) adopts it, per ADR 0001.
