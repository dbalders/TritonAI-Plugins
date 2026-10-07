import { describe, expect, it, vi } from "vite-plus/test";

import type {
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationSecretStore,
} from "../host-contract.ts";
import {
  OAUTH_SECRET_SUFFIX,
  REVOCATION_SECRET_SUFFIX,
  type RemoteMcpPolicy,
  type RemoteMcpTool,
  RemoteMcpProvider,
  type UpstreamToolSnapshot,
} from "./RemoteMcpProvider.ts";

const ORIGIN = "https://mcp.example.test";
const FULL = `${ORIGIN}/mcp`;
const READONLY = `${ORIGIN}/mcp/readonly`;

function upstream(
  name: string,
  readOnly: boolean,
  properties: Record<string, unknown> = { documentId: { type: "string" } },
): UpstreamToolSnapshot {
  return {
    name,
    title: null,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: readOnly ? false : null,
      idempotentHint: null,
      openWorldHint: null,
    },
    inputSchema: { type: "object", properties, required: Object.keys(properties) },
  };
}

function tool(
  name: string,
  upstreamName: string,
  capability: string,
  effect: "read" | "write",
): RemoteMcpTool {
  const snapshot = upstream(upstreamName, effect === "read");
  return {
    name,
    upstreamName,
    displayName: name,
    description: name,
    capability,
    effect,
    destructive: false,
    idempotent: effect === "read",
    openWorld: true,
    inputSchema: { ...snapshot.inputSchema, additionalProperties: false },
    upstream: snapshot,
  };
}

const POLICY: RemoteMcpPolicy = {
  providerId: "example",
  serviceName: "Example",
  origin: ORIGIN,
  endpoints: [
    { path: "/mcp/readonly", capabilities: ["read"], label: "Read-only" },
    { path: "/mcp", capabilities: ["read", "write"], label: "Full" },
  ],
  oauth: {
    clientName: "TritonAI Harness",
    scopes: ["offline_access"],
    paths: {
      authorization: "/oauth/authorize",
      token: "/oauth/token",
      registration: "/oauth/register",
      revocation: "/oauth/revoke",
    },
    requireIssuerParameter: false,
    revocation: "rfc7009",
  },
  tools: [
    tool("example.fetch", "fetch", "read", "read"),
    tool("example.create", "example_create", "write", "write"),
  ],
  writeFailureNote: "Check the document before retrying.",
};

function memorySecrets() {
  const values = new Map<string, string>();
  const service: IntegrationSecretStore = {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => {
      values.set(name, value);
    },
    remove: async (name) => {
      values.delete(name);
    },
  };
  return { service, values };
}

function lifecycle(events: string[] = []): IntegrationLifecycleContext {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    beginCommit: vi.fn(async () => {
      events.push("beginCommit");
      return controller.signal;
    }),
  };
}

