import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import {
  type IntegrationAuthorizationUrlConnectResult,
  type IntegrationConnectedConnectResult,
  type IntegrationConnectionSubmission,
  type IntegrationInvocationContext,
  type IntegrationLifecycleContext,
  type IntegrationOperationContext,
  type IntegrationProviderPollResult,
  type IntegrationProviderStatus,
  type IntegrationSecretStore,
  type JsonObject,
  type JsonValue,
  ExternalCommitOutcomeUnknownError,
  IntegrationProviderPublicError,
} from "../host-contract.js";
import {
  type CompiledSchema,
  type JsonSchema,
  compatibleUpstreamSchema,
  compileSchema,
} from "./json-schema.js";
import {
  MAX_INPUT_BYTES,
  asRecord,
  assertJsonBounds,
  boundedString,
  parseJson,
  eventStreamHasResponse,
  parseMcpPayload,
  randomBase64Url,
  readResponseBytes,
  timingSafeTextEqual,
} from "./transport.js";

/** Secret suffix holding the versioned refresh credential. */
export const OAUTH_SECRET_SUFFIX = "oauth";
/** Disconnected grants the service has not yet confirmed revoking, retried later. */
export const REVOCATION_SECRET_SUFFIX = "oauth-revocation";

const CALLBACK_PATH = "/oauth2/callback";
const CLIENT_INFO = { name: "TritonAI Harness", version: "1.0.0" } as const;
// Classic Streamable HTTP handshake versions, newest first. The 2026-07-28 stateless revision
// replaces `initialize` with `server/discover`; it is used only when a server refuses
// `initialize`.
const INITIALIZE_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const DISCOVER_PROTOCOL_VERSION = "2026-07-28";
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
// The host bounds every provider operation, including the commit tail, at 30 seconds.
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_REQUEST_TIMEOUT_MS = 25_000;
// A tool call may run server-side work up to about 25 seconds (Lucid scripts, for example) and
// still has to settle inside the host's 30-second operation deadline.
const TOOL_CALL_TIMEOUT_MS = 28_000;
const REVOCATION_RETRY_BUDGET_MS = 5_000;
const FLOW_LIFETIME_MS = 5 * 60_000;
const FLOW_CALLBACK_CLAIM_MS = 60_000;
const FLOW_POLL_SECONDS = 2;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const DEFAULT_ACCESS_TOKEN_SECONDS = 3_600;
const METADATA_RESPONSE_BYTES = 128 * 1024;
const TOKEN_RESPONSE_BYTES = 128 * 1024;
const MCP_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MCP_TOOL_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOKEN_CHARS = 16_384;
const MAX_CLIENT_ID_CHARS = 2_048;
const MAX_SESSION_ID_CHARS = 1_024;
const MAX_MCP_PAGES = 8;
const MAX_MCP_TOOLS = 256;
const MAX_ADVERTISED_SCOPES = 256;
const MAX_REJECTION_DETAIL_CHARS = 2_000;
// Grants are never dropped before the service confirms revoking them. A sign-in reserves room for
// everything it can queue and is refused otherwise. Disconnect always queues, keeping the queue
// within a few entries of MAX_PENDING_REVOCATIONS without ever blocking a reset.
const MAX_PENDING_REVOCATIONS = 16;
// JSON-RPC parse, invalid request, method not found, and invalid params errors are raised before
// the tool runs. Server and internal errors may follow a partial write, so they stay ambiguous.
const PRE_DISPATCH_JSON_RPC_ERRORS = new Set([-32_700, -32_600, -32_601, -32_602]);

export interface UpstreamToolAnnotations {
  readonly readOnlyHint: boolean | null;
  readonly destructiveHint: boolean | null;
  readonly idempotentHint: boolean | null;
  readonly openWorldHint: boolean | null;
}

/** One tool exactly as the remote server listed it when the plugin was reviewed. */
export interface UpstreamToolSnapshot {
  readonly name: string;
  readonly title: string | null;
  readonly annotations: UpstreamToolAnnotations;
  readonly inputSchema: JsonSchema;
}

/** A reviewed local tool that proxies exactly one pinned upstream tool. */
export interface RemoteMcpTool {
  readonly name: string;
  readonly upstreamName: string;
  readonly displayName: string;
  readonly description: string;
  readonly capability: string;
  readonly effect: "read" | "write";
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  /** The sealed manifest input schema. */
  readonly inputSchema: JsonSchema;
  /** The pinned upstream definition that drift detection compares against. */
  readonly upstream: UpstreamToolSnapshot;
}

export interface RemoteMcpEndpoint {
  /** Path on the reviewed origin, also the OAuth protected-resource identifier's path. */
  readonly path: string;
  /** Capabilities a grant for this endpoint can serve. */
  readonly capabilities: ReadonlyArray<string>;
  /** Short, user-facing access label, for example "Read-only". */
  readonly label: string;
  /**
   * Whether the service can revoke grants for this endpoint. Lucid's revocation endpoint rejects
   * every read-only grant, so those are deleted locally and left to expire instead of being
   * retried forever.
   */
  readonly revocable?: boolean;
}

export interface RemoteMcpPolicy {
  readonly providerId: string;
  /** User-facing service name used in messages. */
  readonly serviceName: string;
  /** The single reviewed HTTPS origin for MCP, OAuth discovery, and every OAuth endpoint. */
  readonly origin: string;
  /** Ordered least-privileged first; sign-in uses the first endpoint covering the request. */
  readonly endpoints: ReadonlyArray<RemoteMcpEndpoint>;
  readonly oauth: {
    readonly clientName: string;
    /** Scopes requested when the authorization server advertises them. */
    readonly scopes: ReadonlyArray<string>;
    readonly paths: {
      readonly authorization: string;
      readonly token: string;
      readonly registration: string;
      readonly revocation: string;
    };
    /** Require RFC 9207 `iss` on the callback. Servers that do not advertise it cannot. */
    readonly requireIssuerParameter: boolean;
    /**
     * `rfc7009` posts the token as RFC 7009 describes. `bearer` also authenticates the request with
     * an access token from the same grant, which Lucid requires; a grant held only as a refresh
     * token is refreshed first to obtain one.
     */
    readonly revocation: "rfc7009" | "bearer";
  };
  readonly tools: ReadonlyArray<RemoteMcpTool>;
  /** Appended to a tool-level error from a write so the agent checks state before retrying. */
  readonly writeFailureNote: string;
}

interface OAuthDiscovery {
  readonly issuer: string;
  /** Whether the callback must carry RFC 9207 `iss`: required by policy or advertised. */
  readonly requireIssuer: boolean;
  readonly scopes: ReadonlyArray<string>;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
  readonly revocationEndpoint: string;
}

interface Credential {
  readonly version: 1;
  readonly origin: string;
  readonly endpoint: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly updatedAt: string;
}

interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly endpoint: RemoteMcpEndpoint;
}

type CallbackResult =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "error"; readonly error: string };

interface PendingFlow {
  readonly flowId: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  clientId: string;
  readonly endpoint: RemoteMcpEndpoint;
  readonly discovery: OAuthDiscovery;
  readonly expiresAt: number;
  readonly generation: number;
  readonly server: NodeHttp.Server;
  timer: NodeJS.Timeout;
  callbackExpiresAt: number | null;
  callback: CallbackResult | null;
  consumed: boolean;
  closePromise: Promise<void> | null;
}

interface PendingRevocation {
  readonly clientId: string;
  readonly refreshToken: string;
  /** Endpoint path the grant was issued for; absent in records from earlier versions. */
  readonly endpoint?: string;
}

type Protocol =
  | { readonly mode: "initialize"; readonly version: string }
  | { readonly mode: "discover" };

type Fetch = typeof globalThis.fetch;

class SessionInvalidError extends Error {}
class ConfirmedRemoteFailure extends IntegrationProviderPublicError {}
// The service refused the request before running it, so a write was not applied.
class RemoteRejection extends ConfirmedRemoteFailure {}
// A refusal of the request's shape or method rather than of the caller. During the handshake it
// identifies a server on the other protocol revision.
class ProtocolRejection extends RemoteRejection {}
// The service rejected the access token before running the request.
class AuthorizationExpired extends RemoteRejection {}
// A revocation that failed after the grant was refreshed; the replacement token must stay queued.
class RevocationIncomplete extends ConfirmedRemoteFailure {
  constructor(
    message: string,
    readonly replacement: PendingRevocation | null,
  ) {
    super(message);
  }
}

