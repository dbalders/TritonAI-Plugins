import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { N8N_SECRET_SUFFIX, N8N_TOOLS, N8nProvider } from "./N8nProvider.ts";
import type {
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationSecretStore,
} from "./host-contract.ts";

const SERVER = "https://n8n.tritonai.ucsd.edu/mcp-server/http";
const ORIGIN = "https://n8n.tritonai.ucsd.edu";
const SCOPES = [
  "credential:read",
  "dataTable:read",
  "dataTable:write",
  "execution:read",
  "project:read",
  "tag:read",
  "workflow:execute",
  "workflow:read",
  "workflow:write",
] as const;

function memorySecrets(options: { failSet?: boolean } = {}) {
  const values = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const service: IntegrationSecretStore = {
    get: async (name) => {
      calls.push(`get:${name}`);
      const value = values.get(name);
      return value === undefined ? null : new TextDecoder().decode(value);
    },
    set: async (name, value) => {
      calls.push(`set:${name}`);
      if (options.failSet) throw new Error("fixture persistence failed");
      values.set(name, new TextEncoder().encode(value));
    },
    remove: async (name) => {
      calls.push(`remove:${name}`);
      values.delete(name);
    },
  };
  return { service, values, calls };
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

function protectedMetadata(scopes: ReadonlyArray<string> = SCOPES) {
  return {
    resource: SERVER,
    bearer_methods_supported: ["header"],
    authorization_servers: [ORIGIN],
    scopes_supported: scopes,
  };
}

function authorizationMetadata(scopes: ReadonlyArray<string> = SCOPES) {
  return {
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/mcp-oauth/authorize`,
    token_endpoint: `${ORIGIN}/mcp-oauth/token`,
    registration_endpoint: `${ORIGIN}/mcp-oauth/register`,
    revocation_endpoint: `${ORIGIN}/mcp-oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: scopes,
  };
}

function toolInventory(options: { mutate?: (tools: Record<string, unknown>[]) => void } = {}) {
  const tools = N8N_TOOLS.map((tool) => ({
    name: tool.name.slice("n8n.".length),
    description: tool.description,
    inputSchema: Schema.toJsonSchemaDocument(tool.input).schema,
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.destructive,
      idempotentHint: tool.idempotent,
      openWorldHint: tool.openWorld,
    },
  }));
  options.mutate?.(tools);
  return tools;
}

function mcpResponse(request: Record<string, unknown>, result: unknown, headers: HeadersInit = {}) {
  return json({ jsonrpc: "2.0", id: request.id, result }, 200, headers);
}

function mcpEventResponse(
  request: Record<string, unknown>,
  result: unknown,
  headers: HeadersInit = {},
) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
  return new Response(`: keep-alive\r\n\r\nevent: message\r\ndata: ${payload}\r\n\r\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function oauthMcpFetch(
  options: {
    readonly scopes?: ReadonlyArray<string>;
    readonly mutateTools?: (tools: Record<string, unknown>[]) => void;
    readonly toolResult?: unknown;
    readonly eventStream?: boolean;
  } = {},
) {
  const requests: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];
  const scopes = options.scopes ?? SCOPES;
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const contentType = new Headers(init?.headers).get("content-type") ?? "";
    const body =
      typeof init?.body === "string" && contentType.includes("application/json")
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    requests.push({ url, init, body });
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp-server/http")) {
      return json(protectedMetadata());
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return json(authorizationMetadata());
    }
    if (url.endsWith("/mcp-oauth/register")) {
      return json(
        {
          client_id: "dynamic-client-fixture",
          token_endpoint_auth_method: "none",
          redirect_uris: [
            (JSON.parse(String(init?.body)) as { redirect_uris: string[] }).redirect_uris[0],
          ],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
        201,
      );
    }
    if (url.endsWith("/mcp-oauth/token")) {
      const form = new URLSearchParams(String(init?.body));
      return json({
        access_token:
          form.get("grant_type") === "refresh_token" ? "access-rotated" : "access-fixture",
        refresh_token:
          form.get("grant_type") === "refresh_token" ? "refresh-rotated" : "refresh-fixture",
        expires_in: 3600,
        token_type: "Bearer",
        scope: scopes.join(" "),
      });
    }
    if (url.endsWith("/mcp-oauth/revoke")) return new Response(null, { status: 204 });
    if (url === SERVER) {
      if (!body) throw new Error("missing fixture MCP request body");
      const respond = options.eventStream ? mcpEventResponse : mcpResponse;
      if (body.method === "initialize") {
        return respond(
          body,
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "n8n", version: "2.34.1" },
          },
          { "mcp-session-id": "session-fixture" },
        );
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        return respond(body, { tools: toolInventory({ mutate: options.mutateTools }) });
      }
      if (body.method === "tools/call") {
        return respond(body, options.toolResult ?? { content: [{ type: "text", text: "ok" }] });
      }
    }
    throw new Error(`unexpected fixture request: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImplementation, requests };
}

