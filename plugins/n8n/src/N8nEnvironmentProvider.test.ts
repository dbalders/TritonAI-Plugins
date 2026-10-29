import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import manifest from "../.tritonai-plugin/plugin.json" with { type: "json" };
import type {
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationSecretStore,
} from "./host-contract.ts";
import { N8nEnvironmentProvider } from "./N8nEnvironmentProvider.ts";
import {
  N8N_REVOCATION_SECRET_SUFFIX,
  N8N_SECRET_SUFFIX,
  N8N_SERVICE_ENVIRONMENTS,
  N8N_TOOLS,
  N8nProvider,
  type ReviewedTool,
} from "./N8nProvider.ts";

const PROD = "https://n8n.tritonai.ucsd.edu/mcp-server/http";
const PROD_ORIGIN = "https://n8n.tritonai.ucsd.edu";
const DEV = "https://n8n-dev.tritonai.ucsd.edu/mcp-server/http";
const DEV_ORIGIN = "https://n8n-dev.tritonai.ucsd.edu";
const DEV_SECRET = `development.${N8N_SECRET_SUFFIX}`;
const DEV_REVOCATION_SECRET = `development.${N8N_REVOCATION_SECRET_SUFFIX}`;
const MCP_PROTOCOL_VERSION = "2026-07-28";
const SCOPES = [
  "agent:read",
  "aiPreference:read",
  "credential:read",
  "dataTable:read",
  "execution:read",
  "project:read",
  "tag:read",
  "workflow:read",
  "agent:execute",
  "agent:write",
  "communityPackage:install",
  "dataTable:write",
  "project:write",
  "workflow:execute",
  "workflow:write",
] as const;
const READ_SCOPES = SCOPES.slice(0, 8);

const prod = { serviceEnvironment: "production" } as const;
const dev = { serviceEnvironment: "development" } as const;

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

function lifecycle(selection: { readonly serviceEnvironment?: string } = {}) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    ...selection,
    beginCommit: vi.fn(async () => controller.signal),
  } satisfies IntegrationLifecycleContext;
}

function invocation(
  selection: { readonly serviceEnvironment?: string } = {},
): IntegrationInvocationContext {
  return { ...lifecycle(selection), writeApproved: false };
}

function status(selection: { readonly serviceEnvironment?: string } = {}) {
  return { signal: new AbortController().signal, ...selection };
}

function json(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}

