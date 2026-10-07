// Captures Lucid's live MCP tool catalog into src/upstream-tools.ts, the pinned upstream contract
// that every reviewed tool is built from and that drift detection compares against.
//
// It signs in through the system browser with the same public-client flow the plugin uses
// (dynamic client registration, PKCE, loopback redirect), once per endpoint, lists the tools,
// and revokes the full-server grant before exiting (Lucid cannot revoke read-only grants). Use an
// account whose Lucid admin has enabled MCP.
//
//   node scripts/capture-upstream-tools.mjs
//
// Both endpoints are always captured: the snapshot pins the full catalog and the read-only list
// together, so a partial capture would erase the half it skipped.
import { spawn, spawnSync } from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as Path from "node:path";

const ORIGIN = "https://mcp.lucid.app";
const ENDPOINTS = { full: "/mcp", readonly: "/mcp/readonly" };
const PROTOCOL_VERSION = "2025-11-25";
const CALLBACK_PATH = "/oauth2/callback";
const selected = ["full", "readonly"];

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
  return response.json();
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

async function signIn(metadata, resource) {
  const state = NodeCrypto.randomBytes(32).toString("base64url");
  const verifier = NodeCrypto.randomBytes(64).toString("base64url");
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Lucid capture sign-in received. You can close this window.");
    if (url.searchParams.get("state") !== state) rejectCode(new Error("OAuth state mismatch."));
    else if (url.searchParams.get("error")) {
      rejectCode(new Error(`Lucid sign-in failed: ${url.searchParams.get("error")}`));
    } else resolveCode(url.searchParams.get("code"));
  });
  await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
  try {
    const registration = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "TritonAI Lucid catalog capture",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "offline_access",
      }),
    });
    const client = await registration.json();
    if (!registration.ok) throw new Error(`Registration failed: ${JSON.stringify(client)}`);
    const authorize = new URL(metadata.authorization_endpoint);
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "offline_access",
      state,
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource,
    }).toString();
    console.log(`\nSign in to Lucid for ${resource}:\n${authorize}\n`);
    openBrowser(authorize.toString());
    const code = await codePromise;
    const tokenResponse = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        resource,
      }),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${JSON.stringify(token)}`);
    console.log(
      `token: type=${token.token_type} expires_in=${token.expires_in} scope=${token.scope ?? "<none>"} refresh=${token.refresh_token ? "yes" : "no"}`,
    );
    return { clientId: client.client_id, token };
  } finally {
    server.close();
  }
}

function sseOrJson(contentType, text) {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const messages = text
    .replace(/\r\n?/gu, "\n")
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data));
  return messages.find((message) => "result" in message || "error" in message);
}

async function listTools(resource, accessToken) {
  let session = null;
  let negotiated = null;
  let sequence = 0;
  const post = async (body) => {
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    };
    if (negotiated) headers["mcp-protocol-version"] = negotiated;
    if (session) headers["mcp-session-id"] = session;
    const response = await fetch(resource, { method: "POST", headers, body: JSON.stringify(body) });
    session = response.headers.get("mcp-session-id") ?? session;
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${body.method} failed with HTTP ${response.status}: ${text}`);
    if (body.id === undefined) return null;
    const payload = sseOrJson(response.headers.get("content-type") ?? "", text);
    if (payload.error) throw new Error(`${body.method} failed: ${JSON.stringify(payload.error)}`);
    return payload.result;
  };
  const initialized = await post({
    jsonrpc: "2.0",
    id: String(++sequence),
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "TritonAI Lucid catalog capture", version: "1.0.0" },
    },
  });
  negotiated = initialized.protocolVersion;
  console.log(
    `initialize: protocol=${negotiated} server=${JSON.stringify(initialized.serverInfo)} session=${session ? "yes" : "no"}`,
  );
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = [];
  let cursor;
  do {
    const page = await post({
      jsonrpc: "2.0",
      id: String(++sequence),
      method: "tools/list",
      params: cursor === undefined ? {} : { cursor },
    });
    tools.push(...page.tools);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { tools, protocolVersion: negotiated, serverInfo: initialized.serverInfo ?? null };
}

async function form(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...headers,
    },
    body: new URLSearchParams(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  // Never keep a body that may carry tokens; error bodies are short and token-free.
  return { status: response.status, json, text: response.ok ? "" : text.slice(0, 200) };
}