async function authorize(
  provider: N8nProvider,
  requests: ReturnType<typeof oauthMcpFetch>["requests"],
) {
  const flow = await provider.connect(
    [
      "workflow.read",
      "workflow.write",
      "workflow.execute",
      "execution.read",
      "data-table.read",
      "data-table.write",
    ],
    lifecycle(),
  );
  expect(flow.kind).toBe("authorization_url");
  if (flow.kind !== "authorization_url") throw new Error("expected browser flow");
  const authorization = new URL(flow.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("iss", ORIGIN);
  callback.searchParams.set("code", "authorization-code-fixture");
  const response = await fetch(callback);
  expect(response.status).toBe(200);
  await expect(provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
    state: "connected",
  });
  expect(requests.length).toBeGreaterThan(5);
  return authorization;
}

describe("N8nProvider", () => {
  it("publishes the reviewed 2.34.1 catalog with strict bounded schemas and truthful effects", async () => {
    expect(N8N_TOOLS).toHaveLength(34);
    expect(new Set(N8N_TOOLS.map(({ name }) => name)).size).toBe(34);
    expect(N8N_TOOLS.map(({ name }) => name)).toContain("n8n.get_workflow_history");
    expect(N8N_TOOLS.map(({ name }) => name)).not.toContain("n8n.get_execution");
    for (const tool of N8N_TOOLS) {
      expect(typeof tool.openWorld).toBe("boolean");
      expect(typeof tool.destructive).toBe("boolean");
      expect(typeof tool.idempotent).toBe("boolean");
      expect(Schema.toJsonSchemaDocument(tool.input).schema).toMatchObject({ type: "object" });
    }
    expect(
      N8N_TOOLS.filter(({ openWorld }) => openWorld)
        .map(({ name }) => name)
        .toSorted(),
    ).toEqual(["n8n.execute_workflow", "n8n.explore_node_resources"]);
    expect(N8N_TOOLS.find(({ name }) => name === "n8n.publish_workflow")).toMatchObject({
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
    const testSchema = Schema.toJsonSchemaDocument(
      N8N_TOOLS.find(({ name }) => name === "n8n.test_workflow")!.input,
    ).schema as { properties: Record<string, unknown> };
    expect(testSchema.properties).toHaveProperty("timeout");
    const searchNodesSchema = Schema.toJsonSchemaDocument(
      N8N_TOOLS.find(({ name }) => name === "n8n.search_nodes")!.input,
    ).schema as { properties: Record<string, unknown> };
    expect(searchNodesSchema.properties).toHaveProperty("usage");
    for (const name of ["n8n.create_workflow_from_code", "n8n.update_workflow"]) {
      const schema = Schema.toJsonSchemaDocument(
        N8N_TOOLS.find((tool) => tool.name === name)!.input,
      ).schema as { properties: Record<string, unknown> };
      expect(schema.properties).toHaveProperty("versionName");
      expect(schema.properties).toHaveProperty("versionDescription");
    }
    const search = N8N_TOOLS.find(({ name }) => name === "n8n.search_workflows")!;
    await expect(
      Schema.decodeUnknownPromise(search.input)(
        { limit: 201, extra: true },
        { onExcessProperty: "error" },
      ),
    ).rejects.toBeDefined();
    const execute = N8N_TOOLS.find(({ name }) => name === "n8n.execute_workflow")!;
    await expect(
      Schema.decodeUnknownPromise(execute.input)(
        { workflowId: "wf" },
        { onExcessProperty: "error" },
      ),
    ).rejects.toBeDefined();
    expect(execute).toMatchObject({ readOnly: false, destructive: true, idempotent: false });
  });

  it("discovers same-origin OAuth, registers a public PKCE client, verifies MCP, and proxies calls", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch();
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    const authorization = await authorize(provider, mock.requests);
    expect(authorization.origin).toBe(ORIGIN);
    expect(authorization.searchParams.get("resource")).toBe(SERVER);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")?.split(" ").toSorted()).toEqual(
      [...SCOPES].toSorted(),
    );
    const registration = mock.requests.find(({ url }) => url.endsWith("/mcp-oauth/register"))!;
    expect(registration.init?.redirect).toBe("error");
    expect(String(registration.init?.body)).not.toContain("client_secret");
    const token = mock.requests.find(({ url }) => url.endsWith("/mcp-oauth/token"))!;
    expect(new URLSearchParams(String(token.init?.body)).get("resource")).toBe(SERVER);
    expect(
      JSON.parse(new TextDecoder().decode(secrets.values.get(N8N_SECRET_SUFFIX))),
    ).toMatchObject({
      version: 1,
      clientId: "dynamic-client-fixture",
      refreshToken: "refresh-fixture",
    });
    await expect(
      provider.invoke("n8n.search_projects", { limit: 1 }, invocation(false)),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    expect(mock.requests.at(-1)?.body).toMatchObject({
      method: "tools/call",
      params: { name: "search_projects", arguments: { limit: 1 } },
    });
    await provider.close();
  });

  it("gates every write before network access and calls beginCommit immediately before the proxy call", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch();
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await authorize(provider, mock.requests);
    const before = mock.requests.length;
    await expect(
      provider.invoke("n8n.archive_workflow", { workflowId: "wf" }, invocation(false)),
    ).rejects.toThrow(/approval/u);
    expect(mock.requests).toHaveLength(before);
    const events: string[] = [];
    await provider.invoke("n8n.archive_workflow", { workflowId: "wf" }, invocation(true, events));
    expect(events).toEqual(["beginCommit"]);
    expect(mock.requests.at(-1)?.body).toMatchObject({
      method: "tools/call",
      params: { name: "archive_workflow" },
    });
    await provider.close();
  });

  it("faults after an admitted write has an unknown external outcome", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch();
    let failWrite = false;
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (failWrite && body?.method === "tools/call") throw new Error("fixture connection lost");
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new N8nProvider(secrets.service, { serverUrl: SERVER }, fetchImplementation);
    await authorize(provider, mock.requests);

    failWrite = true;
    await expect(
      provider.invoke("n8n.archive_workflow", { workflowId: "wf" }, invocation(true)),
    ).rejects.toMatchObject({
      _tag: "ExternalCommitOutcomeUnknown",
      code: "external_commit_outcome_unknown",
      retryable: false,
    });
    await expect(provider.status()).resolves.toMatchObject({ state: "error" });

    failWrite = false;
    await provider.disconnect(lifecycle());
    await provider.close();
  });

  it.each([
    [
      "non-success HTTP",
      (_request: Record<string, unknown>) => json({ error: "fixture remote failure" }, 503),
    ],
    [
      "JSON-RPC error",
      (request: Record<string, unknown>) =>
        json({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_000, message: "fixture remote failure" },
        }),
    ],
    [
      "tool-level error",
      (request: Record<string, unknown>) =>
        mcpResponse(request, {
          isError: true,
          content: [{ type: "text", text: "fixture remote failure" }],
        }),
    ],
  ])("treats an admitted write followed by a %s as outcome-unknown", async (_label, response) => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch();
    let failWrite = false;
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (failWrite && body?.method === "tools/call") return response(body);
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new N8nProvider(secrets.service, { serverUrl: SERVER }, fetchImplementation);
    await authorize(provider, mock.requests);

    failWrite = true;
    await expect(
      provider.invoke("n8n.archive_workflow", { workflowId: "wf" }, invocation(true)),
    ).rejects.toMatchObject({
      _tag: "ExternalCommitOutcomeUnknown",
      code: "external_commit_outcome_unknown",
      retryable: false,
    });
    await expect(provider.status()).resolves.toMatchObject({ state: "error" });
    await provider.close();
  });

  it("accepts CRLF event streams with keep-alive comment blocks", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({ eventStream: true });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await authorize(provider, mock.requests);
    await expect(
      provider.invoke("n8n.search_projects", { limit: 1 }, invocation(false)),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    await provider.close();
  });

  it("fails closed on unknown tools and schema drift without storing credentials", async () => {
    for (const mutateTools of [
      (tools: Record<string, unknown>[]) =>
        tools.push({ name: "future_admin_tool", inputSchema: { type: "object" } }),
      (tools: Record<string, unknown>[]) => {
        const first = tools[0]!;
        first.inputSchema = { type: "object", properties: { injected: { type: "string" } } };
      },
      (tools: Record<string, unknown>[]) => {
        delete tools[0]!.annotations;
      },
    ]) {
      const secrets = memorySecrets();
      const mock = oauthMcpFetch({ mutateTools });
      const provider = new N8nProvider(
        secrets.service,
        { serverUrl: SERVER },
        mock.fetchImplementation,
      );
      const flow = await provider.connect(["workflow.read"], lifecycle());
      if (flow.kind !== "authorization_url") throw new Error("expected browser flow");
      const authorization = new URL(flow.authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("iss", ORIGIN);
      callback.searchParams.set("code", "code");
      await fetch(callback);
      await expect(provider.poll(flow.flowId, lifecycle())).rejects.toThrow(/changed|schema/u);
      expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(false);
      await provider.close();
    }
  });

  it("accepts a narrowed grant and blocks tools absent from the returned inventory", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({
      scopes: ["workflow:read"],
      mutateTools: (tools) => tools.splice(1),
    });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await authorize(provider, mock.requests);
    await expect(provider.status()).resolves.toMatchObject({
      grantedCapabilities: ["workflow.read"],
    });
    await expect(
      provider.invoke("n8n.get_workflow_details", { workflowId: "wf" }, invocation(false)),
    ).rejects.toThrow(/not available/u);
    await provider.close();
  });

  it("rotates refresh tokens, recovers a new MCP session, and rejects remote tool errors", async () => {
    const secrets = memorySecrets();
    const first = oauthMcpFetch();
    const connected = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      first.fetchImplementation,
    );
    await authorize(connected, first.requests);
    await connected.close();
    const second = oauthMcpFetch({
      toolResult: { isError: true, content: [{ type: "text", text: "sensitive remote detail" }] },
    });
    const restored = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      second.fetchImplementation,
    );
    await restored.prepare(lifecycle());
    const stored = JSON.parse(
      new TextDecoder().decode(secrets.values.get(N8N_SECRET_SUFFIX)),
    ) as Record<string, unknown>;
    expect(stored.refreshToken).toBe("refresh-rotated");
    await expect(restored.invoke("n8n.search_projects", {}, invocation(false))).rejects.toThrow(
      "n8n reported that the tool operation failed.",
    );
    await restored.disconnect(lifecycle());
    expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(false);
    await restored.close();
  });

  it("faults disconnect when revocation has an unknown external outcome", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch();
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/mcp-oauth/revoke")) {
        return json({ error: "fixture revocation failure" }, 503);
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new N8nProvider(secrets.service, { serverUrl: SERVER }, fetchImplementation);
    await authorize(provider, mock.requests);

    await expect(provider.disconnect(lifecycle())).rejects.toMatchObject({
      _tag: "ExternalCommitOutcomeUnknown",
      code: "external_commit_outcome_unknown",
      retryable: false,
    });
    expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(true);
    await expect(provider.status()).resolves.toMatchObject({ state: "error" });
    await provider.close();
  });

  it("serializes disconnect with authorization-code exchange and revokes the issued credential", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch();
    let releaseToken: (() => void) | undefined;
    let markTokenStarted: (() => void) | undefined;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const tokenStarted = new Promise<void>((resolve) => {
      markTokenStarted = resolve;
    });
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const form = new URLSearchParams(String(init?.body));
      if (url.endsWith("/mcp-oauth/token") && form.get("grant_type") === "authorization_code") {
        markTokenStarted?.();
        await tokenGate;
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new N8nProvider(secrets.service, { serverUrl: SERVER }, fetchImplementation);
    const flow = await provider.connect(["workflow.read"], lifecycle());
    if (flow.kind !== "authorization_url") throw new Error("expected browser flow");
    const authorization = new URL(flow.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("iss", ORIGIN);
    callback.searchParams.set("code", "authorization-code-fixture");
    await fetch(callback);

    const polling = provider.poll(flow.flowId, lifecycle());
    await tokenStarted;
    const disconnecting = provider.disconnect(lifecycle());
    releaseToken?.();

    await expect(polling).resolves.toMatchObject({ state: "connected" });
    await expect(disconnecting).resolves.toBeUndefined();
    expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(false);
    const revocations = mock.requests.filter(({ url }) => url.endsWith("/mcp-oauth/revoke"));
    expect(revocations).toHaveLength(1);
    expect(new URLSearchParams(String(revocations[0]!.init?.body)).get("token")).toBe(
      "refresh-fixture",
    );
    await expect(provider.status()).resolves.toMatchObject({ state: "not_connected" });
    await provider.close();
  });

  it("bounds network responses and propagates caller cancellation without leaking endpoints", async () => {
    const secrets = memorySecrets();
    const oversized = vi.fn(
      async () =>
        new Response("x", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": String(200_000) },
        }),
    ) as unknown as typeof fetch;
    const provider = new N8nProvider(secrets.service, { serverUrl: SERVER }, oversized);
    await expect(provider.connect(["workflow.read"], lifecycle())).rejects.toThrow(/size/u);
    await provider.close();

    const controller = new AbortController();
    const waiting = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new Error("fixture aborted"));
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(new Error("fixture aborted")), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;
    const cancelled = new N8nProvider(secrets.service, { serverUrl: SERVER }, waiting);
    const context = { signal: controller.signal, beginCommit: async () => controller.signal };
    const pending = cancelled.connect(["workflow.read"], context);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/u);
    await cancelled.close();
  });
});
