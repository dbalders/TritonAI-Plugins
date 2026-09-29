import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  N8N_REVOCATION_SECRET_SUFFIX,
  N8N_SECRET_SUFFIX,
  N8N_TOOLS,
  N8nProvider,
  type ReviewedTool,
  expectedSchema,
  firstSchemaDifference,
  schemaContract,
  validateToolInventory,
} from "./N8nProvider.ts";

const REVIEWED_TOOLS = N8N_TOOLS as ReadonlyArray<ReviewedTool>;
import type {
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationSecretStore,
} from "./host-contract.ts";
import { UPSTREAM_N8N_VERSION, UPSTREAM_TOOLS } from "./upstream-tools.ts";

const SERVER = "https://n8n.tritonai.ucsd.edu/mcp-server/http";
const ORIGIN = "https://n8n.tritonai.ucsd.edu";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const READ_SCOPES = [
  "agent:read",
  "aiPreference:read",
  "credential:read",
  "dataTable:read",
  "execution:read",
  "project:read",
  "tag:read",
  "workflow:read",
] as const;
const WRITE_SCOPES = [
  "agent:execute",
  "agent:write",
  "communityPackage:install",
  "dataTable:write",
  "project:write",
  "workflow:execute",
  "workflow:write",
] as const;
const SCOPES = [...READ_SCOPES, ...WRITE_SCOPES] as const;

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
  const tools = REVIEWED_TOOLS.map((tool) => ({
    name: tool.name.slice("n8n.".length),
    description: tool.description,
    inputSchema: Schema.toJsonSchemaDocument(tool.input).schema,
    annotations: {
      readOnlyHint: tool.upstreamReadOnly,
      destructiveHint: tool.destructive,
      idempotentHint: tool.idempotent,
      openWorldHint: tool.openWorld,
    },
  }));
  options.mutate?.(tools);
  return tools;
}

function mcpResponse(request: Record<string, unknown>, result: unknown, headers: HeadersInit = {}) {
  return json(
    {
      jsonrpc: "2.0",
      id: request.id,
      result:
        result && typeof result === "object" && !Array.isArray(result)
          ? { ...result, resultType: "complete" }
          : result,
    },
    200,
    headers,
  );
}