function invocation(approved: boolean, events: string[] = []): IntegrationInvocationContext {
  return { ...lifecycle(events), writeApproved: approved };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface FixtureOptions {
  readonly tools?: (endpoint: string) => unknown[];
  readonly toolResult?: unknown;
  readonly toolStatus?: number;
  readonly eventStream?: boolean;
  readonly refuseInitialize?: boolean;
  readonly refreshError?: { readonly status: number; readonly error: string };
  readonly omitExpiry?: boolean;
  readonly registrationExtras?: Record<string, unknown>;
  readonly revokeStatus?: number;
  readonly advertiseIssuer?: boolean;
  readonly failToolsList?: boolean;
  /** Revocation answers 401 unless an access token is sent as a bearer (Lucid's behavior). */
  readonly revocationNeedsBearer?: boolean;
  /** tools/call answers over an event stream that stays open after the response. */
  readonly openStream?: boolean;
  /** Each initialize issues a new session id, and other requests must carry the current one. */
  readonly rotateSessions?: boolean;
  /** The token endpoint answers with a gateway HTML error page. */
  readonly tokenGatewayError?: {
    readonly grant: "authorization_code" | "refresh_token";
    readonly status: number;
  };
}

function liveTools(endpoint: string) {
  return POLICY.tools
    .filter((entry) => endpoint === FULL || entry.effect === "read")
    .map((entry) => ({
      name: entry.upstreamName,
      description: "upstream wording",
      inputSchema: entry.upstream.inputSchema,
      annotations: entry.upstream.annotations,
    }));
}

function remote(options: FixtureOptions = {}) {
  const requests: Array<{
    url: string;
    init?: RequestInit;
    body?: Record<string, unknown>;
    form?: URLSearchParams;
  }> = [];
  let tokenSerial = 0;
  let sessionSerial = 0;
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const contentType = new Headers(init?.headers).get("content-type") ?? "";
    const body =
      typeof init?.body === "string" && contentType.includes("application/json")
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const form =
      contentType.includes("x-www-form-urlencoded") && init?.body
        ? new URLSearchParams(String(init.body))
        : undefined;
    requests.push({ url, init, body, form });
    if (url === `${ORIGIN}/.well-known/oauth-protected-resource/mcp`) {
      return json({ resource: FULL, authorization_servers: [ORIGIN], scopes_supported: [] });
    }
    if (url === `${ORIGIN}/.well-known/oauth-protected-resource/mcp/readonly`) {
      return json({ resource: READONLY, authorization_servers: [ORIGIN], scopes_supported: [] });
    }
    if (url === `${ORIGIN}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        revocation_endpoint: `${ORIGIN}/oauth/revoke`,
        registration_endpoint: `${ORIGIN}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        scopes_supported: ["offline_access"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        code_challenge_methods_supported: ["S256"],
        ...(options.advertiseIssuer
          ? { authorization_response_iss_parameter_supported: true }
          : {}),
      });
    }
    if (url === `${ORIGIN}/oauth/register`) {
      return json(
        {
          client_id: `client-${requests.filter((entry) => entry.url.endsWith("/register")).length}`,
          token_endpoint_auth_method: "none",
          redirect_uris: [(body as { redirect_uris: string[] }).redirect_uris[0]],
          ...options.registrationExtras,
        },
        201,
      );
    }
    if (url === `${ORIGIN}/oauth/token`) {
      if (
        options.tokenGatewayError &&
        form?.get("grant_type") === options.tokenGatewayError.grant
      ) {
        return new Response("<html><body>Bad gateway</body></html>", {
          status: options.tokenGatewayError.status,
          headers: { "content-type": "text/html" },
        });
      }
      if (form?.get("grant_type") === "refresh_token" && options.refreshError) {
        return json({ error: options.refreshError.error }, options.refreshError.status);
      }
      tokenSerial += 1;
      return json({
        access_token: `access-${tokenSerial}`,
        refresh_token: `refresh-${tokenSerial}`,
        token_type: "bearer",
        ...(options.omitExpiry ? {} : { expires_in: 3600 }),
      });
    }
    if (url === `${ORIGIN}/oauth/revoke`) {
      if (
        options.revocationNeedsBearer &&
        !new Headers(init?.headers).get("authorization")?.startsWith("Bearer ")
      ) {
        return json({ error: "invalid_token" }, 401);
      }
      return new Response(null, { status: options.revokeStatus ?? 200 });
    }
    if (url === FULL || url === READONLY) {
      if (!body) throw new Error("missing MCP body");
      if (options.rotateSessions) {
        if (body.method === "initialize") sessionSerial += 1;
        else if (new Headers(init?.headers).get("mcp-session-id") !== `session-${sessionSerial}`) {
          return json({ error: "missing or stale session" }, 400);
        }
      }
      const session = options.rotateSessions ? `session-${sessionSerial}` : "session-1";
      const respond = (result: unknown) => {
        const payload = { jsonrpc: "2.0", id: body.id, result };
        if (!options.eventStream) return json(payload, 200, { "mcp-session-id": session });
        const progress = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progress: 1 },
        });
        return new Response(
          `event: message\ndata: ${progress}\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" },
          },
        );
      };
      if (body.method === "initialize") {
        if (options.refuseInitialize) {
          return json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32_601, message: "Method not found" },
          });
        }
        return respond({
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fixture", version: "1" },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "server/discover") {
        return respond({
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        });
      }
      if (body.method === "tools/list" && options.failToolsList) {
        return json({ message: "private" }, 503);
      }
      if (body.method === "tools/list") {
        return respond({ tools: (options.tools ?? liveTools)(url) });
      }
      if (body.method === "tools/call") {
        if (options.toolStatus) return json({ message: "private" }, options.toolStatus);
        if (options.openStream) {
          const payload = JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "streamed" }] },
          });
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              // Answer, then begin another event and never close the stream.
              controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${payload}\n\n`));
              controller.enqueue(new TextEncoder().encode('data: {"partial'));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" },
          });
        }
        return respond(options.toolResult ?? { content: [{ type: "text", text: "ok" }] });
      }
    }
    throw new Error(`unexpected fixture request: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImplementation, requests };
}

async function authorize(
  provider: RemoteMcpProvider,
  capabilities: ReadonlyArray<string> = ["read"],
  callbackExtras: Record<string, string> = {},
) {
  const flow = await provider.connect(capabilities, lifecycle());
  if (flow.kind !== "authorization_url") throw new Error("expected a browser flow");
  const authorization = new URL(flow.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("code", "code-fixture");
  for (const [key, value] of Object.entries(callbackExtras)) callback.searchParams.set(key, value);
  const response = await fetch(callback);
  expect(response.status).toBe(200);
  const result = await provider.poll(flow.flowId, lifecycle());
  return { authorization, result };
}

describe("RemoteMcpProvider", () => {
  it("signs in to the least-privileged endpoint and proxies a reviewed read", async () => {
    const secrets = memorySecrets();
    const mock = remote();
    const provider = new RemoteMcpProvider(POLICY, secrets.service, mock.fetchImplementation);
    const { authorization, result } = await authorize(provider);
    expect(result).toMatchObject({ state: "connected" });
    expect(authorization.origin + authorization.pathname).toBe(`${ORIGIN}/oauth/authorize`);
    expect(authorization.searchParams.get("resource")).toBe(READONLY);
    expect(authorization.searchParams.get("scope")).toBe("offline_access");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const registration = mock.requests.find(({ url }) => url.endsWith("/oauth/register"))!;
    expect(registration.body).toMatchObject({
      token_endpoint_auth_method: "none",
      scope: "offline_access",
    });
    const token = mock.requests.find(({ url }) => url.endsWith("/oauth/token"))!;
    expect(token.form?.get("resource")).toBe(READONLY);
    expect(JSON.parse(secrets.values.get(OAUTH_SECRET_SUFFIX)!)).toMatchObject({
      version: 1,
      endpoint: "/mcp/readonly",
      clientId: "client-1",
      refreshToken: "refresh-1",
    });
    await expect(provider.status({ signal: new AbortController().signal })).resolves.toMatchObject({
      state: "connected",
      grantedCapabilities: ["read"],
      accountLabel: "Example (Read-only)",
    });
    await expect(
      provider.invoke("example.fetch", { documentId: "doc-1" }, invocation(false)),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
    const call = mock.requests.at(-1)!;
    expect(call.url).toBe(READONLY);
    expect(call.body).toMatchObject({
      method: "tools/call",
      params: { name: "fetch", arguments: { documentId: "doc-1" } },
    });
    const headers = new Headers(call.init?.headers);
    expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(headers.get("mcp-session-id")).toBe("session-1");
    expect(headers.get("authorization")).toBe("Bearer access-1");
    expect(mock.requests.some(({ body }) => body?.method === "notifications/initialized")).toBe(
      true,
    );
  });

  it("keeps write tools off a read-only grant and upgrades by signing in again", async () => {
    const secrets = memorySecrets();
    const mock = remote();
    const provider = new RemoteMcpProvider(POLICY, secrets.service, mock.fetchImplementation);
    await authorize(provider);
    await expect(
      provider.invoke("example.create", { documentId: "d" }, invocation(true)),
    ).rejects.toThrow(/needs an ability the current connection does not include/u);
    const upgrade = await authorize(provider, ["read", "write"]);
    expect(upgrade.result).toMatchObject({ state: "connected" });
    expect(upgrade.authorization.searchParams.get("resource")).toBe(FULL);
    expect(JSON.parse(secrets.values.get(OAUTH_SECRET_SUFFIX)!)).toMatchObject({
      endpoint: "/mcp",
      refreshToken: "refresh-2",
    });
    const revoked = mock.requests.filter(({ url }) => url.endsWith("/oauth/revoke"));
    expect(revoked.map(({ form }) => form?.get("token"))).toEqual(["refresh-1"]);
    expect(secrets.values.has(REVOCATION_SECRET_SUFFIX)).toBe(false);
    await expect(provider.status({ signal: new AbortController().signal })).resolves.toMatchObject({
      grantedCapabilities: ["read", "write"],
    });
    await expect(provider.connect(["read", "write"], lifecycle())).resolves.toMatchObject({
      kind: "connected",
    });
  });

  it("requires approval and commit admission before a write, and annotates tool errors", async () => {
    const events: string[] = [];
    const mock = remote({
      toolResult: { isError: true, content: [{ type: "text", text: "bad shape" }] },
    });
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      mock.fetchImplementation,
    );
    await authorize(provider, ["read", "write"]);
    await expect(
      provider.invoke("example.create", { documentId: "d" }, invocation(false)),
    ).rejects.toThrow(/explicit Harness approval/u);
    const result = await provider.invoke(
      "example.create",
      { documentId: "d" },
      invocation(true, events),
    );
    expect(events).toEqual(["beginCommit"]);
    expect(result).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: "bad shape" },
        { type: "text", text: "Check the document before retrying." },
      ],
    });
    await expect(provider.status({ signal: new AbortController().signal })).resolves.toMatchObject({
      state: "connected",
    });
  });

  it("keeps the plugin available after an unconfirmed write and reports refusals as results", async () => {
    const refused = remote({ toolStatus: 429 });
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      refused.fetchImplementation,
    );
    await authorize(provider, ["read", "write"]);
    await expect(
      provider.invoke("example.create", { documentId: "d" }, invocation(true)),
    ).resolves.toMatchObject({ isError: true, content: [{ text: /rate limiting/u }] });

    // The write is sent but the server fails it with a 502, so its outcome is unknown.
    const base = remote();
    let writes = 0;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes('"example_create"') && writes++ === 0) {
        return json({ message: "private" }, 502);
      }
      return base.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider2 = new RemoteMcpProvider(POLICY, memorySecrets().service, flaky);
    await authorize(provider2, ["read", "write"]);
    await expect(
      provider2.invoke("example.create", { documentId: "d" }, invocation(true)),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ text: /did not confirm whether this change was applied/u }],
    });
    await expect(provider2.status({ signal: new AbortController().signal })).resolves.toMatchObject(
      { state: "connected", grantedCapabilities: ["read", "write"] },
    );
    // Reads and later writes keep working, so the agent can check what happened.
    await expect(
      provider2.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });
    await expect(
      provider2.invoke("example.create", { documentId: "d" }, invocation(true)),
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });
  });

  it("validates input locally before any network call", async () => {
    const mock = remote();
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      mock.fetchImplementation,
    );
    await authorize(provider);
    const before = mock.requests.length;
    await expect(
      provider.invoke("example.fetch", { documentId: "d", extra: true }, invocation(false)),
    ).rejects.toThrow(/extra is not allowed/u);
    await expect(provider.invoke("example.fetch", {}, invocation(false))).rejects.toThrow(
      /documentId is required/u,
    );
    expect(mock.requests.length).toBe(before);
  });

  it("pauses one drifted tool, ignores unreviewed tools, and reports the pause", async () => {
    const mock = remote({
      tools: (endpoint) => [
        ...liveTools(endpoint).map((entry) =>
          entry.name === "example_create"
            ? {
                ...entry,
                inputSchema: { type: "object", properties: { other: { type: "string" } } },
              }
            : entry,
        ),
        { name: "unreviewed_tool", inputSchema: { type: "object" } },
      ],
    });
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      mock.fetchImplementation,
    );
    await authorize(provider, ["read", "write"]);
    const status = await provider.status({ signal: new AbortController().signal });
    expect(status.message).toContain("example.create");
    await expect(
      provider.invoke("example.create", { documentId: "d" }, invocation(true)),
    ).rejects.toThrow(/paused until the TritonAI Example plugin is updated/u);
    await expect(
      provider.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });
  });

  it("pauses a reviewed read tool that upstream starts marking as a write", async () => {
    const mock = remote({
      tools: (endpoint) =>
        liveTools(endpoint).map((entry) =>
          entry.name === "fetch"
            ? { ...entry, annotations: { ...entry.annotations, readOnlyHint: false } }
            : entry,
        ),
    });
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      mock.fetchImplementation,
    );
    await authorize(provider, ["read", "write"]);
    await expect(
      provider.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).rejects.toThrow(/paused until the TritonAI Example plugin is updated/u);
  });

  it("reads responses from an event stream that carries notifications first", async () => {
    const mock = remote({ eventStream: true });
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      mock.fetchImplementation,
    );
    await authorize(provider);
    await expect(
      provider.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });
  });

  it("falls back to the stateless discover handshake when initialize is refused", async () => {
    const mock = remote({ refuseInitialize: true });
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      mock.fetchImplementation,
    );
    const { result } = await authorize(provider);
    expect(result).toMatchObject({ state: "connected" });
    await provider.invoke("example.fetch", { documentId: "d" }, invocation(false));
    const call = mock.requests.at(-1)!;
    expect(new Headers(call.init?.headers).get("mcp-method")).toBe("tools/call");
    expect(new Headers(call.init?.headers).get("mcp-name")).toBe("fetch");
  });

  it("rejects a callback whose issuer does not match, and accepts one without iss", async () => {
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      remote().fetchImplementation,
    );
    const flow = await provider.connect(["read"], lifecycle());
    if (flow.kind !== "authorization_url") throw new Error("expected a browser flow");
    const authorization = new URL(flow.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("code", "code-fixture");
    callback.searchParams.set("iss", "https://attacker.invalid");
    expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.delete("iss");
    expect((await fetch(callback)).status).toBe(200);
    await expect(provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
      state: "connected",
    });
  });

  it("refuses a registration that turns into a confidential client", async () => {
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      remote({
        registrationExtras: {
          client_secret: "s",
          token_endpoint_auth_method: "client_secret_post",
        },
      }).fetchImplementation,
    );
    await expect(provider.connect(["read"], lifecycle())).rejects.toMatchObject({
      code: "external_commit_outcome_unknown",
    });
  });

  it("tolerates an echoed secret on a public registration without storing it", async () => {
    const secrets = memorySecrets();
    const provider = new RemoteMcpProvider(
      POLICY,
      secrets.service,
      remote({ registrationExtras: { client_secret: "echoed-secret" } }).fetchImplementation,
    );
    await authorize(provider);
    expect(secrets.values.get(OAUTH_SECRET_SUFFIX)).not.toContain("echoed-secret");
  });

  it("refreshes in prepare, defaults a missing lifetime, and resets on invalid_grant", async () => {
    const secrets = memorySecrets();
    const mock = remote({ omitExpiry: true });
    const first = new RemoteMcpProvider(POLICY, secrets.service, mock.fetchImplementation);
    await authorize(first);
    const second = new RemoteMcpProvider(POLICY, secrets.service, mock.fetchImplementation);
    const events: string[] = [];
    await second.prepare(lifecycle(events));
    expect(events).toEqual(["beginCommit"]);
    expect(JSON.parse(secrets.values.get(OAUTH_SECRET_SUFFIX)!)).toMatchObject({
      refreshToken: "refresh-2",
    });
    await expect(
      second.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });

    const expired = new RemoteMcpProvider(
      POLICY,
      secrets.service,
      remote({ refreshError: { status: 400, error: "invalid_grant" } }).fetchImplementation,
    );
    await expired.prepare(lifecycle());
    expect(secrets.values.has(OAUTH_SECRET_SUFFIX)).toBe(false);
    await expect(expired.status({ signal: new AbortController().signal })).resolves.toMatchObject({
      state: "not_connected",
    });
  });

  it("survives a gateway error page during refresh without faulting, then recovers", async () => {
    const secrets = memorySecrets();
    await authorize(new RemoteMcpProvider(POLICY, secrets.service, remote().fetchImplementation));
    const outage = new RemoteMcpProvider(
      POLICY,
      secrets.service,
      remote({ tokenGatewayError: { grant: "refresh_token", status: 503 } }).fetchImplementation,
    );
    await expect(outage.prepare(lifecycle())).resolves.toBeUndefined();
    const status = await outage.status({ signal: new AbortController().signal });
    expect(status).toMatchObject({ state: "connected" });
    expect(status.message).toContain("briefly unavailable while renewing access");
    await expect(
      outage.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).rejects.toThrow(/briefly unavailable while renewing access, so this call was not run/u);
    const recovered = new RemoteMcpProvider(POLICY, secrets.service, remote().fetchImplementation);
    await recovered.prepare(lifecycle());
    await expect(
      recovered.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });
  });

  it("drops the outage notice once a later refresh settles with a rejected grant", async () => {
    const secrets = memorySecrets();
    await authorize(new RemoteMcpProvider(POLICY, secrets.service, remote().fetchImplementation));
    let mode: "outage" | "revoked" = "outage";
    const outage = remote({ tokenGatewayError: { grant: "refresh_token", status: 503 } });
    const revoked = remote({ refreshError: { status: 400, error: "invalid_grant" } });
    const fetchImplementation = ((input: string | URL | Request, init?: RequestInit) =>
      (mode === "outage" ? outage : revoked).fetchImplementation(input, init)) as typeof fetch;
    const provider = new RemoteMcpProvider(POLICY, secrets.service, fetchImplementation);
    await provider.prepare(lifecycle());
    mode = "revoked";
    await provider.prepare(lifecycle());
    await expect(
      provider.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).rejects.toThrow(/access is not prepared/u);
    await expect(provider.status({ signal: new AbortController().signal })).resolves.toMatchObject({
      state: "not_connected",
    });
  });

  it("fails a sign-in cleanly when the token endpoint returns a gateway error page", async () => {
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      remote({ tokenGatewayError: { grant: "authorization_code", status: 502 } })
        .fetchImplementation,
    );
    const { result } = await authorize(provider);
    expect(result).toMatchObject({ state: "failed" });
    await expect(provider.status({ signal: new AbortController().signal })).resolves.toMatchObject({
      state: "not_connected",
    });
  });

  it("queues the grant before removing it and revokes it on disconnect", async () => {
    const secrets = memorySecrets();
    const mock = remote();
    const provider = new RemoteMcpProvider(POLICY, secrets.service, mock.fetchImplementation);
    await authorize(provider);
    const events: string[] = [];
    await provider.disconnect(lifecycle(events));
    expect(events).toEqual(["beginCommit"]);
    expect(secrets.values.has(OAUTH_SECRET_SUFFIX)).toBe(false);
    expect(secrets.values.has(REVOCATION_SECRET_SUFFIX)).toBe(false);
    const revoke = mock.requests.filter(({ url }) => url.endsWith("/oauth/revoke")).at(-1)!;
    expect(revoke.form?.get("token")).toBe("refresh-1");
    expect(revoke.form?.get("client_id")).toBe("client-1");
  });

  it("never lets a full revocation queue block disconnect, and reserves room for an upgrade", async () => {
    const secrets = memorySecrets();
    const mock = remote({ revokeStatus: 503 });
    const provider = new RemoteMcpProvider(POLICY, secrets.service, mock.fetchImplementation);
    await authorize(provider);
    const queued = Array.from({ length: 15 }, (_, index) => ({
      clientId: "old",
      refreshToken: `stale-${index}`,
    }));
    secrets.values.set(
      REVOCATION_SECRET_SUFFIX,
      JSON.stringify({ version: 1, origin: ORIGIN, grants: queued }),
    );
    // An upgrade could queue two grants, so with 15 queued it is refused before registering.
    await expect(provider.connect(["read", "write"], lifecycle())).rejects.toThrow(
      /has not confirmed revoking earlier sign-ins/u,
    );
    expect(mock.requests.filter(({ url }) => url.endsWith("/oauth/register"))).toHaveLength(1);
    // Disconnect still resets locally and keeps every grant queued.
    await provider.disconnect(lifecycle());
    expect(secrets.values.has(OAUTH_SECRET_SUFFIX)).toBe(false);
    const grants = JSON.parse(secrets.values.get(REVOCATION_SECRET_SUFFIX)!).grants;
    expect(grants).toHaveLength(16);
    expect(grants.at(-1)).toEqual({
      clientId: "client-1",
      refreshToken: "refresh-1",
      endpoint: "/mcp/readonly",
    });
    await expect(provider.status({ signal: new AbortController().signal })).resolves.toMatchObject({
      state: "not_connected",
    });
  });

  it("queues a newly issued grant it cannot verify or revoke, without faulting", async () => {
    const secrets = memorySecrets();
    const provider = new RemoteMcpProvider(
      POLICY,
      secrets.service,
      remote({ failToolsList: true, revokeStatus: 503 }).fetchImplementation,
    );
    const { result } = await authorize(provider);
    expect(result).toMatchObject({ state: "failed" });
    expect(secrets.values.has(OAUTH_SECRET_SUFFIX)).toBe(false);
    expect(JSON.parse(secrets.values.get(REVOCATION_SECRET_SUFFIX)!).grants).toEqual([
      { clientId: "client-1", refreshToken: "refresh-1", endpoint: "/mcp/readonly" },
    ]);
    await expect(provider.status({ signal: new AbortController().signal })).resolves.toMatchObject({
      state: "not_connected",
    });
  });

  it("keeps the stored grant when an upgrade fails, and does not queue it for revocation", async () => {
    const secrets = memorySecrets();
    const working = remote();
    const provider = new RemoteMcpProvider(POLICY, secrets.service, working.fetchImplementation);
    await authorize(provider);
    const upgrading = new RemoteMcpProvider(
      POLICY,
      secrets.service,
      remote({ failToolsList: true }).fetchImplementation,
    );
    const { result } = await authorize(upgrading, ["read", "write"]);
    expect(result).toMatchObject({ state: "failed" });
    expect(JSON.parse(secrets.values.get(OAUTH_SECRET_SUFFIX)!)).toMatchObject({
      endpoint: "/mcp/readonly",
      refreshToken: "refresh-1",
    });
    expect(secrets.values.has(REVOCATION_SECRET_SUFFIX)).toBe(false);
  });

  it("requires iss on the callback when the server advertises it", async () => {
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      remote({ advertiseIssuer: true }).fetchImplementation,
    );
    const flow = await provider.connect(["read"], lifecycle());
    if (flow.kind !== "authorization_url") throw new Error("expected a browser flow");
    const authorization = new URL(flow.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("code", "code-fixture");
    expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set("iss", ORIGIN);
    expect((await fetch(callback)).status).toBe(200);
  });

  it("names reviewed tools the connected endpoint does not offer", async () => {
    const mock = remote({
      tools: (endpoint) => liveTools(endpoint).filter((entry) => entry.name !== "example_create"),
    });
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      mock.fetchImplementation,
    );
    await authorize(provider, ["read", "write"]);
    const status = await provider.status({ signal: new AbortController().signal });
    expect(status.message).toContain("Not offered by Example on this connection: example.create.");
    await expect(
      provider.invoke("example.create", { documentId: "d" }, invocation(true)),
    ).rejects.toThrow(/does not offer this tool/u);
  });

  describe("bearer revocation", () => {
    const BEARER_POLICY: RemoteMcpPolicy = {
      ...POLICY,
      endpoints: [
        { path: "/mcp/readonly", capabilities: ["read"], label: "Read-only", revocable: false },
        { path: "/mcp", capabilities: ["read", "write"], label: "Full" },
      ],
      oauth: { ...POLICY.oauth, revocation: "bearer" },
    };

    it("refreshes a stored full grant and revokes it with a bearer access token", async () => {
      const secrets = memorySecrets();
      const mock = remote({ revocationNeedsBearer: true });
      const provider = new RemoteMcpProvider(
        BEARER_POLICY,
        secrets.service,
        mock.fetchImplementation,
      );
      await authorize(provider, ["read", "write"]);
      const before = mock.requests.length;
      await provider.disconnect(lifecycle());
      const after = mock.requests.slice(before);
      const refresh = after.find(({ form }) => form?.get("grant_type") === "refresh_token")!;
      expect(refresh.form?.get("refresh_token")).toBe("refresh-1");
      expect(refresh.form?.get("resource")).toBe(FULL);
      const revocations = after.filter(({ url }) => url.endsWith("/oauth/revoke"));
      expect(revocations.map(({ form }) => form?.get("token"))).toEqual(["refresh-2", "refresh-1"]);
      for (const revocation of revocations) {
        expect(new Headers(revocation.init?.headers).get("authorization")).toBe("Bearer access-2");
      }
      expect(secrets.values.has(OAUTH_SECRET_SUFFIX)).toBe(false);
      expect(secrets.values.has(REVOCATION_SECRET_SUFFIX)).toBe(false);
    });

    it("deletes a read-only grant locally without retrying a revocation Lucid refuses", async () => {
      const secrets = memorySecrets();
      const mock = remote({ revocationNeedsBearer: true });
      const provider = new RemoteMcpProvider(
        BEARER_POLICY,
        secrets.service,
        mock.fetchImplementation,
      );
      await authorize(provider);
      const before = mock.requests.length;
      await provider.disconnect(lifecycle());
      expect(
        mock.requests.slice(before).filter(({ url }) => /\/oauth\/(revoke|token)$/u.test(url)),
      ).toEqual([]);
      expect(secrets.values.has(REVOCATION_SECRET_SUFFIX)).toBe(false);
      await expect(provider.status({ signal: new AbortController().signal })).resolves.toEqual({
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      });
    });

    it("keeps a refreshed replacement queued when its revocation fails", async () => {
      const secrets = memorySecrets();
      const provider = new RemoteMcpProvider(
        BEARER_POLICY,
        secrets.service,
        remote({ revocationNeedsBearer: true, revokeStatus: 503 }).fetchImplementation,
      );
      await authorize(provider, ["read", "write"]);
      await provider.disconnect(lifecycle());
      const grants = JSON.parse(secrets.values.get(REVOCATION_SECRET_SUFFIX)!).grants;
      expect(grants.map((grant: { refreshToken: string }) => grant.refreshToken)).toEqual([
        "refresh-1",
        "refresh-2",
      ]);
    });

    it("keeps a refreshed replacement and unprocessed grants when cancelled mid-revocation", async () => {
      const secrets = memorySecrets();
      secrets.values.set(
        REVOCATION_SECRET_SUFFIX,
        JSON.stringify({
          version: 1,
          origin: ORIGIN,
          grants: [
            { clientId: "old", refreshToken: "queued-1", endpoint: "/mcp" },
            { clientId: "old", refreshToken: "queued-2", endpoint: "/mcp" },
          ],
        }),
      );
      const mock = remote({ revocationNeedsBearer: true });
      const controller = new AbortController();
      const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
        // Cancel the lifecycle as the first revocation is sent, after its grant was refreshed.
        if (String(input).endsWith("/oauth/revoke")) {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        }
        return mock.fetchImplementation(input, init);
      }) as unknown as typeof fetch;
      const provider = new RemoteMcpProvider(BEARER_POLICY, secrets.service, fetchImplementation);
      await expect(
        provider.disconnect({
          signal: controller.signal,
          beginCommit: async () => controller.signal,
        }),
      ).resolves.toBeUndefined();
      const grants = JSON.parse(secrets.values.get(REVOCATION_SECRET_SUFFIX)!).grants;
      expect(grants.map((grant: { refreshToken: string }) => grant.refreshToken)).toEqual([
        "queued-1",
        "refresh-1",
        "queued-2",
      ]);
    });

    it("drops queued grants that are already invalid or that Lucid will not revoke", async () => {
      const secrets = memorySecrets();
      secrets.values.set(
        REVOCATION_SECRET_SUFFIX,
        JSON.stringify({
          version: 1,
          origin: ORIGIN,
          grants: [{ clientId: "legacy", refreshToken: "legacy-refresh" }],
        }),
      );
      // A legacy entry has no endpoint; the refresh succeeds but Lucid refuses the revocation.
      const refusing = remote({ revokeStatus: 401, revocationNeedsBearer: true });
      const provider = new RemoteMcpProvider(
        BEARER_POLICY,
        secrets.service,
        refusing.fetchImplementation,
      );
      await authorize(provider);
      expect(secrets.values.has(REVOCATION_SECRET_SUFFIX)).toBe(false);
      await expect(
        provider.status({ signal: new AbortController().signal }),
      ).resolves.toMatchObject({ state: "connected" });
    });
  });

  it("settles a call once the answer arrives on an event stream that stays open", async () => {
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      remote({ openStream: true }).fetchImplementation,
      2_000,
    );
    await authorize(provider);
    await expect(
      provider.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).resolves.toMatchObject({ content: [{ text: "streamed" }] });
  });

  it("keeps refreshed access when a call made before the refresh is refused late", async () => {
    const mock = remote();
    let release: (response: Response) => void = () => undefined;
    let held = false;
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!held && body.includes('"tools/call"')) {
        held = true;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new RemoteMcpProvider(POLICY, memorySecrets().service, fetchImplementation);
    await authorize(provider);
    const stale = provider.invoke("example.fetch", { documentId: "d" }, invocation(false));
    await vi.waitFor(() => expect(held).toBe(true));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3_600_000);
    try {
      await provider.prepare(lifecycle());
    } finally {
      clock.mockRestore();
    }
    release(json({ error: "invalid_token" }, 401));
    await expect(stale).resolves.toMatchObject({
      isError: true,
      content: [{ text: /refreshed during this call/u }],
    });
    await expect(
      provider.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });
    const lastCall = mock.requests.filter(({ body }) => body?.method === "tools/call").at(-1)!;
    expect(new Headers(lastCall.init?.headers).get("authorization")).toBe("Bearer access-2");
  });

  it("does not let a session set up on old access stand in for the refreshed access", async () => {
    const mock = remote();
    let release: () => void = () => undefined;
    let held = false;
    let expired = false;
    let lists = 0;
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!expired && body.includes('"tools/call"')) {
        expired = true;
        return json({ error: "session not found" }, 404);
      }
      if (body.includes('"tools/list"')) {
        lists += 1;
        // Hold the old access's session setup (the second tools/list) until after a refresh.
        if (lists === 2) {
          held = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new RemoteMcpProvider(POLICY, memorySecrets().service, fetchImplementation);
    await authorize(provider);
    const stale = provider.invoke("example.fetch", { documentId: "d" }, invocation(false));
    await vi.waitFor(() => expect(held).toBe(true));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    let refreshed: Promise<void>;
    try {
      refreshed = provider.prepare(lifecycle());
      await vi.waitFor(() =>
        expect(mock.requests.some(({ form }) => form?.get("grant_type") === "refresh_token")).toBe(
          true,
        ),
      );
    } finally {
      clock.mockRestore();
    }
    release();
    await expect(stale).resolves.toMatchObject({
      isError: true,
      content: [{ text: /refreshed during this call/u }],
    });
    await refreshed;
    await expect(
      provider.invoke("example.fetch", { documentId: "d" }, invocation(false)),
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });
    const lastCall = mock.requests.filter(({ body }) => body?.method === "tools/call").at(-1)!;
    const headers = new Headers(lastCall.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-2");
    expect(headers.get("mcp-session-id")).toBe("session-1");
  });

  it("does not let a sign-in's revocation retry overwrite a concurrent disconnect's queue", async () => {
    const secrets = memorySecrets();
    const mock = remote({ revokeStatus: 503 });
    let release: () => void = () => undefined;
    let held = false;
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!held && String(input).endsWith("/oauth/revoke")) {
        held = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new RemoteMcpProvider(POLICY, secrets.service, fetchImplementation);
    await authorize(provider);
    secrets.values.set(
      REVOCATION_SECRET_SUFFIX,
      JSON.stringify({
        version: 1,
        origin: ORIGIN,
        grants: [{ clientId: "old", refreshToken: "queued", endpoint: "/mcp" }],
      }),
    );
    const upgrade = provider.connect(["read", "write"], lifecycle()).catch(() => undefined);
    await vi.waitFor(() => expect(held).toBe(true));
    const disconnected = provider.disconnect(lifecycle());
    // Let the disconnect finish, or block on the credential lock, before the retry resumes.
    await Promise.race([disconnected, new Promise((resolve) => setTimeout(resolve, 100))]);
    release();
    await Promise.all([upgrade, disconnected]);
    const grants = JSON.parse(secrets.values.get(REVOCATION_SECRET_SUFFIX)!).grants;
    expect(grants.map((grant: { refreshToken: string }) => grant.refreshToken)).toContain(
      "refresh-1",
    );
    expect(secrets.values.has(OAUTH_SECRET_SUFFIX)).toBe(false);
  });

  it("does not let a late 404 for an expired session clear the session that replaced it", async () => {
    const mock = remote({ rotateSessions: true });
    let releaseSecond: (response: Response) => void = () => undefined;
    let staleCalls = 0;
    let initializes = 0;
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const session = new Headers(init?.headers).get("mcp-session-id");
      if (body.includes('"tools/call"') && session === "session-1") {
        staleCalls += 1;
        // The server expired session-1: answer the first call now and the second one late.
        if (staleCalls === 1) return json({ error: "session not found" }, 404);
        return new Promise<Response>((resolve) => {
          releaseSecond = resolve;
        });
      }
      if (body.includes('"initialize"')) {
        initializes += 1;
        const response = await mock.fetchImplementation(input, init);
        // Deliver the second call's stale 404 once recovery holds the new session id.
        if (initializes === 2) releaseSecond(json({ error: "session not found" }, 404));
        return response;
      }
      if (body.includes('"notifications/initialized"') && initializes === 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new RemoteMcpProvider(POLICY, memorySecrets().service, fetchImplementation);
    await authorize(provider);
    const first = provider.invoke("example.fetch", { documentId: "a" }, invocation(false));
    const second = provider.invoke("example.fetch", { documentId: "b" }, invocation(false));
    await expect(first).resolves.toMatchObject({ content: [{ text: "ok" }] });
    await expect(second).resolves.toMatchObject({ content: [{ text: "ok" }] });
    expect(
      mock.requests.filter(
        ({ url, body, init }) =>
          (url === FULL || url === READONLY) &&
          body?.method !== "initialize" &&
          !new Headers(init?.headers).get("mcp-session-id"),
      ),
    ).toEqual([]);
  });

  it("does not let an older overlapping sign-in remove a newer one", async () => {
    const mock = remote();
    let releaseFirst: () => void = () => undefined;
    let discoveries = 0;
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/.well-known/oauth-protected-resource") && discoveries++ === 0) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new RemoteMcpProvider(POLICY, memorySecrets().service, fetchImplementation);
    const older = provider.connect(["read"], lifecycle());
    await vi.waitFor(() => expect(discoveries).toBe(1));
    const newer = await provider.connect(["read"], lifecycle());
    if (newer.kind !== "authorization_url") throw new Error("expected a browser flow");
    releaseFirst();
    await expect(older).rejects.toThrow(/replaced by a newer attempt/u);
    const authorization = new URL(newer.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("code", "code-fixture");
    expect((await fetch(callback)).status).toBe(200);
    await expect(provider.poll(newer.flowId, lifecycle())).resolves.toMatchObject({
      state: "connected",
    });
  });

  it("refuses an oversize request locally without faulting an admitted write", async () => {
    const mock = remote();
    const provider = new RemoteMcpProvider(
      POLICY,
      memorySecrets().service,
      mock.fetchImplementation,
    );
    await authorize(provider, ["read", "write"]);
    const before = mock.requests.length;
    // Within the two-megabyte input limit, but not once wrapped in the JSON-RPC request.
    const documentId = "x".repeat(2 * 1024 * 1024 - '{"documentId":""}'.length);
    await expect(
      provider.invoke("example.create", { documentId }, invocation(true)),
    ).resolves.toMatchObject({ isError: true, content: [{ text: /exceeded the allowed size/u }] });
    expect(mock.requests.length).toBe(before);
    await expect(provider.status({ signal: new AbortController().signal })).resolves.toMatchObject({
      state: "connected",
    });
  });

  it("refuses endpoints outside the reviewed origin and malformed policies", () => {
    expect(
      () =>
        new RemoteMcpProvider(
          { ...POLICY, origin: "http://mcp.example.test" },
          memorySecrets().service,
        ),
    ).toThrow(/bare HTTPS origin/u);
    expect(
      () =>
        new RemoteMcpProvider(
          { ...POLICY, tools: [...POLICY.tools, POLICY.tools[0]!] },
          memorySecrets().service,
        ),
    ).toThrow(/declared twice/u);
  });
});