// Revokes the grant and records how Lucid's token and revocation endpoints actually behave, since
// its revocation endpoint is not plain RFC 7009. Never prints token values.
async function revoke(metadata, clientId, token, resource, probes) {
  const refresh = (refreshToken) =>
    form(metadata.token_endpoint, {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource,
    });
  let access = token.access_token;
  let refreshToken = token.refresh_token;
  if (refreshToken) {
    const rotated = await refresh(refreshToken);
    const rotatedOk = rotated.status === 200 && rotated.json?.access_token;
    probes.push({
      step: "refresh",
      status: rotated.status,
      rotatesRefreshToken: rotatedOk
        ? Boolean(rotated.json.refresh_token) && rotated.json.refresh_token !== refreshToken
        : null,
      expiresIn: rotated.json?.expires_in ?? null,
      error: rotatedOk ? null : rotated.text,
    });
    if (rotatedOk) {
      const reused = await refresh(refreshToken);
      probes.push({
        step: "reuse spent refresh token",
        status: reused.status,
        error: reused.json?.error ?? null,
      });
      access = rotated.json.access_token;
      refreshToken = rotated.json.refresh_token ?? refreshToken;
    }
  }
  if (!refreshToken) return;
  const body = { client_id: clientId, token: refreshToken, token_type_hint: "refresh_token" };
  const plain = await form(metadata.revocation_endpoint, body);
  probes.push({ step: "revoke without bearer", status: plain.status, body: plain.text });
  if (plain.status !== 200) {
    const bearer = await form(metadata.revocation_endpoint, body, {
      authorization: `Bearer ${access}`,
    });
    probes.push({
      step: "revoke with bearer access token",
      status: bearer.status,
      body: bearer.text,
    });
  }
  const after = await refresh(refreshToken);
  probes.push({
    step: "refresh after revoke",
    status: after.status,
    error: after.json?.error ?? null,
  });
}

function hint(value) {
  return typeof value === "boolean" ? value : null;
}

function snapshot(tool) {
  const { $schema: _declaration, ...inputSchema } = tool.inputSchema ?? { type: "object" };
  return {
    name: tool.name,
    title: tool.annotations?.title ?? tool.title ?? null,
    description: tool.description ?? null,
    annotations: {
      readOnlyHint: hint(tool.annotations?.readOnlyHint),
      destructiveHint: hint(tool.annotations?.destructiveHint),
      idempotentHint: hint(tool.annotations?.idempotentHint),
      openWorldHint: hint(tool.annotations?.openWorldHint),
    },
    inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  };
}

const metadata = await getJson(`${ORIGIN}/.well-known/oauth-authorization-server`);
const captures = {};
for (const key of selected) {
  const resource = `${ORIGIN}${ENDPOINTS[key]}`;
  const { clientId, token } = await signIn(metadata, resource);
  const probes = [];
  try {
    captures[key] = await listTools(resource, token.access_token);
    console.log(`${key}: ${captures[key].tools.length} tools`);
    await Fs.writeFile(
      Path.join(process.env.TMPDIR ?? "/tmp", `lucid-tools-${key}.json`),
      JSON.stringify(captures[key], null, 2),
    );
  } finally {
    await revoke(metadata, clientId, token, resource, probes);
    console.log(`${key} OAuth behavior: ${JSON.stringify(probes, null, 2)}`);
  }
}

const full = captures.full?.tools.map(snapshot) ?? [];
const readonly = captures.readonly?.tools.map(snapshot) ?? [];
const byName = new Map(full.map((tool) => [tool.name, tool]));
for (const tool of readonly) {
  if (!byName.has(tool.name)) byName.set(tool.name, tool);
}
const capturedAt = new Date().toISOString().slice(0, 10);
const target = Path.resolve(import.meta.dirname, "..", "src", "upstream-tools.ts");
await Fs.writeFile(
  target,
  `// Generated by scripts/capture-upstream-tools.mjs on ${capturedAt}. Do not edit by hand.
import type { CapturedUpstreamTool } from "./upstream-tool-types.ts";

export const UPSTREAM_CAPTURE = ${JSON.stringify(
    {
      capturedAt,
      source: "live",
      protocolVersion: captures.full?.protocolVersion ?? captures.readonly?.protocolVersion,
      serverInfo: captures.full?.serverInfo ?? captures.readonly?.serverInfo,
    },
    null,
    2,
  )} as const;

/** Tool names the read-only endpoint lists. */
export const UPSTREAM_READONLY_TOOL_NAMES: ReadonlyArray<string> = ${JSON.stringify(
    readonly.map((tool) => tool.name).toSorted(),
    null,
    2,
  )};

export const UPSTREAM_TOOLS: ReadonlyArray<CapturedUpstreamTool> = ${JSON.stringify(
    [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    null,
    2,
  )};
`,
);
const formatted = spawnSync("pnpm", ["exec", "vp", "fmt", target], { stdio: "inherit" });
if (formatted.status !== 0) throw new Error("Formatting the captured catalog failed.");
console.log(`captured ${byName.size} Lucid tools into ${Path.relative(process.cwd(), target)}`);