function rejectedToolResult(message: string): JsonObject {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function normalizedHints(value: unknown): UpstreamToolAnnotations {
  const hints =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const hint = (key: string) => (typeof hints[key] === "boolean" ? (hints[key] as boolean) : null);
  return {
    readOnlyHint: hint("readOnlyHint"),
    destructiveHint: hint("destructiveHint"),
    idempotentHint: hint("idempotentHint"),
    openWorldHint: hint("openWorldHint"),
  };
}

export interface ToolInventory {
  readonly available: ReadonlySet<string>;
  /** Reviewed tools whose upstream contract or safety hints changed. */
  readonly paused: ReadonlyArray<string>;
  /** Reviewed tools for this endpoint's abilities that the endpoint does not list. */
  readonly unoffered: ReadonlyArray<string>;
}

/**
 * Compares a live tool list with the reviewed catalog. A reviewed tool whose input contract or
 * safety hints changed is paused on its own; tools the plugin has not reviewed are ignored. Only
 * the tools reviewed for this endpoint's capabilities are considered.
 */
export function validateToolInventory(
  policy: Pick<RemoteMcpPolicy, "serviceName" | "tools">,
  endpoint: RemoteMcpEndpoint,
  tools: ReadonlyArray<unknown>,
): ToolInventory {
  if (tools.length > MAX_MCP_TOOLS) {
    throw new Error(`${policy.serviceName} MCP tool inventory is too large.`);
  }
  const live = new Map<string, Record<string, unknown>>();
  for (const raw of tools) {
    const tool = asRecord(raw, `${policy.serviceName} MCP tool definition`);
    const name = boundedString(tool.name, 128, `${policy.serviceName} MCP tool name`);
    if (live.has(name)) throw new Error(`${policy.serviceName} MCP returned duplicate tools.`);
    live.set(name, tool);
  }
  const served = new Set(endpoint.capabilities);
  const available = new Set<string>();
  const paused: string[] = [];
  const unoffered: string[] = [];
  for (const reviewed of policy.tools) {
    if (!served.has(reviewed.capability)) continue;
    const upstream = live.get(reviewed.upstreamName);
    if (!upstream) {
      unoffered.push(reviewed.name);
      continue;
    }
    const hints = normalizedHints(upstream.annotations);
    const pinned = reviewed.upstream.annotations;
    if (
      !compatibleUpstreamSchema(upstream.inputSchema, reviewed.upstream.inputSchema) ||
      hints.readOnlyHint !== pinned.readOnlyHint ||
      hints.destructiveHint !== pinned.destructiveHint ||
      hints.idempotentHint !== pinned.idempotentHint ||
      hints.openWorldHint !== pinned.openWorldHint
    ) {
      paused.push(reviewed.name);
      continue;
    }
    available.add(reviewed.upstreamName);
  }
  if (available.size === 0) {
    throw new IntegrationProviderPublicError(
      paused.length > 0
        ? `${policy.serviceName} changed every reviewed tool (${paused.toSorted().join(", ")}). Update the TritonAI ${policy.serviceName} plugin before use.`
        : `${policy.serviceName} no longer offers any reviewed tools. Update the TritonAI ${policy.serviceName} plugin before use.`,
    );
  }
  return { available, paused: paused.toSorted(), unoffered: unoffered.toSorted() };
}

function parsePendingRevocations(encoded: string): PendingRevocation[] {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return [];
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const entries = record
    ? Array.isArray((record as Record<string, unknown>).grants)
      ? ((record as Record<string, unknown>).grants as unknown[])
      : []
    : [];
  const grants: PendingRevocation[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { clientId, refreshToken, endpoint } = entry as Record<string, unknown>;
    if (
      typeof clientId === "string" &&
      clientId.length > 0 &&
      clientId.length <= MAX_CLIENT_ID_CHARS &&
      typeof refreshToken === "string" &&
      refreshToken.length > 0 &&
      refreshToken.length <= MAX_TOKEN_CHARS &&
      !grants.some((grant) => grant.refreshToken === refreshToken)
    ) {
      grants.push({
        clientId,
        refreshToken,
        ...(typeof endpoint === "string" && endpoint.length <= 256 ? { endpoint } : {}),
      });
    }
  }
  return grants;
}

function validatePolicy(policy: RemoteMcpPolicy): URL {
  const origin = new URL(policy.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== policy.origin ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    throw new Error("Remote MCP policy requires a bare HTTPS origin.");
  }
  if (policy.endpoints.length === 0) throw new Error("Remote MCP policy declares no endpoints.");
  const capabilities = new Set(policy.endpoints.flatMap((endpoint) => endpoint.capabilities));
  for (const endpoint of policy.endpoints) {
    if (!/^\/[A-Za-z0-9/_-]*$/u.test(endpoint.path) || endpoint.path.endsWith("/")) {
      throw new Error("Remote MCP endpoint path is invalid.");
    }
  }
  const names = new Set<string>();
  const upstreamNames = new Set<string>();
  for (const tool of policy.tools) {
    if (names.has(tool.name) || upstreamNames.has(tool.upstreamName)) {
      throw new Error(`Remote MCP tool ${tool.name} is declared twice.`);
    }
    names.add(tool.name);
    upstreamNames.add(tool.upstreamName);
    if (!capabilities.has(tool.capability)) {
      throw new Error(`Remote MCP tool ${tool.name} has an unserved capability.`);
    }
    if (tool.upstream.name !== tool.upstreamName) {
      throw new Error(`Remote MCP tool ${tool.name} is pinned to the wrong upstream tool.`);
    }
    if (tool.effect === "read" && tool.destructive) {
      throw new Error(`Remote MCP read tool ${tool.name} cannot be destructive.`);
    }
  }
  return origin;
}

/**
 * A reviewed proxy for one remote Streamable HTTP MCP server that uses OAuth discovery, dynamic
 * client registration, PKCE, and a loopback redirect. The policy pins the origin, endpoints,
 * and exact tool catalog; the remote tool list can only narrow what is available.
 */
export class RemoteMcpProvider {
  readonly id: string;
  readonly #policy: RemoteMcpPolicy;
  readonly #origin: URL;
  readonly #secrets: IntegrationSecretStore;
  readonly #fetch: Fetch;
  readonly #requestTimeoutMs: number;
  readonly #validators: ReadonlyMap<string, CompiledSchema>;
  readonly #pending = new Map<string, PendingFlow>();
  readonly #polling = new Set<string>();
  readonly #requestControllers = new Set<AbortController>();
  #accessToken: AccessToken | null = null;
  #protocol: Protocol | null = null;
  #sessionId: string | null = null;
  #sessionVerified = false;
  /** The access token the verified session belongs to. */
  #sessionAccess: AccessToken | null = null;
  #availableTools: ReadonlySet<string> = new Set();
  #pausedTools: ReadonlyArray<string> = [];
  #unofferedTools: ReadonlyArray<string> = [];
  /** The last refresh hit a transient outage; the stored grant is fine and the next prepare retries. */
  #renewalDeferred = false;
  #generation = 0;
  #connectAttempt = 0;
  #credentialRevision = 0;
  #rpcSequence = 0;
  #closed = false;
  #disconnecting = false;
  #uncertainCredentialState = false;
  #credentialMutation: Promise<void> = Promise.resolve();
  #sessionMutation: Promise<void> = Promise.resolve();

  constructor(
    policy: RemoteMcpPolicy,
    secrets: IntegrationSecretStore,
    fetchImplementation: Fetch = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.#origin = validatePolicy(policy);
    this.#policy = policy;
    this.id = policy.providerId;
    this.#secrets = secrets;
    this.#fetch = fetchImplementation;
    if (
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new Error("Remote MCP provider requires a bounded request timeout.");
    }
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#validators = new Map(
      policy.tools.map((tool) => [tool.name, compileSchema(tool.inputSchema)]),
    );
  }

  get #name(): string {
    return this.#policy.serviceName;
  }

  #endpointUrl(endpoint: RemoteMcpEndpoint): string {
    return new URL(endpoint.path, this.#origin).toString();
  }

  #endpointForPath(path: string): RemoteMcpEndpoint | null {
    return this.#policy.endpoints.find((endpoint) => endpoint.path === path) ?? null;
  }

  #serializeCredential<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#credentialMutation.then(operation, operation);
    this.#credentialMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #serializeSession<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#sessionMutation.then(operation, operation);
    this.#sessionMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #resetSession(): void {
    this.#protocol = null;
    this.#sessionId = null;
    this.#sessionVerified = false;
    this.#sessionAccess = null;
    this.#availableTools = new Set();
    this.#pausedTools = [];
    this.#unofferedTools = [];
  }

  async #request(
    url: string,
    init: RequestInit,
    maximumBytes: number,
    timeoutMs = this.#requestTimeoutMs,
    isComplete?: (response: Response, bytes: Uint8Array) => boolean,
  ): Promise<{ readonly response: Response; readonly bytes: Uint8Array }> {
    if (this.#closed) throw new Error(`${this.#name} provider is closed.`);
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      throw new Error(`${this.#name} request endpoint is invalid.`);
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.origin !== this.#origin.origin ||
      endpoint.username !== "" ||
      endpoint.password !== ""
    ) {
      throw new Error(`${this.#name} request endpoint is outside the reviewed origin.`);
    }
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    this.#requestControllers.add(controller);
    const signals = [controller.signal, timeoutSignal];
    if (init.signal) signals.push(init.signal);
    try {
      const response = await this.#fetch(endpoint.toString(), {
        ...init,
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
      return {
        response,
        bytes: await readResponseBytes(
          response,
          maximumBytes,
          `${this.#name} response`,
          isComplete ? (bytes) => isComplete(response, bytes) : undefined,
        ),
      };
    } catch (error) {
      if (init.signal?.aborted) {
        throw new IntegrationProviderPublicError(`${this.#name} request was cancelled.`);
      }
      if (controller.signal.aborted || this.#closed) {
        throw new Error(`${this.#name} provider was closed.`, { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new IntegrationProviderPublicError(`${this.#name} request timed out.`);
      }
      throw error;
    } finally {
      this.#requestControllers.delete(controller);
    }
  }

  async #requestJson(
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<{ readonly response: Response; readonly json: Record<string, unknown> }> {
    const { response, bytes } = await this.#request(url, init, maximumBytes);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok) {
      // A refused request issued nothing. Hand callers the status, and the OAuth error body when
      // there is one, instead of failing on a gateway's HTML error page.
      let json: Record<string, unknown> = {};
      if (contentType.includes("application/json")) {
        try {
          json = parseJson(bytes, `${this.#name} OAuth response`);
        } catch {
          json = {};
        }
      }
      return { response, json };
    }
    if (!contentType.includes("application/json")) {
      throw new Error(`${this.#name} OAuth endpoint returned an invalid content type.`);
    }
    return { response, json: parseJson(bytes, `${this.#name} OAuth response`) };
  }

  #sameOriginEndpoint(value: unknown, path: string, label: string): string {
    const raw = boundedString(value, 2_048, label);
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      throw new Error(`${label} is invalid.`);
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.origin !== this.#origin.origin ||
      endpoint.pathname !== path ||
      endpoint.search !== "" ||
      endpoint.hash !== "" ||
      endpoint.username !== "" ||
      endpoint.password !== ""
    ) {
      throw new Error(`${label} is outside the reviewed origin.`);
    }
    return endpoint.toString();
  }

  #advertisedScopes(value: unknown, label: string): ReadonlySet<string> {
    if (value === undefined) return new Set();
    if (
      !Array.isArray(value) ||
      value.length > MAX_ADVERTISED_SCOPES ||
      value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 128)
    ) {
      throw new Error(`${label} is invalid.`);
    }
    return new Set(value as string[]);
  }

  async #discover(endpoint: RemoteMcpEndpoint, signal?: AbortSignal): Promise<OAuthDiscovery> {
    const protectedUrl = new URL(
      `/.well-known/oauth-protected-resource${endpoint.path}`,
      this.#origin,
    );
    const { response: protectedResponse, json: resource } = await this.#requestJson(
      protectedUrl.toString(),
      { method: "GET", headers: { accept: "application/json" }, signal: signal ?? null },
      METADATA_RESPONSE_BYTES,
    );
    if (!protectedResponse.ok) {
      throw new Error(`${this.#name} OAuth protected-resource discovery failed.`);
    }
    if (resource.resource !== this.#endpointUrl(endpoint)) {
      throw new Error(`${this.#name} OAuth resource metadata did not bind the reviewed endpoint.`);
    }
    if (
      resource.bearer_methods_supported !== undefined &&
      (!Array.isArray(resource.bearer_methods_supported) ||
        !resource.bearer_methods_supported.includes("header"))
    ) {
      throw new Error(`${this.#name} OAuth bearer method drifted from the reviewed contract.`);
    }
    if (
      !Array.isArray(resource.authorization_servers) ||
      resource.authorization_servers.length !== 1
    ) {
      throw new Error(`${this.#name} OAuth authorization server metadata is invalid.`);
    }
    const issuer = this.#sameOriginEndpoint(
      resource.authorization_servers[0],
      "/",
      `${this.#name} OAuth authorization server`,
    ).replace(/\/$/u, "");
    const { response, json } = await this.#requestJson(
      new URL("/.well-known/oauth-authorization-server", issuer).toString(),
      { method: "GET", headers: { accept: "application/json" }, signal: signal ?? null },
      METADATA_RESPONSE_BYTES,
    );
    if (!response.ok || json.issuer !== issuer) {
      throw new Error(`${this.#name} OAuth authorization metadata is invalid.`);
    }
    const advertised = this.#advertisedScopes(
      json.scopes_supported,
      `${this.#name} OAuth scope metadata`,
    );
    if (
      !Array.isArray(json.response_types_supported) ||
      !json.response_types_supported.includes("code") ||
      !Array.isArray(json.grant_types_supported) ||
      !json.grant_types_supported.includes("authorization_code") ||
      !json.grant_types_supported.includes("refresh_token") ||
      !Array.isArray(json.token_endpoint_auth_methods_supported) ||
      !json.token_endpoint_auth_methods_supported.includes("none") ||
      !Array.isArray(json.code_challenge_methods_supported) ||
      !json.code_challenge_methods_supported.includes("S256") ||
      (this.#policy.oauth.requireIssuerParameter &&
        json.authorization_response_iss_parameter_supported !== true)
    ) {
      throw new Error(`${this.#name} OAuth protocol metadata drifted from the reviewed contract.`);
    }
    const paths = this.#policy.oauth.paths;
    return {
      issuer,
      requireIssuer:
        this.#policy.oauth.requireIssuerParameter ||
        json.authorization_response_iss_parameter_supported === true,
      scopes: this.#policy.oauth.scopes.filter((scope) => advertised.has(scope)),
      authorizationEndpoint: this.#sameOriginEndpoint(
        json.authorization_endpoint,
        paths.authorization,
        `${this.#name} OAuth authorization endpoint`,
      ),
      tokenEndpoint: this.#sameOriginEndpoint(
        json.token_endpoint,
        paths.token,
        `${this.#name} OAuth token endpoint`,
      ),
      registrationEndpoint: this.#sameOriginEndpoint(
        json.registration_endpoint,
        paths.registration,
        `${this.#name} OAuth registration endpoint`,
      ),
      revocationEndpoint: this.#sameOriginEndpoint(
        json.revocation_endpoint,
        paths.revocation,
        `${this.#name} OAuth revocation endpoint`,
      ),
    };
  }

  async #registerClient(
    discovery: OAuthDiscovery,
    redirectUri: string,
    signal: AbortSignal,
  ): Promise<string> {
    const request: Record<string, unknown> = {
      client_name: this.#policy.oauth.clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    if (discovery.scopes.length > 0) request.scope = discovery.scopes.join(" ");
    const { response, json } = await this.#requestJson(
      discovery.registrationEndpoint,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      },
      METADATA_RESPONSE_BYTES,
    );
    if (response.status !== 200 && response.status !== 201) {
      throw new ConfirmedRemoteFailure(`${this.#name} could not register this local OAuth client.`);
    }
    // A public client never uses a secret. Some servers echo one anyway; accept that only when
    // the registration explicitly stays a public client, and never store or send it.
    if (
      (json.client_secret !== undefined && json.token_endpoint_auth_method !== "none") ||
      (json.token_endpoint_auth_method !== undefined &&
        json.token_endpoint_auth_method !== "none") ||
      (json.redirect_uris !== undefined &&
        (!Array.isArray(json.redirect_uris) ||
          json.redirect_uris.length !== 1 ||
          json.redirect_uris[0] !== redirectUri)) ||
      (json.grant_types !== undefined &&
        (!Array.isArray(json.grant_types) ||
          !json.grant_types.includes("authorization_code") ||
          !json.grant_types.includes("refresh_token"))) ||
      (json.response_types !== undefined &&
        (!Array.isArray(json.response_types) || !json.response_types.includes("code")))
    ) {
      throw new Error(`${this.#name} dynamic client registration output is unsafe.`);
    }
    return boundedString(
      json.client_id,
      MAX_CLIENT_ID_CHARS,
      `${this.#name} dynamic client registration`,
    );
  }

  #parseCredential(encoded: string): Credential {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new Error(`Stored ${this.#name} credential is invalid.`);
    }
    const value = asRecord(parsed, `Stored ${this.#name} credential`);
    const allowed = new Set([
      "version",
      "origin",
      "endpoint",
      "issuer",
      "clientId",
      "refreshToken",
      "updatedAt",
    ]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      value.version !== 1 ||
      value.origin !== this.#origin.origin ||
      value.issuer !== this.#origin.origin ||
      typeof value.endpoint !== "string" ||
      !this.#endpointForPath(value.endpoint) ||
      typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.updatedAt))
    ) {
      throw new Error(`Stored ${this.#name} credential is invalid.`);
    }
    return {
      version: 1,
      origin: value.origin,
      endpoint: value.endpoint,
      issuer: value.issuer,
      clientId: boundedString(value.clientId, MAX_CLIENT_ID_CHARS, "Stored credential"),
      refreshToken: boundedString(value.refreshToken, MAX_TOKEN_CHARS, "Stored credential"),
      updatedAt: value.updatedAt,
    };
  }

  async #readCredential(signal?: AbortSignal): Promise<Credential | null> {
    if (signal?.aborted) {
      throw new IntegrationProviderPublicError(`${this.#name} request was cancelled.`);
    }
    const value = await this.#secrets.get(OAUTH_SECRET_SUFFIX);
    if (signal?.aborted) {
      throw new IntegrationProviderPublicError(`${this.#name} request was cancelled.`);
    }
    return value === null ? null : this.#parseCredential(value);
  }

  async #writeCredential(
    credential: Credential,
    signal: AbortSignal,
    onPersisted?: () => void,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.#secrets.set(OAUTH_SECRET_SUFFIX, JSON.stringify(credential));
    onPersisted?.();
    signal.throwIfAborted();
  }

  async #beginCommit(context?: IntegrationLifecycleContext): Promise<AbortSignal> {
    if (!context || typeof context.beginCommit !== "function") {
      throw new Error(`${this.#name} credential mutation requires Harness commit admission.`);
    }
    return context.beginCommit();
  }

  async #closeFlowListener(flow: PendingFlow, clearExpiryTimer: boolean): Promise<void> {
    if (clearExpiryTimer) clearTimeout(flow.timer);
    if (flow.closePromise) {
      if (clearExpiryTimer) flow.server.closeAllConnections();
      return flow.closePromise;
    }
    flow.closePromise = new Promise<void>((resolve) => {
      if (!flow.server.listening) {
        resolve();
        return;
      }
      flow.server.close(() => resolve());
      flow.server.closeIdleConnections();
      if (clearExpiryTimer) flow.server.closeAllConnections();
    });
    return flow.closePromise;
  }

  async #removeFlow(flowId: string): Promise<void> {
    const flow = this.#pending.get(flowId);
    if (!flow) return;
    this.#pending.delete(flowId);
    await this.#closeFlowListener(flow, true);
  }

  async #clearPendingFlows(): Promise<void> {
    const flows = [...this.#pending.values()];
    this.#pending.clear();
    await Promise.all(flows.map((flow) => this.#closeFlowListener(flow, true)));
  }

  #writeCallbackPage(response: NodeHttp.ServerResponse, status: number, message: string): void {
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>TritonAI Harness</title></head><body><main><h1>${message}</h1><p>You can close this window and return to TritonAI Harness.</p></main></body></html>`;
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      connection: "close",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  #handleCallback(
    flow: PendingFlow,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ): void {
    const invalid = `This ${this.#name} sign-in callback is not valid.`;
    const address = flow.server.address();
    const expectedHost = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
    const remote = request.socket.remoteAddress;
    if (
      request.method !== "GET" ||
      request.headers.host !== expectedHost ||
      (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") ||
      flow.expiresAt <= Date.now() ||
      flow.generation !== this.#generation ||
      this.#closed ||
      this.#disconnecting ||
      this.#pending.get(flow.flowId) !== flow
    ) {
      this.#writeCallbackPage(response, 400, invalid);
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", `http://${expectedHost}`);
    } catch {
      this.#writeCallbackPage(response, 400, invalid);
      return;
    }
    const allowed = new Set([
      "state",
      "iss",
      "code",
      "scope",
      "error",
      "error_description",
      "error_uri",
    ]);
    const issuer = url.searchParams.get("iss");
    if (
      url.pathname !== CALLBACK_PATH ||
      [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
      [...new Set(url.searchParams.keys())].some(
        (key) => url.searchParams.getAll(key).length !== 1,
      ) ||
      (issuer === null ? flow.discovery.requireIssuer : issuer !== flow.discovery.issuer) ||
      !timingSafeTextEqual(url.searchParams.get("state") ?? "", flow.state) ||
      flow.consumed
    ) {
      this.#writeCallbackPage(response, 400, invalid);
      return;
    }
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if ((code === null) === (oauthError === null)) {
      this.#writeCallbackPage(response, 400, invalid);
      return;
    }
    if (code !== null) {
      if (code.length === 0 || code.length > MAX_TOKEN_CHARS) {
        this.#writeCallbackPage(response, 400, invalid);
        return;
      }
      flow.consumed = true;
      flow.callback = { kind: "code", code };
      flow.callbackExpiresAt = Date.now() + FLOW_CALLBACK_CLAIM_MS;
      clearTimeout(flow.timer);
      flow.timer = setTimeout(() => {
        if (this.#pending.get(flow.flowId) === flow && !this.#polling.has(flow.flowId)) {
          this.#pending.delete(flow.flowId);
          void this.#closeFlowListener(flow, true);
        }
      }, FLOW_CALLBACK_CLAIM_MS);
      flow.timer.unref();
      this.#writeCallbackPage(response, 200, `${this.#name} sign-in received.`);
    } else {
      flow.consumed = true;
      flow.callback = {
        kind: "error",
        error: oauthError && oauthError.length <= 256 ? oauthError : "authorization_denied",
      };
      this.#writeCallbackPage(response, 200, `${this.#name} sign-in was not completed.`);
    }
    response.once("finish", () => void this.#closeFlowListener(flow, false));
  }

  async #startFlowListener(
    input: Pick<
      PendingFlow,
      "flowId" | "state" | "codeVerifier" | "endpoint" | "discovery" | "expiresAt" | "generation"
    >,
    signal?: AbortSignal,
  ): Promise<PendingFlow> {
    let flow: PendingFlow | null = null;
    const server = NodeHttp.createServer((request, response) => {
      if (!flow) {
        this.#writeCallbackPage(response, 503, `This ${this.#name} sign-in is not ready.`);
        return;
      }
      this.#handleCallback(flow, request, response);
    });
    server.maxHeadersCount = 32;
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 1;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error(`${this.#name} loopback listener did not bind safely.`);
    }
    const timer = setTimeout(
      () => {
        if (this.#pending.get(input.flowId) === flow) {
          this.#pending.delete(input.flowId);
          if (flow) void this.#closeFlowListener(flow, true);
        }
      },
      Math.max(1, input.expiresAt - Date.now()),
    );
    timer.unref();
    flow = {
      ...input,
      server,
      timer,
      redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
      clientId: "",
      callbackExpiresAt: null,
      callback: null,
      consumed: false,
      closePromise: null,
    };
    if (signal?.aborted || this.#closed || this.#disconnecting) {
      await this.#closeFlowListener(flow, true);
      throw new IntegrationProviderPublicError(`${this.#name} sign-in was cancelled.`);
    }
    return flow;
  }

  #mcpHeaders(access: AccessToken, method: string, params?: Record<string, unknown>) {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${access.value}`,
      "content-type": "application/json",
    };
    const protocol = this.#protocol;
    if (protocol?.mode === "initialize") {
      headers["mcp-protocol-version"] = protocol.version;
    } else if (protocol?.mode === "discover") {
      headers["mcp-protocol-version"] = DISCOVER_PROTOCOL_VERSION;
      headers["mcp-method"] = method;
      if (method === "tools/call") {
        headers["mcp-name"] = boundedString(params?.name, 128, `${this.#name} MCP tool name`);
      }
    }
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    return headers;
  }

  #acceptSessionId(response: Response, access: AccessToken): void {
    const returned = response.headers.get("mcp-session-id");
    // A response to a call made before a refresh replaced the session must not adopt its id.
    if (returned === null || this.#accessToken !== access) return;
    if (
      returned.length === 0 ||
      returned.length > MAX_SESSION_ID_CHARS ||
      !/^[\x21-\x7E]+$/u.test(returned)
    ) {
      throw new Error(`${this.#name} MCP returned an invalid session identifier.`);
    }
    if (this.#sessionId !== null && this.#sessionId !== returned) {
      throw new Error(`${this.#name} MCP changed session identifiers unexpectedly.`);
    }
    this.#sessionId = returned;
  }

  #rejectHttpStatus(response: Response, method: string, access: AccessToken): never {
    // Only a response for the access token still in use may clear the shared session; a late
    // answer to a call made before a refresh must not discard the refreshed access.
    const current = this.#accessToken === access;
    if (response.status === 401) {
      if (current) {
        this.#accessToken = null;
        this.#resetSession();
      }
      throw new AuthorizationExpired(
        `${this.#name} authorization expired. Reconnect if refresh fails.`,
      );
    }
    if (response.status === 404 && (this.#sessionId || !current)) {
      if (current) {
        this.#sessionId = null;
        this.#sessionVerified = false;
      }
      throw new SessionInvalidError(`${this.#name} MCP session expired.`);
    }
    if (response.status === 429) {
      throw new RemoteRejection(`${this.#name} is rate limiting requests. Try again later.`);
    }
    if (response.status === 403) {
      throw new RemoteRejection(
        `${this.#name} denied this operation. Your ${this.#name} administrator may need to allow MCP access.`,
      );
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      throw new ProtocolRejection(
        `${this.#name} MCP rejected the ${method} request (HTTP ${response.status}).`,
      );
    }
    throw new ConfirmedRemoteFailure(
      `${this.#name} MCP ${method} failed (HTTP ${response.status}). Try again later.`,
    );
  }

  async #mcpRpc(
    access: AccessToken,
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
    maximumBytes: number,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<unknown> {
    const id = `${++this.#rpcSequence}`;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (this.#protocol?.mode === "discover") {
      payload.params = {
        ...params,
        _meta: {
          [META_PROTOCOL_VERSION]: DISCOVER_PROTOCOL_VERSION,
          [META_CLIENT_CAPABILITIES]: {},
          [META_CLIENT_INFO]: CLIENT_INFO,
        },
      };
    } else if (params !== undefined) {
      payload.params = params;
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) {
      // Refused locally before anything is sent, so even an admitted write did not happen.
      throw new RemoteRejection(`${this.#name} MCP request exceeded the allowed size.`);
    }
    const { response, bytes } = await this.#request(
      this.#endpointUrl(access.endpoint),
      { method: "POST", headers: this.#mcpHeaders(access, method, params), body, signal },
      maximumBytes,
      timeoutMs,
      (received, soFar) =>
        (received.headers.get("content-type")?.toLowerCase() ?? "").includes("text/event-stream") &&
        eventStreamHasResponse(soFar, id),
    );
    if (!response.ok) this.#rejectHttpStatus(response, method, access);
    this.#acceptSessionId(response, access);
    const raw = parseMcpPayload(response, bytes, id, `${this.#name} MCP response`);
    if (raw.jsonrpc !== "2.0" || raw.id !== id) {
      throw new Error(`${this.#name} MCP returned a mismatched JSON-RPC response.`);
    }
    if (raw.error !== undefined) {
      const error = asRecord(raw.error, `${this.#name} MCP JSON-RPC error`);
      if (!Number.isInteger(error.code)) {
        throw new Error(`${this.#name} MCP returned an invalid error.`);
      }
      if (PRE_DISPATCH_JSON_RPC_ERRORS.has(error.code as number)) {
        const detail =
          typeof error.message === "string" && error.message.length > 0
            ? `: ${error.message.slice(0, MAX_REJECTION_DETAIL_CHARS)}`
            : ".";
        throw new ProtocolRejection(`${this.#name} MCP rejected the request${detail}`);
      }
      throw new ConfirmedRemoteFailure(`${this.#name} MCP rejected the request.`);
    }
    if (!("result" in raw)) throw new Error(`${this.#name} MCP response omitted its result.`);
    return raw.result;
  }

  async #mcpNotify(access: AccessToken, method: string, signal: AbortSignal): Promise<void> {
    const { response } = await this.#request(
      this.#endpointUrl(access.endpoint),
      {
        method: "POST",
        headers: this.#mcpHeaders(access, method),
        body: JSON.stringify({ jsonrpc: "2.0", method }),
        signal,
      },
      MCP_CONTROL_RESPONSE_BYTES,
    );
    if (!response.ok) this.#rejectHttpStatus(response, method, access);
    this.#acceptSessionId(response, access);
  }

  async #handshake(access: AccessToken, signal: AbortSignal): Promise<void> {
    this.#protocol = null;
    this.#sessionId = null;
    let initialized: Record<string, unknown> | null = null;
    try {
      initialized = asRecord(
        await this.#mcpRpc(
          access,
          "initialize",
          {
            protocolVersion: INITIALIZE_PROTOCOL_VERSIONS[0],
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
          signal,
          MCP_CONTROL_RESPONSE_BYTES,
        ),
        `${this.#name} MCP initialize result`,
      );
    } catch (error) {
      // A server on the stateless revision refuses `initialize` before dispatch.
      if (!(error instanceof ProtocolRejection)) throw error;
    }
    if (initialized) {
      const version = initialized.protocolVersion;
      const capabilities = initialized.capabilities;
      if (
        typeof version !== "string" ||
        !(INITIALIZE_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(version) ||
        !capabilities ||
        typeof capabilities !== "object" ||
        Array.isArray(capabilities) ||
        !(capabilities as Record<string, unknown>).tools ||
        typeof (capabilities as Record<string, unknown>).tools !== "object"
      ) {
        throw new IntegrationProviderPublicError(
          `${this.#name} MCP protocol changed from the reviewed versions.`,
        );
      }
      this.#protocol = { mode: "initialize", version };
      await this.#mcpNotify(access, "notifications/initialized", signal);
      return;
    }
    this.#protocol = { mode: "discover" };
    this.#sessionId = null;
    const discover = asRecord(
      await this.#mcpRpc(access, "server/discover", undefined, signal, MCP_CONTROL_RESPONSE_BYTES),
      `${this.#name} MCP server/discover result`,
    );
    if (
      discover.resultType !== "complete" ||
      !Array.isArray(discover.supportedVersions) ||
      !discover.supportedVersions.includes(DISCOVER_PROTOCOL_VERSION) ||
      !discover.capabilities ||
      typeof discover.capabilities !== "object" ||
      !(discover.capabilities as Record<string, unknown>).tools
    ) {
      throw new IntegrationProviderPublicError(
        `${this.#name} MCP protocol changed from the reviewed versions.`,
      );
    }
  }

  async #initializeSession(access: AccessToken, signal: AbortSignal): Promise<void> {
    await this.#serializeSession(async () => {
      if (this.#sessionVerified && this.#sessionAccess === access) return;
      await this.#handshake(access, signal);
      const collected: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
        const result = asRecord(
          await this.#mcpRpc(
            access,
            "tools/list",
            cursor === undefined ? undefined : { cursor },
            signal,
            MCP_CONTROL_RESPONSE_BYTES,
          ),
          `${this.#name} MCP tools/list result`,
        );
        if (
          (result.resultType !== undefined && result.resultType !== "complete") ||
          !Array.isArray(result.tools)
        ) {
          throw new Error(`${this.#name} MCP tool inventory is invalid.`);
        }
        collected.push(...result.tools);
        if (collected.length > MAX_MCP_TOOLS) {
          throw new Error(`${this.#name} MCP tool inventory is too large.`);
        }
        if (result.nextCursor === undefined || result.nextCursor === null) {
          cursor = undefined;
          break;
        }
        cursor = boundedString(result.nextCursor, 2_048, `${this.#name} MCP tools cursor`);
      }
      if (cursor !== undefined) {
        throw new Error(`${this.#name} MCP tool inventory pagination is too large.`);
      }
      const inventory = validateToolInventory(this.#policy, access.endpoint, collected);
      // A refresh replaced the access token while this session was being set up. Publishing it
      // would mark the refreshed access verified without its own session.
      if (this.#accessToken !== access) {
        throw new SessionInvalidError(`${this.#name} access was refreshed during session setup.`);
      }
      this.#availableTools = inventory.available;
      this.#pausedTools = inventory.paused;
      this.#unofferedTools = inventory.unoffered;
      this.#sessionVerified = true;
      this.#sessionAccess = access;
    });
  }

  async #postRevocation(
    discovery: OAuthDiscovery,
    token: string,
    clientId: string,
    signal: AbortSignal,
    accessToken?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const { response } = await this.#request(
      discovery.revocationEndpoint,
      {
        method: "POST",
        headers,
        body: new URLSearchParams({ client_id: clientId, token, token_type_hint: "refresh_token" }),
        signal,
      },
      METADATA_RESPONSE_BYTES,
    );
    return response;
  }

  /**
   * Revokes one grant. Resolves when the grant is revoked or can never be revoked (already invalid,
   * or issued for an endpoint the service cannot revoke); throws a confirmed failure to retry later.
   */
  async #revokeGrant(
    discovery: OAuthDiscovery,
    grant: PendingRevocation,
    signal: AbortSignal,
    accessToken?: string,
  ): Promise<void> {
    const endpoint = grant.endpoint === undefined ? null : this.#endpointForPath(grant.endpoint);
    if (endpoint && endpoint.revocable === false) return;
    const failed = () =>
      new ConfirmedRemoteFailure(`${this.#name} could not revoke the credential. Try again.`);
    if (this.#policy.oauth.revocation === "rfc7009") {
      const response = await this.#postRevocation(
        discovery,
        grant.refreshToken,
        grant.clientId,
        signal,
      );
      if (!response.ok) throw failed();
      return;
    }
    let access = accessToken;
    let current = grant.refreshToken;
    if (!access) {
      const body: Record<string, string> = {
        client_id: grant.clientId,
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
      };
      if (endpoint) body.resource = this.#endpointUrl(endpoint);
      const { response, json } = await this.#requestJson(
        discovery.tokenEndpoint,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(body),
          signal,
        },
        TOKEN_RESPONSE_BYTES,
      );
      // The grant is already gone; nothing remains to revoke.
      if (response.status === 400 && json.error === "invalid_grant") return;
      if (!response.ok) throw failed();
      access = boundedString(
        json.access_token,
        MAX_TOKEN_CHARS,
        `${this.#name} OAuth access token`,
      );
      if (json.refresh_token !== undefined) {
        current = boundedString(
          json.refresh_token,
          MAX_TOKEN_CHARS,
          `${this.#name} OAuth refresh token`,
        );
      }
    }
    // A refresh that rotated the token makes the replacement the grant to revoke; keep it queued
    // if revocation does not settle, since the spent token may stop working.
    const replacement: PendingRevocation | null =
      current === grant.refreshToken
        ? null
        : { clientId: grant.clientId, refreshToken: current, endpoint: grant.endpoint };
    let response: Response;
    try {
      response = await this.#postRevocation(discovery, current, grant.clientId, signal, access);
    } catch {
      throw new RevocationIncomplete(failed().message, replacement);
    }
    // A freshly issued access token is only refused when the service will not revoke this grant's
    // endpoint, so retrying cannot help.
    if (response.status === 401) return;
    if (!response.ok) throw new RevocationIncomplete(failed().message, replacement);
    if (current !== grant.refreshToken) {
      // The service may keep honoring a spent refresh token; revoke it as well, best effort.
      await this.#postRevocation(discovery, grant.refreshToken, grant.clientId, signal, access)
        .then(() => undefined)
        .catch(() => undefined);
    }
  }

  #parseTokenResponse(
    json: Record<string, unknown>,
    clientId: string,
    endpoint: RemoteMcpEndpoint,
    discovery: OAuthDiscovery,
    existingRefreshToken?: string,
  ): { readonly credential: Credential; readonly access: AccessToken } {
    if (typeof json.token_type !== "string" || json.token_type.toLowerCase() !== "bearer") {
      throw new Error(`${this.#name} OAuth returned an invalid token type.`);
    }
    const accessToken = boundedString(
      json.access_token,
      MAX_TOKEN_CHARS,
      `${this.#name} OAuth access token`,
    );
    const refreshToken =
      json.refresh_token === undefined
        ? existingRefreshToken
        : boundedString(json.refresh_token, MAX_TOKEN_CHARS, `${this.#name} OAuth refresh token`);
    if (!refreshToken) throw new Error(`${this.#name} OAuth did not issue renewable access.`);
    let expiresIn = DEFAULT_ACCESS_TOKEN_SECONDS;
    if (json.expires_in !== undefined) {
      if (
        !Number.isInteger(json.expires_in) ||
        (json.expires_in as number) < 60 ||
        (json.expires_in as number) > 86_400
      ) {
        throw new Error(`${this.#name} OAuth token lifetime is invalid.`);
      }
      expiresIn = json.expires_in as number;
    }
    if (json.scope !== undefined && (typeof json.scope !== "string" || json.scope.length > 4_096)) {
      throw new Error(`${this.#name} OAuth scope grant is invalid.`);
    }
    return {
      credential: {
        version: 1,
        origin: this.#origin.origin,
        endpoint: endpoint.path,
        issuer: discovery.issuer,
        clientId,
        refreshToken,
        updatedAt: new Date().toISOString(),
      },
      access: { value: accessToken, expiresAt: Date.now() + expiresIn * 1_000, endpoint },
    };
  }

  #validateCapabilities(capabilities: ReadonlyArray<string>): void {
    const known = new Set(this.#policy.endpoints.flatMap((endpoint) => endpoint.capabilities));
    if (
      capabilities.length === 0 ||
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) => !known.has(capability))
    ) {
      throw new Error(`Unsupported ${this.#name} capability.`);
    }
  }

  async status(context?: IntegrationOperationContext): Promise<IntegrationProviderStatus> {
    if (this.#uncertainCredentialState) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Credential state is uncertain. Disconnect to verify reset before reconnecting.",
      };
    }
    if (this.#closed || this.#disconnecting) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: this.#closed
          ? `The ${this.#name} provider is closed.`
          : `${this.#name} is disconnecting.`,
      };
    }
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    try {
      const credential = await this.#readCredential(context?.signal);
      if (
        generation !== this.#generation ||
        revision !== this.#credentialRevision ||
        this.#closed ||
        this.#disconnecting
      ) {
        throw new Error(`${this.#name} connection changed during status.`);
      }
      if (!credential) {
        const revocationPending = (await this.#secrets.get(REVOCATION_SECRET_SUFFIX)) !== null;
        return {
          state: this.#pending.size > 0 ? "connecting" : "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message: revocationPending
            ? `Disconnected here, but ${this.#name} has not confirmed revoking the previous sign-in. It is retried on the next connect or disconnect.`
            : null,
        };
      }
      const endpoint = this.#endpointForPath(credential.endpoint)!;
      const paused =
        this.#pausedTools.length > 0
          ? ` Paused until the plugin is updated because ${this.#name} changed them: ${this.#pausedTools.join(", ")}.`
          : "";
      const unoffered =
        this.#unofferedTools.length > 0
          ? ` Not offered by ${this.#name} on this connection: ${this.#unofferedTools.join(", ")}.`
          : "";
      return {
        state: "connected",
        accountLabel: `${this.#name} (${endpoint.label})`,
        grantedCapabilities: [...endpoint.capabilities],
        message: `Connected with your own ${this.#name} permissions (${endpoint.label.toLowerCase()} access).${paused}${unoffered}${
          this.#renewalDeferred
            ? ` ${this.#name} was briefly unavailable while renewing access; the next request retries.`
            : ""
        }`,
      };
    } catch {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: `The stored ${this.#name} connection could not be verified. Disconnect to reset it.`,
      };
    }
  }

  async connect(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationAuthorizationUrlConnectResult | IntegrationConnectedConnectResult> {
    if (submission !== undefined) {
      throw new Error(`${this.#name} browser sign-in rejects credential submissions.`);
    }
    if (this.#closed || this.#disconnecting) throw new Error(`${this.#name} is unavailable.`);
    if (this.#uncertainCredentialState) {
      throw new Error(`${this.#name} credential state is uncertain.`);
    }
    this.#validateCapabilities(capabilities);
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    const attempt = ++this.#connectAttempt;
    const existing = await this.#readCredential(context?.signal);
    if (existing) {
      const granted = this.#endpointForPath(existing.endpoint)!.capabilities;
      if (capabilities.every((capability) => granted.includes(capability))) {
        return {
          kind: "connected",
          flowId: NodeCrypto.randomUUID(),
          message: `${this.#name} is already authorized for this user.`,
        };
      }
    }
    // Sign in to the least-privileged endpoint that serves every requested ability. Enabling a
    // broader ability later signs in again; the earlier grant is replaced and revoked.
    const endpoint = this.#policy.endpoints.find((candidate) =>
      capabilities.every((capability) => candidate.capabilities.includes(capability)),
    );
    if (!endpoint) {
      throw new IntegrationProviderPublicError(
        `${this.#name} cannot grant that combination of access.`,
      );
    }
    const discovery = await this.#discover(endpoint, context?.signal);
    await this.#clearPendingFlows();
    const flowId = NodeCrypto.randomUUID();
    const state = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const expiresAt = Date.now() + FLOW_LIFETIME_MS;
    const flow = await this.#startFlowListener(
      { flowId, state, codeVerifier, endpoint, discovery, expiresAt, generation },
      context?.signal,
    );
    let admitted = false;
    try {
      const commitSignal = await this.#beginCommit(context);
      admitted = true;
      // The revocation queue is read, retried, and rewritten under the credential lock so a
      // concurrent disconnect cannot have its newly queued grant overwritten by this snapshot.
      await this.#serializeCredential(async () => {
        try {
          await this.#retryPendingRevocations(discovery, commitSignal);
        } catch (error) {
          if (commitSignal.aborted) throw error;
        }
        // The replaced grant, a refreshed replacement for it, and an issued grant that fails
        // setup.
        const reserved = existing ? 3 : 1;
        if ((await this.#readPendingRevocations()).length > MAX_PENDING_REVOCATIONS - reserved) {
          throw new ConfirmedRemoteFailure(
            `${this.#name} has not confirmed revoking earlier sign-ins. Try again once ${this.#name} accepts revocation.`,
          );
        }
      });
      const clientId = await this.#registerClient(discovery, flow.redirectUri, commitSignal);
      if (
        generation !== this.#generation ||
        revision !== this.#credentialRevision ||
        attempt !== this.#connectAttempt ||
        this.#closed ||
        this.#disconnecting
      ) {
        throw new Error(`${this.#name} sign-in was superseded while starting.`);
      }
      flow.clientId = clientId;
      this.#pending.set(flowId, flow);
    } catch (error) {
      await this.#closeFlowListener(flow, true);
      if (admitted && !(error instanceof ConfirmedRemoteFailure)) {
        this.#uncertainCredentialState = true;
        throw new ExternalCommitOutcomeUnknownError(
          `The ${this.#name} OAuth client registration may have completed. Disconnect before retrying.`,
        );
      }
      throw error;
    }
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", flow.clientId);
    authorizationUrl.searchParams.set("redirect_uri", flow.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    if (discovery.scopes.length > 0) {
      authorizationUrl.searchParams.set("scope", discovery.scopes.join(" "));
    }
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set(
      "code_challenge",
      NodeCrypto.createHash("sha256").update(codeVerifier, "ascii").digest("base64url"),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", this.#endpointUrl(endpoint));
    return {
      kind: "authorization_url",
      flowId,
      authorizationUrl: authorizationUrl.toString(),
      message: `Continue in your browser and approve ${this.#name} access for your own account.`,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: FLOW_POLL_SECONDS,
    };
  }

  async poll(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult> {
    const flow = this.#pending.get(flowId);
    if (!flow)
      throw new IntegrationProviderPublicError(`${this.#name} sign-in flow was not found.`);
    if (this.#polling.has(flowId)) {
      throw new IntegrationProviderPublicError(`${this.#name} sign-in is already being checked.`);
    }
    if (
      flow.callback?.kind === "code"
        ? flow.callbackExpiresAt !== null && flow.callbackExpiresAt <= Date.now()
        : flow.expiresAt <= Date.now()
    ) {
      await this.#removeFlow(flowId);
      return {
        state: "expired",
        retryAfterSeconds: null,
        message: `${this.#name} sign-in expired. Start again.`,
      };
    }
    if (flow.callback === null) {
      return {
        state: "pending",
        retryAfterSeconds: FLOW_POLL_SECONDS,
        message: `Waiting for ${this.#name} sign-in.`,
      };
    }
    if (flow.callback.kind === "error") {
      await this.#removeFlow(flowId);
      return {
        state: "failed",
        retryAfterSeconds: null,
        message:
          flow.callback.error === "access_denied"
            ? `${this.#name} sign-in was cancelled.`
            : `${this.#name} sign-in did not complete. Start again.`,
      };
    }
    const authorizationCode = flow.callback.code;
    this.#polling.add(flowId);
    try {
      return await this.#serializeCredential(async () => {
        if (
          this.#closed ||
          this.#disconnecting ||
          this.#uncertainCredentialState ||
          flow.generation !== this.#generation ||
          this.#pending.get(flowId) !== flow
        ) {
          throw new Error(`${this.#name} sign-in was superseded before token exchange.`);
        }
        // Storage failures propagate before admission; only a record that cannot be parsed, and so
        // cannot be revoked, counts as absent.
        const storedReplaced = await this.#secrets.get(OAUTH_SECRET_SUFFIX);
        let replaced: Credential | null = null;
        if (storedReplaced !== null) {
          try {
            replaced = this.#parseCredential(storedReplaced);
          } catch {
            replaced = null;
          }
        }
        let admitted = false;
        let responseSettled = false;
        let exchanged = false;
        let persisted = false;
        let replacedQueued = false;
        // A grant the service issued that is neither stored nor revoked yet.
        let issued: Credential | null = null;
        let issuedAccess: string | null = null;
        const failed = (message: string): IntegrationProviderPollResult => ({
          state: "failed",
          retryAfterSeconds: null,
          message,
        });
        try {
          const commitSignal = await this.#beginCommit(context);
          admitted = true;
          const { response, json } = await this.#requestJson(
            flow.discovery.tokenEndpoint,
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                client_id: flow.clientId,
                code: authorizationCode,
                code_verifier: flow.codeVerifier,
                grant_type: "authorization_code",
                redirect_uri: flow.redirectUri,
                resource: this.#endpointUrl(flow.endpoint),
              }),
              signal: commitSignal,
            },
            TOKEN_RESPONSE_BYTES,
          );
          responseSettled = true;
          if (!response.ok) {
            await this.#removeFlow(flowId);
            return failed(`${this.#name} sign-in failed. Start again.`);
          }
          exchanged = true;
          const parsed = this.#parseTokenResponse(
            json,
            flow.clientId,
            flow.endpoint,
            flow.discovery,
          );
          issued = parsed.credential;
          issuedAccess = parsed.access.value;
          this.#accessToken = parsed.access;
          this.#resetSession();
          try {
            await this.#initializeSession(parsed.access, commitSignal);
          } catch (error) {
            this.#accessToken = null;
            this.#resetSession();
            await this.#discardIssuedGrant(
              flow.discovery,
              parsed.credential,
              commitSignal,
              parsed.access.value,
            );
            issued = null;
            await this.#removeFlow(flowId);
            return failed(
              error instanceof IntegrationProviderPublicError
                ? error.message
                : `${this.#name} MCP connection verification failed. Try again.`,
            );
          }
          if (
            this.#closed ||
            this.#disconnecting ||
            this.#uncertainCredentialState ||
            flow.generation !== this.#generation ||
            this.#pending.get(flowId) !== flow
          ) {
            throw new Error(`${this.#name} sign-in was superseded before credential commit.`);
          }
          // An earlier, narrower grant is queued for revocation before it is replaced, so an
          // interrupted upgrade never loses track of a live token.
          if (replaced && replaced.refreshToken !== parsed.credential.refreshToken) {
            const pending = await this.#readPendingRevocations();
            if (!pending.some((grant) => grant.refreshToken === replaced.refreshToken)) {
              await this.#writePendingRevocations([
                ...pending,
                {
                  clientId: replaced.clientId,
                  refreshToken: replaced.refreshToken,
                  endpoint: replaced.endpoint,
                },
              ]);
              replacedQueued = true;
            }
          }
          await this.#writeCredential(parsed.credential, commitSignal, () => {
            persisted = true;
            issued = null;
            this.#renewalDeferred = false;
          });
          this.#credentialRevision += 1;
          this.#generation += 1;
          await this.#removeFlow(flowId);
          if (replaced) {
            try {
              await this.#retryPendingRevocations(flow.discovery, commitSignal);
            } catch {
              // The new grant is durable; the old one stays queued for the next retry.
            }
          }
          return {
            state: "connected",
            retryAfterSeconds: null,
            message: `${this.#name} is connected for this user.`,
          };
        } catch (error) {
          if (!admitted || persisted) throw error;
          if (!responseSettled || (exchanged && issued === null)) {
            // The exchange may have succeeded, or it issued a grant this provider cannot read.
            this.#uncertainCredentialState = true;
            throw new ExternalCommitOutcomeUnknownError(
              `The ${this.#name} sign-in commit may have completed. Disconnect before retrying.`,
            );
          }
          if (issued) {
            const grant: Credential = issued;
            if (replacedQueued && replaced) {
              // The replaced grant is still the stored connection; keep it out of revocation.
              await this.#writePendingRevocations(
                (await this.#readPendingRevocations()).filter(
                  (entry) => entry.refreshToken !== replaced.refreshToken,
                ),
              ).catch(() => undefined);
            }
            this.#accessToken = null;
            this.#resetSession();
            try {
              await this.#discardIssuedGrant(
                flow.discovery,
                grant,
                new AbortController().signal,
                issuedAccess ?? undefined,
              );
            } catch {
              this.#uncertainCredentialState = true;
              throw new ExternalCommitOutcomeUnknownError(
                `The ${this.#name} sign-in issued access that could not be stored or revoked. Disconnect before retrying.`,
              );
            }
            await this.#removeFlow(flowId);
            return failed(`${this.#name} sign-in did not complete. Start again.`);
          }
          throw error;
        }
      });
    } finally {
      this.#polling.delete(flowId);
    }
  }

  prepare(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      if (this.#closed || this.#disconnecting) throw new Error(`${this.#name} is unavailable.`);
      if (this.#uncertainCredentialState) {
        throw new Error(`${this.#name} credential state is uncertain.`);
      }
      const access = this.#accessToken;
      if (access && access.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) {
        await this.#initializeSession(access, context?.signal ?? new AbortController().signal);
        return;
      }
      const generation = this.#generation;
      const revision = this.#credentialRevision;
      const credential = await this.#readCredential(context?.signal);
      if (!credential) return;
      const endpoint = this.#endpointForPath(credential.endpoint)!;
      const discovery = await this.#discover(endpoint, context?.signal);
      if (discovery.issuer !== credential.issuer) {
        throw new Error(`${this.#name} OAuth issuer changed from the stored credential.`);
      }
      let admitted = false;
      let responseSettled = false;
      let credentialIssued = false;
      let credentialPersisted = false;
      try {
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        const body = new URLSearchParams({
          client_id: credential.clientId,
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          resource: this.#endpointUrl(endpoint),
        });
        const { response, json } = await this.#requestJson(
          discovery.tokenEndpoint,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
            },
            body,
            signal: commitSignal,
          },
          TOKEN_RESPONSE_BYTES,
        );
        responseSettled = true;
        if (!response.ok) {
          // invalid_grant means the refresh token is gone for good: spent, revoked, or expired.
          // Nothing remains to revoke, so drop it and let the user reconnect in one step.
          if (response.status === 400 && json.error === "invalid_grant") {
            await this.#secrets.remove(OAUTH_SECRET_SUFFIX);
            this.#accessToken = null;
            this.#credentialRevision += 1;
            this.#resetSession();
            // A known reset must settle admission successfully so Harness permits reconnect.
            return;
          }
          // An outage or rate limit issued nothing and changed nothing. Settle without a session
          // so the connection is not faulted; invoke reports that access is not prepared, and the
          // next prepare retries the refresh.
          if (response.status === 429 || response.status >= 500) {
            this.#renewalDeferred = true;
            return;
          }
          throw new IntegrationProviderPublicError(
            `${this.#name} access could not be refreshed. Disconnect and reconnect.`,
          );
        }
        credentialIssued = true;
        const parsed = this.#parseTokenResponse(
          json,
          credential.clientId,
          endpoint,
          discovery,
          credential.refreshToken,
        );
        if (generation !== this.#generation || revision !== this.#credentialRevision) {
          throw new Error(`${this.#name} connection changed while refreshing.`);
        }
        // A rotated refresh token is the only way back into this grant. Persist it before the
        // MCP session round trip, which can fail routinely on a waking laptop.
        await this.#writeCredential(parsed.credential, commitSignal, () => {
          credentialPersisted = true;
          this.#renewalDeferred = false;
          this.#credentialRevision += 1;
          this.#accessToken = parsed.access;
          this.#resetSession();
        });
        await this.#initializeSession(parsed.access, commitSignal);
      } catch (error) {
        // Settle a durable rotation even when session setup fails; invoke reports the missing
        // session, and the next prepare retries setup before admission using the saved token.
        if (credentialPersisted) return;
        if (admitted && (!responseSettled || credentialIssued)) {
          this.#uncertainCredentialState = true;
          throw new ExternalCommitOutcomeUnknownError(
            `The ${this.#name} credential refresh may have completed. Disconnect before retrying.`,
          );
        }
        throw error;
      }
    });
  }

  async #readPendingRevocations(): Promise<PendingRevocation[]> {
    const encoded = await this.#secrets.get(REVOCATION_SECRET_SUFFIX);
    return encoded === null ? [] : parsePendingRevocations(encoded);
  }

  async #writePendingRevocations(grants: ReadonlyArray<PendingRevocation>): Promise<void> {
    if (grants.length === 0) {
      await this.#secrets.remove(REVOCATION_SECRET_SUFFIX);
      return;
    }
    await this.#secrets.set(
      REVOCATION_SECRET_SUFFIX,
      JSON.stringify({ version: 1, origin: this.#origin.origin, grants }),
    );
  }

  async #retryPendingRevocations(discovery: OAuthDiscovery, signal: AbortSignal): Promise<void> {
    if ((await this.#secrets.get(REVOCATION_SECRET_SUFFIX)) === null) return;
    // One shared budget leaves room for registration or local cleanup inside the host's
    // lifecycle deadline, regardless of how many old grants are queued.
    const budget = AbortSignal.timeout(
      Math.min(REVOCATION_RETRY_BUDGET_MS, this.#requestTimeoutMs),
    );
    const retrySignal = AbortSignal.any([signal, budget]);
    const remaining: PendingRevocation[] = [];
    const grants = await this.#readPendingRevocations();
    for (let index = 0; index < grants.length; index += 1) {
      const grant = grants[index]!;
      if (budget.aborted) {
        remaining.push(grant);
        continue;
      }
      try {
        await this.#revokeGrant(discovery, grant, retrySignal);
      } catch (error) {
        remaining.push(grant);
        if (error instanceof RevocationIncomplete && error.replacement) {
          remaining.push(error.replacement);
        }
        if (signal.aborted) {
          // Keep every grant still owed, including a replacement this attempt just received,
          // before cancellation propagates; otherwise a rotated token could be lost unrevoked.
          remaining.push(...grants.slice(index + 1));
          await this.#writePendingRevocations(remaining);
          throw error;
        }
      }
    }
    await this.#writePendingRevocations(remaining);
  }

  /** Revokes an issued grant that will not be stored, or queues it so a later retry revokes it. */
  async #discardIssuedGrant(
    discovery: OAuthDiscovery,
    grant: Credential,
    signal: AbortSignal,
    accessToken?: string,
  ): Promise<void> {
    const pendingGrant: PendingRevocation = {
      clientId: grant.clientId,
      refreshToken: grant.refreshToken,
      endpoint: grant.endpoint,
    };
    const queued: PendingRevocation[] = [pendingGrant];
    try {
      await this.#revokeGrant(
        discovery,
        pendingGrant,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(REVOCATION_RETRY_BUDGET_MS, this.#requestTimeoutMs)),
        ]),
        accessToken,
      );
      return;
    } catch (error) {
      // Fall through to the durable queue.
      if (error instanceof RevocationIncomplete && error.replacement) {
        queued.push(error.replacement);
      }
    }
    const pending = await this.#readPendingRevocations();
    const additions = queued.filter(
      (entry) => !pending.some((existing) => existing.refreshToken === entry.refreshToken),
    );
    if (additions.length > 0) await this.#writePendingRevocations([...pending, ...additions]);
  }

  disconnect(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      this.#disconnecting = true;
      this.#generation += 1;
      this.#connectAttempt += 1;
      this.#resetSession();
      await this.#clearPendingFlows();
      let admitted = false;
      try {
        // Storage failures propagate. A stored value that cannot be parsed cannot be revoked, but
        // it must still be removable because status tells the user to disconnect to reset it.
        const encoded = await this.#secrets.get(OAUTH_SECRET_SUFFIX);
        context?.signal?.throwIfAborted();
        let credential: Credential | null = null;
        if (encoded !== null) {
          try {
            credential = this.#parseCredential(encoded);
          } catch {
            credential = null;
          }
        }
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        if (credential) {
          const pending = await this.#readPendingRevocations();
          if (!pending.some((grant) => grant.refreshToken === credential.refreshToken)) {
            // Queue before removal so a failed or interrupted revoke never loses the grant. A
            // reset is never refused for a full queue; sign-in reserves the room this needs.
            await this.#writePendingRevocations([
              ...pending,
              {
                clientId: credential.clientId,
                refreshToken: credential.refreshToken,
                endpoint: credential.endpoint,
              },
            ]);
          }
        }
        await this.#secrets.remove(OAUTH_SECRET_SUFFIX);
        this.#accessToken = null;
        this.#credentialRevision += 1;
        this.#uncertainCredentialState = false;
        this.#renewalDeferred = false;
        // Local reset is already durable. Network cleanup is bounded and best effort; an outage
        // or cancellation cannot turn it into a faulted connection again.
        const endpoint = credential
          ? this.#endpointForPath(credential.endpoint)!
          : this.#policy.endpoints[0]!;
        let discovery: OAuthDiscovery;
        try {
          discovery = await this.#discover(
            endpoint,
            AbortSignal.any([
              commitSignal,
              AbortSignal.timeout(Math.min(REVOCATION_RETRY_BUDGET_MS, this.#requestTimeoutMs)),
            ]),
          );
        } catch {
          return;
        }
        if (!commitSignal.aborted) {
          try {
            await this.#retryPendingRevocations(discovery, commitSignal);
          } catch {
            // The local reset is complete and unconfirmed grants are already queued.
          }
        }
      } catch (error) {
        if (admitted) {
          this.#uncertainCredentialState = true;
          throw new ExternalCommitOutcomeUnknownError(
            `The ${this.#name} disconnect may have completed. Verify the connection state before retrying.`,
          );
        }
        throw error;
      } finally {
        this.#disconnecting = false;
      }
    });
  }

  async invoke(
    toolName: string,
    input: JsonObject,
    context?: IntegrationInvocationContext,
  ): Promise<JsonValue> {
    const reviewed = this.#policy.tools.find((tool) => tool.name === toolName);
    if (!reviewed) throw new IntegrationProviderPublicError(`Unknown ${this.#name} tool.`);
    const write = reviewed.effect === "write";
    if (write && context?.writeApproved !== true) {
      throw new Error(`${this.#name} writes require explicit Harness approval.`);
    }
    assertJsonBounds(input, this.#name);
    const violation = this.#validators.get(reviewed.name)!.validate(input);
    if (violation) {
      throw new IntegrationProviderPublicError(
        `Invalid ${reviewed.name} input: ${violation.replace(/^\$\.?/u, "") || "input"}.`,
      );
    }
    const generation = this.#generation;
    const access = this.#accessToken;
    if (
      !access ||
      access.expiresAt - ACCESS_TOKEN_SKEW_MS <= Date.now() ||
      !this.#sessionVerified ||
      this.#sessionAccess !== access ||
      this.#closed ||
      this.#disconnecting ||
      this.#uncertainCredentialState
    ) {
      throw new IntegrationProviderPublicError(
        this.#renewalDeferred && !this.#uncertainCredentialState
          ? `${this.#name} was briefly unavailable while renewing access, so this call was not run. Try again in a moment.`
          : `${this.#name} access is not prepared. Reconnect if this continues.`,
      );
    }
    const assertAvailable = () => {
      if (!access.endpoint.capabilities.includes(reviewed.capability)) {
        throw new IntegrationProviderPublicError(
          `This ${this.#name} tool needs an ability the current connection does not include. Turn it on for the ${this.#name} plugin in Settings, which signs in to ${this.#name} again.`,
        );
      }
      if (!this.#availableTools.has(reviewed.upstreamName)) {
        throw new IntegrationProviderPublicError(
          this.#unofferedTools.includes(reviewed.name)
            ? `${this.#name} does not offer this tool on the current connection.`
            : `${this.#name} changed this tool, so it is paused until the TritonAI ${this.#name} plugin is updated.`,
        );
      }
    };
    assertAvailable();
    let admitted = false;
    let signal: AbortSignal | undefined = context?.signal;
    if (write) {
      if (typeof context?.beginCommit !== "function") {
        throw new Error(`${this.#name} writes require Harness commit admission.`);
      }
      signal = await context.beginCommit();
      admitted = true;
    }
    if (!signal) throw new Error(`${this.#name} invocation requires a cancellation signal.`);
    const commitSignal = signal;
    const timeout = TOOL_CALL_TIMEOUT_MS;
    const assertAccessCurrent = () => {
      if (generation !== this.#generation || this.#closed || this.#disconnecting) {
        throw new Error(`${this.#name} access changed during the tool call.`);
      }
    };
    const call = async (): Promise<JsonValue> => {
      // Re-checked on every attempt: a recovered session re-verifies the catalog and may have
      // paused or dropped this tool.
      assertAvailable();
      const result = asRecord(
        await this.#mcpRpc(
          access,
          "tools/call",
          { name: reviewed.upstreamName, arguments: input },
          commitSignal,
          MCP_TOOL_RESPONSE_BYTES,
          timeout,
        ),
        `${this.#name} MCP tool result`,
      );
      if (result.resultType !== undefined && result.resultType !== "complete") {
        throw new ConfirmedRemoteFailure(
          `${this.#name} asked for an interactive MCP response that TritonAI Harness does not support.`,
        );
      }
      assertAccessCurrent();
      // A tool-level error is the service's own answer, so hand it to the agent as the result
      // instead of throwing. The agent can correct its input, and a failed write does not fault
      // the integration. A write may have partly applied first, so the note says to check.
      if (result.isError === true) {
        if (!write) return result as JsonValue;
        const content = Array.isArray(result.content) ? result.content : [];
        return {
          ...result,
          content: [...content, { type: "text", text: this.#policy.writeFailureNote }],
        } as JsonValue;
      }
      return result as JsonValue;
    };
    let failure: unknown;
    try {
      return await call();
    } catch (error) {
      failure = error;
    }
    // A 404 for a known session means the service never dispatched the call, so even a write
    // can resend.
    // Access was refreshed while this call was in flight. The service refused the stale call
    // before running it, so report that instead of rebuilding the session on the old token.
    if (
      (failure instanceof SessionInvalidError || failure instanceof AuthorizationExpired) &&
      this.#accessToken !== access
    ) {
      assertAccessCurrent();
      return rejectedToolResult(
        `${this.#name} access was refreshed during this call, which was not run. Try again.`,
      );
    }
    if (failure instanceof SessionInvalidError) {
      try {
        await this.#initializeSession(access, commitSignal);
        assertAvailable();
      } catch (error) {
        if (this.#accessToken !== access) {
          assertAccessCurrent();
          return rejectedToolResult(
            `${this.#name} access was refreshed during this call, which was not run. Try again.`,
          );
        }
        if (!admitted) throw error;
        assertAccessCurrent();
        return rejectedToolResult(
          error instanceof IntegrationProviderPublicError
            ? error.message
            : `${this.#name} MCP session expired and could not be restored. Try again.`,
        );
      }
      try {
        return await call();
      } catch (error) {
        failure = error;
      }
    }
    if (failure instanceof RemoteRejection || failure instanceof SessionInvalidError) {
      assertAccessCurrent();
      return rejectedToolResult(failure.message);
    }
    if (write && admitted) {
      // Deliberately fault the whole provider, reads included. The host faults any provider whose
      // admitted write ends ambiguously and keeps it faulted until the connection is reset, so a
      // reads-only carve-out here could not take effect; this flag keeps the provider's own
      // status consistent with the host until disconnect clears both.
      this.#uncertainCredentialState = true;
      throw new ExternalCommitOutcomeUnknownError(
        `The ${this.#name} operation may have completed. Check the document before retrying.`,
      );
    }
    throw failure;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#connectAttempt += 1;
    for (const controller of this.#requestControllers) controller.abort();
    await this.#clearPendingFlows();
    this.#accessToken = null;
    this.#resetSession();
  }
}