function toolInventory() {
  return (N8N_TOOLS as ReadonlyArray<ReviewedTool>).map((tool) => ({
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
}

/** One fake n8n per reviewed origin. Each answers only for itself and records who it served. */
function twoInstanceFetch(options: { readonly devScopes?: ReadonlyArray<string> } = {}) {
  const requests: Array<{
    readonly origin: string;
    readonly path: string;
    readonly body?: unknown;
  }> = [];
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const origin = url.origin;
    if (origin !== PROD_ORIGIN && origin !== DEV_ORIGIN) {
      throw new Error(`unexpected fixture origin: ${origin}`);
    }
    const host = origin === DEV_ORIGIN ? "dev" : "prod";
    const scopes = origin === DEV_ORIGIN ? (options.devScopes ?? SCOPES) : SCOPES;
    const contentType = new Headers(init?.headers).get("content-type") ?? "";
    const body =
      typeof init?.body === "string" && contentType.includes("application/json")
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    requests.push({ origin, path: url.pathname, body });
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp-server/http") {
      return json({
        resource: `${origin}/mcp-server/http`,
        bearer_methods_supported: ["header"],
        authorization_servers: [origin],
        scopes_supported: SCOPES,
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/mcp-oauth/authorize`,
        token_endpoint: `${origin}/mcp-oauth/token`,
        registration_endpoint: `${origin}/mcp-oauth/register`,
        revocation_endpoint: `${origin}/mcp-oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: SCOPES,
      });
    }
    if (url.pathname === "/mcp-oauth/register") {
      return json(
        {
          client_id: `${host}-client`,
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
    if (url.pathname === "/mcp-oauth/token") {
      const form = new URLSearchParams(String(init?.body));
      const refreshing = form.get("grant_type") === "refresh_token";
      return json({
        access_token: `${host}-access${refreshing ? "-rotated" : ""}`,
        refresh_token: `${host}-refresh${refreshing ? "-rotated" : ""}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: scopes.join(" "),
      });
    }
    if (url.pathname === "/mcp-oauth/revoke") return new Response(null, { status: 204 });
    if (url.pathname === "/mcp-server/http" && body) {
      const respond = (result: Record<string, unknown>) =>
        json({ jsonrpc: "2.0", id: body.id, result: { ...result, resultType: "complete" } });
      if (body.method === "server/discover") {
        return respond({ supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} } });
      }
      if (body.method === "tools/list") return respond({ tools: toolInventory() });
      if (body.method === "tools/call") {
        return respond({ content: [{ type: "text", text: `ok from ${host}` }] });
      }
    }
    throw new Error(`unexpected fixture request: ${url.toString()}`);
  }) as unknown as typeof fetch;
  return { fetchImplementation, requests };
}

async function signIn(
  provider: N8nEnvironmentProvider | N8nProvider,
  selection: { readonly serviceEnvironment?: string },
  issuer: string,
): Promise<URL> {
  const flow = await provider.connect(["read", "write"], lifecycle(selection));
  if (flow.kind !== "authorization_url") throw new Error("expected browser flow");
  const authorization = new URL(flow.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("iss", issuer);
  callback.searchParams.set("code", "authorization-code-fixture");
  expect((await fetch(callback)).status).toBe(200);
  await expect(provider.poll(flow.flowId, lifecycle(selection))).resolves.toMatchObject({
    state: "connected",
  });
  return authorization;
}

function storedCredential(serverUrl: string, origin: string, clientId: string) {
  return JSON.stringify({
    version: 1,
    serverUrl,
    issuer: origin,
    clientId,
    refreshToken: `${clientId}-stored-refresh`,
    scopes: [...SCOPES].toSorted(),
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
}

describe("N8nEnvironmentProvider", () => {
  it("declares Prod first and Dev second, matching the reviewed endpoints", () => {
    expect((manifest as { serviceEnvironments?: unknown }).serviceEnvironments).toEqual(
      N8N_SERVICE_ENVIRONMENTS.map(({ id, displayName, description }) => ({
        id,
        displayName,
        description,
      })),
    );
    expect(N8N_SERVICE_ENVIRONMENTS.map(({ id, serverUrl }) => [id, serverUrl])).toEqual([
      ["production", PROD],
      ["development", DEV],
    ]);
    expect((manifest as { sdk: unknown }).sdk).toEqual({
      apiMajor: 1,
      requiredHostContractLevel: 3,
    });
  });

  it("keeps each environment's sign-in, requests, and secrets separate", async () => {
    const secrets = memorySecrets();
    const mock = twoInstanceFetch({ devScopes: READ_SCOPES });
    const provider = new N8nEnvironmentProvider(
      secrets.service,
      { serverUrl: PROD },
      mock.fetchImplementation,
    );

    const devAuthorization = await signIn(provider, dev, DEV_ORIGIN);
    expect(devAuthorization.origin).toBe(DEV_ORIGIN);
    expect(devAuthorization.searchParams.get("resource")).toBe(DEV);
    expect(new Set(mock.requests.map(({ origin }) => origin))).toEqual(new Set([DEV_ORIGIN]));
    expect([...secrets.values.keys()]).toEqual([DEV_SECRET]);
    expect(JSON.parse(secrets.values.get(DEV_SECRET)!)).toMatchObject({
      serverUrl: DEV,
      issuer: DEV_ORIGIN,
      clientId: "dev-client",
    });

    await expect(provider.status(status(dev))).resolves.toEqual({
      state: "connected",
      accountLabel: "n8n-dev.tritonai.ucsd.edu",
      grantedCapabilities: ["read"],
      message: "Connected with the n8n user's own permissions.",
    });
    // A host that predates environments sends no selection and still sees Prod.
    await expect(provider.status(status())).resolves.toEqual({
      state: "not_connected",
      accountLabel: null,
      grantedCapabilities: [],
      message: "Still signed in to Dev.",
    });

    const requestsBeforeProd = mock.requests.length;
    await signIn(provider, prod, PROD_ORIGIN);
    expect(new Set(mock.requests.slice(requestsBeforeProd).map(({ origin }) => origin))).toEqual(
      new Set([PROD_ORIGIN]),
    );
    expect([...secrets.values.keys()].toSorted()).toEqual([DEV_SECRET, N8N_SECRET_SUFFIX]);
    expect(JSON.parse(secrets.values.get(N8N_SECRET_SUFFIX)!)).toMatchObject({
      serverUrl: PROD,
      issuer: PROD_ORIGIN,
      clientId: "prod-client",
    });
    await expect(provider.status(status(prod))).resolves.toMatchObject({
      state: "connected",
      accountLabel: "n8n.tritonai.ucsd.edu",
      grantedCapabilities: ["read", "write"],
      message: "Connected with the n8n user's own permissions. Also signed in to Dev.",
    });
    await expect(provider.status(status(dev))).resolves.toMatchObject({
      grantedCapabilities: ["read"],
      message: "Connected with the n8n user's own permissions. Also signed in to Prod.",
    });

    const beforeCalls = mock.requests.length;
    await expect(
      provider.invoke("n8n.search_projects", { limit: 1 }, invocation(dev)),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "ok from dev" }] });
    await expect(
      provider.invoke("n8n.search_projects", { limit: 1 }, invocation()),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "ok from prod" }] });
    expect(mock.requests.slice(beforeCalls).map(({ origin }) => origin)).toEqual([
      DEV_ORIGIN,
      PROD_ORIGIN,
    ]);
    await provider.close();
  });

  it("keeps an existing Prod sign-in working without re-authorizing", async () => {
    const secrets = memorySecrets();
    secrets.values.set(N8N_SECRET_SUFFIX, storedCredential(PROD, PROD_ORIGIN, "existing-client"));
    const mock = twoInstanceFetch();
    const provider = new N8nEnvironmentProvider(
      secrets.service,
      { serverUrl: PROD },
      mock.fetchImplementation,
    );

    await expect(provider.status(status())).resolves.toMatchObject({
      state: "connected",
      accountLabel: "n8n.tritonai.ucsd.edu",
      grantedCapabilities: ["read", "write"],
    });
    await expect(provider.status(status(dev))).resolves.toMatchObject({
      state: "not_connected",
      message: "Still signed in to Prod.",
    });
    await provider.prepare(lifecycle(prod));
    await expect(
      provider.invoke("n8n.search_projects", { limit: 1 }, invocation(prod)),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "ok from prod" }] });
    expect(mock.requests.some(({ path }) => path === "/mcp-oauth/register")).toBe(false);
    expect(new Set(mock.requests.map(({ origin }) => origin))).toEqual(new Set([PROD_ORIGIN]));
    expect(JSON.parse(secrets.values.get(N8N_SECRET_SUFFIX)!)).toMatchObject({
      clientId: "existing-client",
      refreshToken: "prod-refresh-rotated",
    });
    await provider.close();
  });

  it("disconnects only the selected environment", async () => {
    const secrets = memorySecrets();
    secrets.values.set(N8N_SECRET_SUFFIX, storedCredential(PROD, PROD_ORIGIN, "prod-client"));
    secrets.values.set(DEV_SECRET, storedCredential(DEV, DEV_ORIGIN, "dev-client"));
    const mock = twoInstanceFetch();
    const provider = new N8nEnvironmentProvider(
      secrets.service,
      { serverUrl: PROD },
      mock.fetchImplementation,
    );

    await provider.disconnect(lifecycle(dev));
    expect(secrets.values.has(DEV_SECRET)).toBe(false);
    expect(secrets.values.has(DEV_REVOCATION_SECRET)).toBe(false);
    expect(secrets.values.get(N8N_SECRET_SUFFIX)).toBe(
      storedCredential(PROD, PROD_ORIGIN, "prod-client"),
    );
    const revocations = mock.requests.filter(({ path }) => path === "/mcp-oauth/revoke");
    expect(revocations.length).toBeGreaterThan(0);
    expect(new Set(revocations.map(({ origin }) => origin))).toEqual(new Set([DEV_ORIGIN]));
    await expect(provider.status(status(dev))).resolves.toMatchObject({
      state: "not_connected",
      message: "Still signed in to Prod.",
    });
    await expect(provider.status(status(prod))).resolves.toMatchObject({
      state: "connected",
      message: "Connected with the n8n user's own permissions.",
    });
    await provider.close();
  });

  it("rejects an environment this plugin version does not declare", async () => {
    const mock = twoInstanceFetch();
    const provider = new N8nEnvironmentProvider(
      memorySecrets().service,
      { serverUrl: PROD },
      mock.fetchImplementation,
    );
    const staging = { serviceEnvironment: "staging" };
    const message = /not available in this plugin version/u;
    await expect(provider.status(status(staging))).resolves.toEqual({
      state: "error",
      accountLabel: null,
      grantedCapabilities: [],
      message: "This n8n environment is not available in this plugin version.",
    });
    await expect(provider.connect(["read"], lifecycle(staging))).rejects.toThrow(message);
    await expect(provider.poll("flow", lifecycle(staging))).rejects.toThrow(message);
    await expect(provider.prepare(lifecycle(staging))).rejects.toThrow(message);
    await expect(provider.disconnect(lifecycle(staging))).rejects.toThrow(message);
    await expect(
      provider.invoke("n8n.search_projects", { limit: 1 }, invocation(staging)),
    ).rejects.toThrow(message);
    expect(mock.requests).toHaveLength(0);
    await provider.close();
  });

  it("binds each reviewed endpoint to its own secrets and refuses look-alikes", async () => {
    expect(() => new N8nEnvironmentProvider(memorySecrets().service, { serverUrl: DEV })).toThrow(
      /reviewed server URL/u,
    );
    for (const serverUrl of [
      "https://n8n-dev.tritonai.ucsd.edu/mcp-server/http/",
      "https://n8n-dev.tritonai.ucsd.edu:8443/mcp-server/http",
      "https://evil-n8n-dev.tritonai.ucsd.edu/mcp-server/http",
      "http://n8n-dev.tritonai.ucsd.edu/mcp-server/http",
      "https://n8n-dev.tritonai.ucsd.edu/mcp-server/http?x=1",
    ]) {
      expect(() => new N8nProvider(memorySecrets().service, { serverUrl })).toThrow(
        /reviewed HTTPS MCP server URL/u,
      );
    }

    const secrets = memorySecrets();
    const mock = twoInstanceFetch();
    const devOnly = new N8nProvider(secrets.service, { serverUrl: DEV }, mock.fetchImplementation);
    await signIn(devOnly, {}, DEV_ORIGIN);
    expect([...secrets.values.keys()]).toEqual([DEV_SECRET]);
    await devOnly.close();
  });
});