function mcpEventResponse(
  request: Record<string, unknown>,
  result: unknown,
  headers: HeadersInit = {},
) {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result:
      result && typeof result === "object" && !Array.isArray(result)
        ? { ...result, resultType: "complete" }
        : result,
  });
  return new Response(`: keep-alive\r\n\r\nevent: message\r\ndata: ${payload}\r\n\r\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function oauthMcpFetch(
  options: {
    readonly scopes?: ReadonlyArray<string>;
    readonly advertisedScopes?: ReadonlyArray<string>;
    readonly mutateTools?: (tools: Record<string, unknown>[]) => void;
    readonly toolResult?: unknown;
    readonly eventStream?: boolean;
    readonly mcpFailure?: { readonly method: string; readonly status: number };
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
      return json(protectedMetadata(options.advertisedScopes));
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return json(authorizationMetadata(options.advertisedScopes));
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
    if (url.endsWith("/mcp-oauth/revoke")) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("client_id") !== "dynamic-client-fixture") {
        return json({ error: "invalid_client" }, 400);
      }
      return new Response(null, { status: 204 });
    }
    if (url === SERVER) {
      if (!body) throw new Error("missing fixture MCP request body");
      const mcpFailure = options.mcpFailure;
      if (mcpFailure && body.method === mcpFailure.method) {
        return json({ message: "fixture-private-detail" }, mcpFailure.status);
      }
      const respond = options.eventStream ? mcpEventResponse : mcpResponse;
      if (body.method === "server/discover") {
        return respond(body, {
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities: { tools: {} },
        });
      }
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
  capabilities: ReadonlyArray<string> = ["read", "write"],
) {
  const flow = await provider.connect(capabilities, lifecycle());
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
  it("publishes the reviewed 2.41.3 catalog with strict bounded schemas and truthful effects", async () => {
    expect(N8N_TOOLS).toHaveLength(60);
    expect(new Set(N8N_TOOLS.map(({ name }) => name)).size).toBe(60);
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
    ).toEqual([
      "n8n.call_agent",
      "n8n.delete_agent",
      "n8n.discover_agent_assets",
      "n8n.execute_workflow",
      "n8n.explore_node_resources",
      "n8n.install_community_node",
      "n8n.publish_agent",
      "n8n.unpublish_agent",
      "n8n.update_agent_integration",
      "n8n.verify_agent_mcp_server",
    ]);
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
    const searchSchema = Schema.toJsonSchemaDocument(search.input).schema as {
      properties: Record<string, unknown>;
    };
    expect(searchSchema.properties).toHaveProperty("folderId");
    expect(searchSchema.properties).toHaveProperty("includeSubfolders");
    await expect(
      Schema.decodeUnknownPromise(search.input)(
        { limit: 201, extra: true },
        { onExcessProperty: "error" },
      ),
    ).rejects.toBeDefined();
    const execute = N8N_TOOLS.find(({ name }) => name === "n8n.execute_workflow")!;
    const executeSchema = Schema.toJsonSchemaDocument(execute.input).schema as {
      properties: Record<string, unknown>;
    };
    expect(executeSchema.properties).toHaveProperty("triggerNodeName");
    const executeInputsSchema = executeSchema.properties.inputs as {
      anyOf: Array<{ properties: Record<string, unknown> }>;
    };
    for (const inputVariant of executeInputsSchema.anyOf) {
      expect(inputVariant.properties).not.toHaveProperty("type");
    }
    await expect(
      Schema.decodeUnknownPromise(execute.input)(
        { workflowId: "wf" },
        { onExcessProperty: "error" },
      ),
    ).rejects.toBeDefined();
    const detailsSchema = Schema.toJsonSchemaDocument(
      N8N_TOOLS.find(({ name }) => name === "n8n.get_workflow_details")!.input,
    ).schema as { properties: Record<string, unknown> };
    expect(detailsSchema.properties).toHaveProperty("detailLevel");
    const sdkReferenceSchema = Schema.toJsonSchemaDocument(
      N8N_TOOLS.find(({ name }) => name === "n8n.get_workflow_sdk_reference")!.input,
    ).schema as { properties: Record<string, unknown> };
    expect(JSON.stringify(sdkReferenceSchema.properties.section)).toContain("groups");
    const updateSchema = Schema.toJsonSchemaDocument(
      N8N_TOOLS.find(({ name }) => name === "n8n.update_workflow")!.input,
    ).schema as { properties: Record<string, unknown> };
    expect(JSON.stringify(updateSchema.properties.operations)).toContain("addNodeGroup");
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
      params: {
        name: "search_projects",
        arguments: { limit: 1 },
        _meta: {
          [MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
          [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
          [MCP_CLIENT_INFO_META_KEY]: { name: "TritonAI Harness", version: "1.0.0" },
        },
      },
    });
    const discover = mock.requests.find(({ body }) => body?.method === "server/discover")!;
    expect(new Headers(discover.init?.headers).get("mcp-method")).toBe("server/discover");
    expect(discover.body?.params).toMatchObject({
      _meta: {
        [MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
        [MCP_CLIENT_INFO_META_KEY]: { name: "TritonAI Harness", version: "1.0.0" },
      },
    });
    expect(mock.requests.some(({ body }) => body?.method === "notifications/initialized")).toBe(
      false,
    );
    const call = mock.requests.at(-1)!;
    expect(new Headers(call.init?.headers).get("mcp-method")).toBe("tools/call");
    expect(new Headers(call.init?.headers).get("mcp-name")).toBe("search_projects");
    await provider.close();
  });

  it("keeps authorization retryable after rejecting an empty callback code", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch();
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );

    const flow = await provider.connect(["read", "write"], lifecycle());
    expect(flow.kind).toBe("authorization_url");
    if (flow.kind !== "authorization_url") throw new Error("expected browser flow");
    const authorization = new URL(flow.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("iss", ORIGIN);
    callback.searchParams.set("code", "");
    expect((await fetch(callback)).status).toBe(400);

    callback.searchParams.set("code", "authorization-code-fixture");
    expect((await fetch(callback)).status).toBe(200);
    await expect(provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
      state: "connected",
    });
    await provider.close();
  });

  it("accepts equivalent local JSON Schema references in the reviewed tool catalog", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({
      mutateTools: (tools) => {
        const update = tools.find(({ name }) => name === "update_workflow")!;
        const schema = update.inputSchema as {
          properties: {
            operations: {
              items: {
                properties: Record<string, unknown>;
              };
            };
          };
        };
        schema.properties.operations.items.properties.position = {
          $ref: "#/properties/operations/items/properties/node/properties/position",
        };
      },
    });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );

    await authorize(provider, mock.requests);
    await expect(provider.status()).resolves.toMatchObject({ state: "connected" });
    await provider.close();
  });

  it("requests read-only OAuth scopes and requires reconnecting before write escalation", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({ scopes: READ_SCOPES });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    const authorization = await authorize(provider, mock.requests, ["read"]);
    expect(authorization.searchParams.get("scope")?.split(" ").toSorted()).toEqual(
      [...READ_SCOPES].toSorted(),
    );
    await expect(provider.status()).resolves.toMatchObject({
      grantedCapabilities: ["read"],
    });
    await expect(provider.connect(["read", "write"], lifecycle())).rejects.toThrow(
      /disconnect and reconnect.*additional access/iu,
    );
    await provider.close();
  });

  it("reflects a custom consent grant instead of rejecting it", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({ scopes: ["workflow:read", "workflow:execute"] });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await authorize(provider, mock.requests);
    expect(mock.requests.filter(({ url }) => url.endsWith("/mcp-oauth/revoke"))).toHaveLength(0);
    expect(
      JSON.parse(new TextDecoder().decode(secrets.values.get(N8N_SECRET_SUFFIX))).scopes,
    ).toEqual(["workflow:execute", "workflow:read"]);
    await expect(provider.status()).resolves.toMatchObject({
      state: "connected",
      grantedCapabilities: ["read", "write"],
    });
    await provider.close();
  });

  it("requests only reviewed scopes the instance offers and ignores scopes it adds later", async () => {
    const withoutAgents = SCOPES.filter((scope) => !scope.startsWith("agent:"));
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({
      scopes: withoutAgents,
      advertisedScopes: [...withoutAgents, "aiPreference:write", "future:scope"],
    });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    const authorization = await authorize(provider, mock.requests);
    expect(authorization.searchParams.get("scope")?.split(" ").toSorted()).toEqual(
      [...withoutAgents].toSorted(),
    );
    await expect(provider.status()).resolves.toMatchObject({
      state: "connected",
      grantedCapabilities: ["read", "write"],
    });
    await provider.close();
  });

  it("refuses to start sign-in when the instance offers none of the reviewed scopes", async () => {
    const mock = oauthMcpFetch({ advertisedScopes: ["future:scope"] });
    const provider = new N8nProvider(
      memorySecrets().service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await expect(provider.connect(["read"], lifecycle())).rejects.toThrow(
      /no longer offers any access/u,
    );
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

  it("keeps unreviewed upstream tools unavailable without blocking the reviewed catalog", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({
      scopes: READ_SCOPES,
      mutateTools: (tools) =>
        tools.push({ name: "future_admin_tool", inputSchema: { type: "object" } }),
    });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await authorize(provider, mock.requests, ["read"]);
    await expect(provider.status()).resolves.toMatchObject({ state: "connected" });
    expect(provider.tools.some(({ name }) => name === "n8n.future_admin_tool")).toBe(false);
    await provider.close();
  });

  it("reports the safe MCP method and HTTP status when connection verification fails", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({
      scopes: READ_SCOPES,
      mcpFailure: { method: "server/discover", status: 500 },
    });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    const flow = await provider.connect(["read"], lifecycle());
    if (flow.kind !== "authorization_url") throw new Error("expected browser flow");
    const authorization = new URL(flow.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("iss", ORIGIN);
    callback.searchParams.set("code", "authorization-code-fixture");
    expect((await fetch(callback)).status).toBe(200);

    await expect(provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
      state: "failed",
      message: "n8n MCP server/discover failed (HTTP 500). Reconnect and try again.",
    });
    expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(false);
    expect(mock.requests.filter(({ url }) => url.endsWith("/mcp-oauth/revoke"))).toHaveLength(1);
    await expect(provider.status()).resolves.toMatchObject({ state: "not_connected" });
    await expect(provider.connect(["read"], lifecycle())).resolves.toMatchObject({
      kind: "authorization_url",
    });
    await provider.close();
  });

  it("pauses only the reviewed tool whose schema or effect metadata drifted", async () => {
    for (const mutateTools of [
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
      await authorize(provider, mock.requests);
      await expect(provider.status()).resolves.toMatchObject({
        state: "connected",
        message: expect.stringMatching(/Paused .*: search_workflows\.$/u),
      });
      await expect(
        provider.invoke("n8n.search_workflows", { query: "x" }, invocation(false)),
      ).rejects.toThrow(/not available/u);
      await expect(
        provider.invoke("n8n.search_projects", { limit: 1 }, invocation(false)),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
      await provider.close();
    }
  });

  it("still fails verification when every reviewed tool drifted", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({
      mutateTools: (tools) => {
        for (const tool of tools) delete tool.annotations;
      },
    });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    const flow = await provider.connect(["read", "write"], lifecycle());
    if (flow.kind !== "authorization_url") throw new Error("expected browser flow");
    const authorization = new URL(flow.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("iss", ORIGIN);
    callback.searchParams.set("code", "code");
    await fetch(callback);
    await expect(provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
      state: "failed",
      message: expect.stringMatching(/changed every reviewed tool/u),
    });
    expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(false);
    await provider.close();
  });

  it(`matches every tool in the pinned n8n ${UPSTREAM_N8N_VERSION} catalog`, () => {
    const reviewed = new Map(REVIEWED_TOOLS.map((tool) => [tool.name.slice("n8n.".length), tool]));
    expect([...reviewed.keys()].toSorted()).toEqual(UPSTREAM_TOOLS.map(({ name }) => name));
    for (const upstream of UPSTREAM_TOOLS) {
      const tool = reviewed.get(upstream.name)!;
      expect(
        firstSchemaDifference(
          schemaContract(upstream.inputSchema),
          schemaContract(expectedSchema(tool)),
        ),
        upstream.name,
      ).toBeNull();
      expect(
        {
          readOnlyHint: tool.upstreamReadOnly,
          destructiveHint: tool.destructive,
          idempotentHint: tool.idempotent,
          openWorldHint: tool.openWorld,
        },
        upstream.name,
      ).toEqual(upstream.annotations);
    }
    const inventory = validateToolInventory({
      tools: UPSTREAM_TOOLS.map(({ name, inputSchema, annotations }) => ({
        name,
        inputSchema,
        annotations,
      })),
    });
    expect(inventory.paused).toEqual([]);
    expect(inventory.available.size).toBe(UPSTREAM_TOOLS.length);
    // Every tool n8n does not mark read-only goes through Harness approval, and one it does mark
    // read-only is overridden because it sends a stored credential to a caller-chosen URL.
    for (const tool of REVIEWED_TOOLS) {
      if (!tool.upstreamReadOnly) expect(tool.readOnly, tool.name).toBe(false);
    }
    expect(
      REVIEWED_TOOLS.filter((tool) => tool.upstreamReadOnly && !tool.readOnly).map(
        ({ name }) => name,
      ),
    ).toEqual(["n8n.verify_agent_mcp_server"]);
  });

  it("decodes upstream-derived inputs strictly", async () => {
    const createFolder = N8N_TOOLS.find(({ name }) => name === "n8n.create_folder")!;
    await expect(
      Schema.decodeUnknownPromise(createFolder.input)(
        { projectId: "p", name: "Reports" },
        { onExcessProperty: "error" },
      ),
    ).resolves.toEqual({ projectId: "p", name: "Reports" });
    for (const input of [
      { projectId: "p" },
      { projectId: "p", name: "x".repeat(129) },
      { projectId: "p", name: "Reports", extra: true },
    ]) {
      await expect(
        Schema.decodeUnknownPromise(createFolder.input)(input, { onExcessProperty: "error" }),
      ).rejects.toBeDefined();
    }
    const rows = N8N_TOOLS.find(({ name }) => name === "n8n.get_data_table_rows")!;
    await expect(
      Schema.decodeUnknownPromise(rows.input)(
        {
          dataTableId: "t",
          projectId: "p",
          filter: { filters: [{ columnName: "status", condition: "eq", value: null }] },
        },
        { onExcessProperty: "error" },
      ),
    ).resolves.toBeDefined();
    await expect(
      Schema.decodeUnknownPromise(rows.input)(
        { dataTableId: "t", projectId: "p", filter: { filters: [] } },
        { onExcessProperty: "error" },
      ),
    ).rejects.toBeDefined();
    const callAgent = N8N_TOOLS.find(({ name }) => name === "n8n.call_agent")!;
    expect(callAgent).toMatchObject({ readOnly: false, destructive: true, openWorld: true });
    await expect(
      Schema.decodeUnknownPromise(callAgent.input)(
        { agentId: "a", request: { type: "message", message: "hi" } },
        { onExcessProperty: "error" },
      ),
    ).resolves.toBeDefined();
    await expect(
      Schema.decodeUnknownPromise(callAgent.input)(
        { agentId: "a", request: { type: "unknown" } },
        { onExcessProperty: "error" },
      ),
    ).rejects.toBeDefined();
  });

  it("accepts a narrowed grant and blocks tools absent from the returned inventory", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({
      scopes: READ_SCOPES,
      mutateTools: (tools) => tools.splice(1),
    });
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await authorize(provider, mock.requests, ["read"]);
    await expect(provider.status()).resolves.toMatchObject({
      grantedCapabilities: ["read"],
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

  it("keeps the rotated refresh token when the recovered MCP session fails", async () => {
    const secrets = memorySecrets();
    const first = oauthMcpFetch();
    const connected = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      first.fetchImplementation,
    );
    await authorize(connected, first.requests);
    await connected.close();

    // n8n has already deleted "refresh-fixture" by the time the session round-trip fails.
    const failing = oauthMcpFetch({ mcpFailure: { method: "server/discover", status: 503 } });
    const interrupted = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      failing.fetchImplementation,
    );
    await expect(interrupted.prepare(lifecycle())).rejects.toThrow();
    await expect(interrupted.prepare(lifecycle())).rejects.not.toMatchObject({
      _tag: "ExternalCommitOutcomeUnknown",
    });
    const stored = JSON.parse(
      new TextDecoder().decode(secrets.values.get(N8N_SECRET_SUFFIX)),
    ) as Record<string, unknown>;
    expect(stored.refreshToken).toBe("refresh-rotated");
    await interrupted.close();

    // The grant survives: a later attempt spends the rotated token instead of re-authorizing.
    const recovered = oauthMcpFetch();
    const resumed = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      recovered.fetchImplementation,
    );
    await resumed.prepare(lifecycle());
    const refreshRequest = recovered.requests.find((request) =>
      request.url.endsWith("/mcp-oauth/token"),
    );
    expect(new URLSearchParams(String(refreshRequest?.init?.body)).get("refresh_token")).toBe(
      "refresh-rotated",
    );
    await expect(resumed.status()).resolves.toMatchObject({ state: "connected" });
    await resumed.close();
  });

  it("clears the credential and asks for a reconnect when n8n rejects the refresh token", async () => {
    const secrets = memorySecrets();
    const first = oauthMcpFetch();
    const connected = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      first.fetchImplementation,
    );
    await authorize(connected, first.requests);
    await connected.close();

    const mock = oauthMcpFetch();
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (
        String(input).endsWith("/mcp-oauth/token") &&
        new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token"
      ) {
        return json({ error: "invalid_grant" }, 400);
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const restored = new N8nProvider(secrets.service, { serverUrl: SERVER }, fetchImplementation);

    await expect(restored.prepare(lifecycle())).rejects.toThrow("n8n sign-in expired.");
    expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(false);
    await expect(restored.status()).resolves.toMatchObject({ state: "not_connected" });
    await restored.close();
  });

  it("still clears the local credential when revocation or OAuth discovery fails", async () => {
    for (const failing of [
      "/mcp-oauth/revoke",
      "/.well-known/oauth-protected-resource/mcp-server/http",
    ]) {
      const secrets = memorySecrets();
      const mock = oauthMcpFetch();
      let connected = false;
      const fetchImplementation = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (connected && String(input).endsWith(failing)) {
            return json({ error: "fixture failure" }, 503);
          }
          return mock.fetchImplementation(input, init);
        },
      ) as unknown as typeof fetch;
      const provider = new N8nProvider(secrets.service, { serverUrl: SERVER }, fetchImplementation);
      await authorize(provider, mock.requests);
      connected = true;

      await expect(provider.disconnect(lifecycle())).resolves.toBeUndefined();
      expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(false);
      expect(
        JSON.parse(new TextDecoder().decode(secrets.values.get(N8N_REVOCATION_SECRET_SUFFIX))),
      ).toMatchObject({
        grants: [{ clientId: "dynamic-client-fixture", refreshToken: "refresh-fixture" }],
      });
      await expect(provider.status()).resolves.toMatchObject({
        state: "not_connected",
        message: expect.stringMatching(/not confirmed revoking/u),
      });

      connected = false;
      const revokesBefore = mock.requests.filter(({ url }) => url.endsWith("/mcp-oauth/revoke"));
      await expect(provider.connect(["read"], lifecycle())).resolves.toMatchObject({
        kind: "authorization_url",
      });
      const revokes = mock.requests
        .filter(({ url }) => url.endsWith("/mcp-oauth/revoke"))
        .slice(revokesBefore.length);
      expect(revokes).toHaveLength(1);
      expect(new URLSearchParams(String(revokes[0]!.init?.body)).get("token")).toBe(
        "refresh-fixture",
      );
      expect(secrets.values.has(N8N_REVOCATION_SECRET_SUFFIX)).toBe(false);
      await expect(provider.status()).resolves.toMatchObject({ message: null });
      await provider.close();
    }
  });

  it("keeps every unrevoked grant across repeated failed disconnects", async () => {
    const secrets = memorySecrets();
    secrets.values.set(
      N8N_REVOCATION_SECRET_SUFFIX,
      new TextEncoder().encode(
        JSON.stringify({
          version: 2,
          serverUrl: SERVER,
          grants: [{ clientId: "dynamic-client-fixture", refreshToken: "older-refresh" }],
        }),
      ),
    );
    const mock = oauthMcpFetch();
    let revokeFails = true;
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (revokeFails && String(input).endsWith("/mcp-oauth/revoke")) {
        return json({ error: "fixture failure" }, 503);
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new N8nProvider(secrets.service, { serverUrl: SERVER }, fetchImplementation);
    await authorize(provider, mock.requests);
    await expect(provider.disconnect(lifecycle())).resolves.toBeUndefined();
    const pending = () =>
      JSON.parse(new TextDecoder().decode(secrets.values.get(N8N_REVOCATION_SECRET_SUFFIX)))
        .grants as Array<{ refreshToken: string }>;
    expect(pending().map(({ refreshToken }) => refreshToken)).toEqual([
      "older-refresh",
      "refresh-fixture",
    ]);

    revokeFails = false;
    await provider.connect(["read"], lifecycle());
    const revoked = mock.requests
      .filter(({ url }) => url.endsWith("/mcp-oauth/revoke"))
      .map(({ init }) => new URLSearchParams(String(init?.body)).get("token"));
    expect(revoked).toEqual(["older-refresh", "refresh-fixture"]);
    expect(secrets.values.has(N8N_REVOCATION_SECRET_SUFFIX)).toBe(false);
    await provider.close();
  });

  it("refuses new sign-ins instead of dropping grants when the revocation queue is full", async () => {
    const secrets = memorySecrets();
    const grants = Array.from({ length: 16 }, (_, index) => ({
      clientId: "dynamic-client-fixture",
      refreshToken: `pending-${index}`,
    }));
    secrets.values.set(
      N8N_REVOCATION_SECRET_SUFFIX,
      new TextEncoder().encode(JSON.stringify({ version: 2, serverUrl: SERVER, grants })),
    );
    const mock = oauthMcpFetch();
    let revokeFails = true;
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (revokeFails && String(input).endsWith("/mcp-oauth/revoke")) {
        return json({ error: "fixture failure" }, 503);
      }
      return mock.fetchImplementation(input, init);
    }) as unknown as typeof fetch;
    const provider = new N8nProvider(secrets.service, { serverUrl: SERVER }, fetchImplementation);

    await expect(provider.connect(["read"], lifecycle())).rejects.toThrow(
      /not confirmed revoking earlier sign-ins/u,
    );
    expect(mock.requests.some(({ url }) => url.endsWith("/mcp-oauth/register"))).toBe(false);
    expect(
      JSON.parse(new TextDecoder().decode(secrets.values.get(N8N_REVOCATION_SECRET_SUFFIX))).grants,
    ).toEqual(grants);
    await expect(provider.status()).resolves.toMatchObject({ state: "not_connected" });

    revokeFails = false;
    await expect(provider.connect(["read"], lifecycle())).resolves.toMatchObject({
      kind: "authorization_url",
    });
    expect(
      mock.requests
        .filter(({ url }) => url.endsWith("/mcp-oauth/revoke"))
        .map(({ init }) => new URLSearchParams(String(init?.body)).get("token")),
    ).toEqual(grants.map(({ refreshToken }) => refreshToken));
    expect(secrets.values.has(N8N_REVOCATION_SECRET_SUFFIX)).toBe(false);
    await provider.close();
  });

  it("does not discard the credential when secret storage fails during disconnect", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch();
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await authorize(provider, mock.requests);
    const get = secrets.service.get;
    secrets.service.get = async () => {
      throw new Error("fixture keychain unavailable");
    };
    await expect(provider.disconnect(lifecycle())).rejects.toThrow(/keychain unavailable/u);
    secrets.service.get = get;
    expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(true);
    expect(mock.requests.filter(({ url }) => url.endsWith("/mcp-oauth/revoke"))).toHaveLength(0);
    await provider.close();
  });

  it("refuses a Write sign-in when the instance offers no write scope", async () => {
    const mock = oauthMcpFetch({ advertisedScopes: READ_SCOPES });
    const provider = new N8nProvider(
      memorySecrets().service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await expect(provider.connect(["read", "write"], lifecycle())).rejects.toThrow(
      /does not currently offer write access/u,
    );
    await expect(provider.connect(["read"], lifecycle())).resolves.toMatchObject({
      kind: "authorization_url",
    });
    await provider.close();
  });

  it("requires write approval for credential-backed MCP server verification", async () => {
    const mock = oauthMcpFetch();
    const provider = new N8nProvider(
      memorySecrets().service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await authorize(provider, mock.requests);
    const input = { projectId: "p", name: "probe", url: "https://example.com/mcp" };
    await expect(
      provider.invoke("n8n.verify_agent_mcp_server", input, invocation(false)),
    ).rejects.toThrow(/explicit Harness approval/u);
    const events: string[] = [];
    await expect(
      provider.invoke("n8n.verify_agent_mcp_server", input, invocation(true, events)),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
    expect(events).toEqual(["beginCommit"]);
    await provider.close();
  });

  it("does not retry a call into a tool the recovered session paused", async () => {
    let listCalls = 0;
    let expireNextCall = false;
    const mock = oauthMcpFetch({
      mutateTools: (tools) => {
        listCalls += 1;
        if (listCalls > 1) {
          const search = tools.find(({ name }) => name === "search_projects")!;
          search.inputSchema = { type: "object", properties: { injected: { type: "string" } } };
        }
      },
    });
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (expireNextCall && String(input) === SERVER && body.includes('"tools/call"')) {
        expireNextCall = false;
        return new Response("", { status: 404 });
      }
      const response = await mock.fetchImplementation(input, init);
      if (String(input) !== SERVER) return response;
      const headers = new Headers(response.headers);
      headers.set("mcp-session-id", "session-fixture");
      return new Response(await response.text(), { status: response.status, headers });
    }) as unknown as typeof fetch;
    const provider = new N8nProvider(
      memorySecrets().service,
      { serverUrl: SERVER },
      fetchImplementation,
    );
    await authorize(provider, mock.requests);
    expireNextCall = true;
    await expect(
      provider.invoke("n8n.search_projects", { limit: 1 }, invocation(false)),
    ).rejects.toThrow(/not available/u);
    expect(listCalls).toBe(2);
    expect(
      mock.requests.filter(
        ({ body }) =>
          body?.method === "tools/call" &&
          (body.params as { name?: string } | undefined)?.name === "search_projects",
      ),
    ).toHaveLength(0);
    await provider.close();
  });

  it("removes an unreadable stored credential on disconnect", async () => {
    const secrets = memorySecrets();
    secrets.values.set(N8N_SECRET_SUFFIX, new TextEncoder().encode("not json"));
    const mock = oauthMcpFetch();
    const provider = new N8nProvider(
      secrets.service,
      { serverUrl: SERVER },
      mock.fetchImplementation,
    );
    await expect(provider.status()).resolves.toMatchObject({ state: "error" });
    await expect(provider.disconnect(lifecycle())).resolves.toBeUndefined();
    expect(secrets.values.has(N8N_SECRET_SUFFIX)).toBe(false);
    expect(mock.requests.filter(({ url }) => url.endsWith("/mcp-oauth/revoke"))).toHaveLength(0);
    await provider.close();
  });

  it("serializes disconnect with authorization-code exchange and revokes the issued credential", async () => {
    const secrets = memorySecrets();
    const mock = oauthMcpFetch({ scopes: READ_SCOPES });
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
    const flow = await provider.connect(["read"], lifecycle());
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
    expect(new URLSearchParams(String(revocations[0]!.init?.body)).get("client_id")).toBe(
      "dynamic-client-fixture",
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
    await expect(provider.connect(["read"], lifecycle())).rejects.toThrow(/size/u);
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
    const pending = cancelled.connect(["read"], context);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/u);
    await cancelled.close();
  });
});
