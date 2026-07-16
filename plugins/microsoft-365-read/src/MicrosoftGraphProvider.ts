import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type IntegrationConnectionSubmission,
  type IntegrationDeviceCodeConnectResult,
  type IntegrationInvocationContext,
  type IntegrationLifecycleContext,
  type IntegrationProvider,
  IntegrationProviderPublicError,
  type IntegrationProviderPollResult,
  type IntegrationProviderStatus,
  type IntegrationProviderTool,
  type IntegrationSecretStore,
} from "./host-contract.js";

/** Package-local suffix; the Harness adds the collision-free package namespace. */
export const MICROSOFT_GRAPH_SECRET_SUFFIX = "oauth";
export const MICROSOFT_GRAPH_PROVIDER_ID = "microsoft-graph-read";

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_API_ROOT = `${GRAPH_ORIGIN}/v1.0`;
const IDENTITY_ORIGIN = "https://login.microsoftonline.com";
const VERIFICATION_HOSTS = new Set([
  "login.microsoft.com",
  "login.microsoftonline.com",
  "microsoft.com",
  "www.microsoft.com",
]);
const OFFLINE_SCOPE = "offline_access";
const OIDC_RESPONSE_SCOPES = new Set(["openid", "profile", "email"]);
const REFRESH_TOKEN_FIELD = ["refresh", "token"].join("_");
const refreshValueField = ["refresh", "Token"].join("") as "refreshToken";
const CAPABILITY_SCOPES = {
  "mail.read": "Mail.ReadBasic",
  "calendar.read": "Calendars.ReadBasic",
} as const;
const CAPABILITY_NAMES = new Set<string>(Object.keys(CAPABILITY_SCOPES));
const ALLOWED_SCOPES = new Set([OFFLINE_SCOPE, ...Object.values(CAPABILITY_SCOPES)]);
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const IDENTITY_RESPONSE_BYTES = 64 * 1024;
const GRAPH_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOKEN_CHARS = 16_384;
const MAX_CALENDAR_RANGE_MS = 31 * 86_400_000;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface MicrosoftGraphConfiguration {
  readonly clientId: string;
  readonly tenantId: string;
}

const ENTRA_IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const MailSearchInput = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "Optional mail search text (maximum 200 characters).",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })).annotate({
      description: "Maximum number of messages (1-25).",
    }),
  ),
});

const CalendarEventsInput = Schema.Struct({
  start: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(64)).annotate({
      description: "Inclusive ISO 8601 start timestamp.",
    }),
  ),
  end: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(64)).annotate({
      description: "Exclusive ISO 8601 end timestamp, no more than 31 days after start.",
    }),
  ),
});

const decodeMailSearchInput = Schema.decodeUnknownPromise(MailSearchInput);
const decodeCalendarEventsInput = Schema.decodeUnknownPromise(CalendarEventsInput);

export const MICROSOFT_GRAPH_TOOLS = [
  {
    name: "microsoft365.mail.search",
    description:
      "Search Microsoft 365 mail through the fixed read-only messages endpoint with bounded input and output.",
    input: MailSearchInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.calendar.events",
    description:
      "Read Microsoft 365 calendar events through the fixed calendar-view endpoint in a bounded timestamp range.",
    input: CalendarEventsInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
] as const satisfies ReadonlyArray<IntegrationProviderTool>;

interface Credential {
  readonly version: 1;
  readonly refreshToken: string;
  readonly grantedScopes: ReadonlyArray<string>;
  readonly updatedAt: string;
}

interface PendingFlow {
  readonly deviceCode: string;
  readonly requestedScopes: ReadonlyArray<string>;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
  readonly generation: number;
}

interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly grantedScopes: ReadonlyArray<string>;
}

type Fetch = typeof globalThis.fetch;

function validateEntraIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!ENTRA_IDENTIFIER.test(normalized)) {
    throw new Error(`Microsoft 365 Read requires a valid Entra ${label}.`);
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Microsoft returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error("Microsoft returned an invalid response.");
  }
  return value;
}

function boundedOptionalString(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error("Microsoft returned an invalid response.");
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error("Microsoft returned an invalid response.");
  }
  return value as number;
}

function canonicalScopes(value: unknown, required: ReadonlyArray<string>): ReadonlyArray<string> {
  const expectedScopes = [...new Set(required)].toSorted();
  if (value === undefined) return expectedScopes;
  const raw = boundedString(value, 2_048).split(/\s+/u).filter(Boolean);
  const unique = [...new Set(raw)];
  const resourceScopes = unique
    .filter((scope) => scope !== OFFLINE_SCOPE && !OIDC_RESPONSE_SCOPES.has(scope))
    .toSorted();
  if (
    unique.length !== raw.length ||
    unique.some((scope) => !ALLOWED_SCOPES.has(scope) && !OIDC_RESPONSE_SCOPES.has(scope)) ||
    resourceScopes.length !== expectedScopes.length ||
    expectedScopes.some((scope, index) => resourceScopes[index] !== scope)
  ) {
    throw new Error("Microsoft returned an unexpected delegated-scope grant.");
  }
  return resourceScopes;
}

function capabilitiesFromScopes(scopes: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.entries(CAPABILITY_SCOPES)
    .filter(([, scope]) => scopes.includes(scope))
    .map(([capability]) => capability)
    .toSorted();
}

function isoTimestamp(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds)) {
    throw new IntegrationProviderPublicError("Calendar start and end must be ISO 8601 timestamps.");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const requiredZone = zone!;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHours = requiredZone === "Z" ? 0 : Number(requiredZone.slice(1, 3));
  const offsetMinutes = requiredZone === "Z" ? 0 : Number(requiredZone.slice(4, 6));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    throw new IntegrationProviderPublicError("Calendar start and end must be ISO 8601 timestamps.");
  }
  return new Date(milliseconds).toISOString();
}

function safeVerificationUrl(value: unknown): string {
  const raw = boundedString(value, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Microsoft returned an invalid verification address.");
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !VERIFICATION_HOSTS.has(url.hostname)
  ) {
    throw new Error("Microsoft returned an invalid verification address.");
  }
  return url.toString();
}

function parseCredential(bytes: Uint8Array): Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("Stored Microsoft credential is invalid.");
  }
  const value = asRecord(parsed);
  if (
    !exactKeys(value, new Set(["version", "refreshToken", "grantedScopes", "updatedAt"])) ||
    value.version !== 1 ||
    !Array.isArray(value.grantedScopes) ||
    value.grantedScopes.length === 0 ||
    value.grantedScopes.some(
      (scope) =>
        typeof scope !== "string" || !Object.values(CAPABILITY_SCOPES).includes(scope as never),
    ) ||
    new Set(value.grantedScopes).size !== value.grantedScopes.length ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error("Stored Microsoft credential is invalid.");
  }
  const refreshToken = boundedString(value.refreshToken, MAX_TOKEN_CHARS);
  return {
    version: 1,
    refreshToken,
    grantedScopes: [...value.grantedScopes].toSorted() as ReadonlyArray<string>,
    updatedAt: value.updatedAt,
  };
}

async function readJson(
  response: Response,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json")) {
    throw new Error("Microsoft returned an invalid content type.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("Microsoft response exceeded the allowed size.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Microsoft returned an empty response.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Microsoft response exceeded the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return asRecord(JSON.parse(decoder.decode(bytes)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Microsoft returned")) throw error;
    throw new Error("Microsoft returned invalid JSON.");
  }
}

function mailResult(value: Record<string, unknown>, limit: number) {
  if (!Array.isArray(value.value) || value.value.length > limit) {
    throw new Error("Microsoft Graph returned an invalid mail response.");
  }
  const messages = value.value.map((raw) => {
    const item = asRecord(raw);
    const from = item.from === null || item.from === undefined ? null : asRecord(item.from);
    const emailAddress = from === null ? null : asRecord(from.emailAddress);
    return {
      id: boundedString(item.id, 512),
      subject: boundedOptionalString(item.subject, 1_000),
      from:
        emailAddress === null
          ? null
          : {
              name: boundedOptionalString(emailAddress.name, 512),
              address: boundedOptionalString(emailAddress.address, 320),
            },
      receivedDateTime: boundedString(item.receivedDateTime, 64),
      isRead:
        typeof item.isRead === "boolean"
          ? item.isRead
          : (() => {
              throw new Error("Microsoft Graph returned an invalid mail response.");
            })(),
    };
  });
  return { messages, hasMore: typeof value["@odata.nextLink"] === "string" };
}

function graphDateTime(value: unknown): { readonly dateTime: string; readonly timeZone: string } {
  const item = asRecord(value);
  return {
    dateTime: boundedString(item.dateTime, 64),
    timeZone: boundedString(item.timeZone, 128),
  };
}

function calendarResult(value: Record<string, unknown>) {
  if (!Array.isArray(value.value) || value.value.length > 50) {
    throw new Error("Microsoft Graph returned an invalid calendar response.");
  }
  const events = value.value.map((raw) => {
    const item = asRecord(raw);
    const location =
      item.location === null || item.location === undefined ? null : asRecord(item.location);
    const organizer =
      item.organizer === null || item.organizer === undefined ? null : asRecord(item.organizer);
    const emailAddress = organizer === null ? null : asRecord(organizer.emailAddress);
    return {
      id: boundedString(item.id, 512),
      subject: boundedOptionalString(item.subject, 1_000),
      start: graphDateTime(item.start),
      end: graphDateTime(item.end),
      location: location === null ? null : boundedOptionalString(location.displayName, 1_000),
      organizer:
        emailAddress === null
          ? null
          : {
              name: boundedOptionalString(emailAddress.name, 512),
              address: boundedOptionalString(emailAddress.address, 320),
            },
    };
  });
  return { events, hasMore: typeof value["@odata.nextLink"] === "string" };
}

export class MicrosoftGraphProvider implements IntegrationProvider {
  readonly id = MICROSOFT_GRAPH_PROVIDER_ID;
  readonly tools = MICROSOFT_GRAPH_TOOLS;
  readonly #secrets: IntegrationSecretStore;
  readonly #clientId: string;
  readonly #loginRoot: string;
  readonly #fetch: Fetch;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingFlow>();
  readonly #polling = new Set<string>();
  readonly #requestControllers = new Set<AbortController>();
  #accessToken: AccessToken | null = null;
  #generation = 0;
  #connectAttempt = 0;
  #credentialRevision = 0;
  #closed = false;
  #disconnecting = false;
  #uncertainCredentialState = false;
  #credentialMutation: Promise<void> = Promise.resolve();

  constructor(
    secrets: IntegrationSecretStore,
    configuration: MicrosoftGraphConfiguration,
    fetchImplementation: Fetch = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.#secrets = secrets;
    this.#clientId = validateEntraIdentifier(configuration.clientId, "client ID");
    const tenantId = validateEntraIdentifier(configuration.tenantId, "tenant ID");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new Error("Microsoft 365 Read requires a bounded request timeout.");
    }
    this.#loginRoot = `${IDENTITY_ORIGIN}/${tenantId}/oauth2/v2.0`;
    this.#fetch = fetchImplementation;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async #request(
    input: string,
    init: RequestInit,
    maximumBytes: number,
    inspectResponse?: (response: Response) => void,
  ) {
    if (this.#closed) throw new Error("Microsoft 365 Read is closed.");
    const controller = new AbortController();
    this.#requestControllers.add(controller);
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const signals = [controller.signal, timeoutSignal];
    if (init.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    try {
      const response = await this.#fetch(input, {
        ...init,
        redirect: "error",
        signal,
      });
      inspectResponse?.(response);
      return { response, json: await readJson(response, maximumBytes) };
    } catch (error) {
      if (init.signal?.aborted)
        throw new Error("Microsoft request was cancelled.", { cause: error });
      if (controller.signal.aborted)
        throw new Error("Microsoft provider was closed.", { cause: error });
      if (timeoutSignal.aborted) throw new Error("Microsoft request timed out.", { cause: error });
      throw error;
    } finally {
      this.#requestControllers.delete(controller);
    }
  }

  #postForm(
    path: "devicecode" | "token",
    form: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) {
    return this.#request(
      `${this.#loginRoot}/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
        signal: signal ?? null,
      },
      IDENTITY_RESPONSE_BYTES,
    );
  }

  #serializeCredential<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#credentialMutation.then(operation, operation);
    this.#credentialMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #readCredential(signal?: AbortSignal): Promise<Credential | null> {
    const value = await Effect.runPromise(this.#secrets.get(MICROSOFT_GRAPH_SECRET_SUFFIX), {
      signal,
    });
    return Option.isSome(value) ? parseCredential(value.value) : null;
  }

  #writeCredential(credential: Credential, signal: AbortSignal): Promise<void> {
    return Effect.runPromise(
      this.#secrets.set(MICROSOFT_GRAPH_SECRET_SUFFIX, encoder.encode(JSON.stringify(credential))),
      { signal },
    );
  }

  async #beginCommit(context?: IntegrationLifecycleContext): Promise<AbortSignal> {
    if (!context || typeof context.beginCommit !== "function") {
      throw new Error("Microsoft credential mutation requires Harness commit admission.");
    }
    return context.beginCommit();
  }

  async status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus> {
    if (this.#uncertainCredentialState) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Credential state is uncertain. Disconnect to verify reset before reconnecting.",
      };
    }
    if (this.#closed) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The Microsoft 365 Read provider is closed.",
      };
    }
    if (this.#disconnecting) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Microsoft 365 Read is disconnecting.",
      };
    }
    const generation = this.#generation;
    const credentialRevision = this.#credentialRevision;
    try {
      const credential = await this.#readCredential(context?.signal);
      if (this.#closed) {
        return {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "The Microsoft 365 Read provider is closed.",
        };
      }
      if (this.#uncertainCredentialState) {
        return {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "Credential state is uncertain. Disconnect to verify reset before reconnecting.",
        };
      }
      if (
        this.#disconnecting ||
        generation !== this.#generation ||
        credentialRevision !== this.#credentialRevision
      ) {
        return {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "Microsoft connection state changed while status was being checked.",
        };
      }
      const now = Date.now();
      for (const [flowId, flow] of this.#pending) {
        if (flow.expiresAt <= now && !this.#polling.has(flowId)) this.#pending.delete(flowId);
      }
      if (!credential) {
        return {
          state: this.#pending.size > 0 ? "connecting" : "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message: null,
        };
      }
      return {
        state: "connected",
        accountLabel: null,
        grantedCapabilities: capabilitiesFromScopes(credential.grantedScopes),
        message: "Connected with read-only delegated access.",
      };
    } catch {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The stored Microsoft connection could not be verified. Disconnect to reset it.",
      };
    }
  }

  async connect(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationDeviceCodeConnectResult> {
    if (submission !== undefined) throw new Error("Microsoft device sign-in rejects submissions.");
    if (this.#closed || this.#disconnecting) throw new Error("Microsoft 365 Read is unavailable.");
    if (this.#uncertainCredentialState) throw new Error("Microsoft credential state is uncertain.");
    if (context?.signal.aborted) throw new Error("Microsoft sign-in was cancelled.");
    if (
      capabilities.length === 0 ||
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) => !CAPABILITY_NAMES.has(capability))
    ) {
      throw new Error("Unsupported Microsoft 365 Read capability.");
    }
    const generation = this.#generation;
    const connectAttempt = ++this.#connectAttempt;
    const credentialRevisionBeforeRead = this.#credentialRevision;
    const existing = await this.#readCredential(context?.signal);
    if (credentialRevisionBeforeRead !== this.#credentialRevision) {
      throw new Error("Microsoft credential changed while sign-in was starting.");
    }
    const credentialRevision = this.#credentialRevision;
    const requestedScopes = [
      ...new Set([
        ...(existing?.grantedScopes ?? []),
        ...capabilities.map(
          (capability) => CAPABILITY_SCOPES[capability as keyof typeof CAPABILITY_SCOPES],
        ),
      ]),
    ].toSorted();
    const { response, json } = await this.#postForm(
      "devicecode",
      { client_id: this.#clientId, scope: [OFFLINE_SCOPE, ...requestedScopes].join(" ") },
      context?.signal,
    );
    if (!response.ok) {
      throw new IntegrationProviderPublicError(
        "Microsoft sign-in could not start. Try again later.",
      );
    }
    const deviceCode = boundedString(json.device_code, MAX_TOKEN_CHARS);
    const userCode = boundedString(json.user_code, 128);
    const verificationUri = safeVerificationUrl(json.verification_uri);
    const verificationUriComplete =
      json.verification_uri_complete === undefined
        ? null
        : safeVerificationUrl(json.verification_uri_complete);
    const intervalSeconds = boundedInteger(json.interval, 1, 60, 5);
    const expiresInSeconds = boundedInteger(json.expires_in, 60, 1_800);
    if (
      this.#closed ||
      this.#disconnecting ||
      this.#uncertainCredentialState ||
      generation !== this.#generation ||
      connectAttempt !== this.#connectAttempt ||
      credentialRevision !== this.#credentialRevision
    ) {
      throw new Error("Microsoft sign-in was superseded while starting.");
    }
    this.#pending.clear();
    const flowId = crypto.randomUUID();
    const expiresAt = Date.now() + expiresInSeconds * 1_000;
    this.#pending.set(flowId, {
      deviceCode,
      requestedScopes,
      expiresAt,
      intervalSeconds,
      generation,
    });
    return {
      kind: "device_code",
      flowId,
      verificationUri,
      verificationUriComplete,
      userCode,
      message: `Open ${verificationUri} and enter the displayed code.`,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds,
    };
  }

  async poll(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult> {
    const flow = this.#pending.get(flowId);
    if (!flow) throw new IntegrationProviderPublicError("Microsoft sign-in flow was not found.");
    if (this.#polling.has(flowId)) {
      throw new IntegrationProviderPublicError("Microsoft sign-in is already being checked.");
    }
    if (flow.expiresAt <= Date.now()) {
      this.#pending.delete(flowId);
      return {
        state: "expired",
        retryAfterSeconds: null,
        message: "Sign-in expired. Start again.",
      };
    }
    if (this.#uncertainCredentialState) throw new Error("Microsoft credential state is uncertain.");
    this.#polling.add(flowId);
    let admitted = false;
    let tokenResponseSettled = false;
    let credentialIssued = false;
    try {
      const commitSignal = await this.#beginCommit(context);
      admitted = true;
      const { response, json } = await this.#postForm(
        "token",
        {
          client_id: this.#clientId,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: flow.deviceCode,
        },
        commitSignal,
      );
      tokenResponseSettled = true;
      credentialIssued = response.ok;
      if (
        this.#closed ||
        this.#disconnecting ||
        flow.generation !== this.#generation ||
        !this.#pending.has(flowId)
      ) {
        throw new Error("Microsoft sign-in was superseded.");
      }
      if (!response.ok) {
        if (json.error === "authorization_pending") {
          return {
            state: "pending",
            retryAfterSeconds: flow.intervalSeconds,
            message: "Waiting for Microsoft sign-in.",
          };
        }
        if (json.error === "slow_down") {
          const retryAfterSeconds = Math.min(60, flow.intervalSeconds + 5);
          this.#pending.set(flowId, { ...flow, intervalSeconds: retryAfterSeconds });
          return {
            state: "pending",
            retryAfterSeconds,
            message: "Microsoft asked the client to poll more slowly.",
          };
        }
        this.#pending.delete(flowId);
        return {
          state: "failed",
          retryAfterSeconds: null,
          message: "Microsoft sign-in failed. Start again.",
        };
      }
      const accessToken = boundedString(json.access_token, MAX_TOKEN_CHARS);
      const refreshToken = boundedString(json.refresh_token, MAX_TOKEN_CHARS);
      const grantedScopes = canonicalScopes(json.scope, flow.requestedScopes);
      const expiresInSeconds = boundedInteger(json.expires_in, 60, 86_400);
      const credential: Credential = {
        version: 1,
        refreshToken,
        grantedScopes,
        updatedAt: new Date().toISOString(),
      };
      await this.#serializeCredential(async () => {
        if (
          this.#closed ||
          this.#disconnecting ||
          this.#uncertainCredentialState ||
          flow.generation !== this.#generation ||
          !this.#pending.has(flowId)
        ) {
          throw new Error("Microsoft sign-in was superseded before credential commit.");
        }
        await this.#writeCredential(credential, commitSignal);
        this.#credentialRevision += 1;
        this.#generation += 1;
        this.#pending.clear();
        this.#accessToken = {
          value: accessToken,
          expiresAt: Date.now() + expiresInSeconds * 1_000,
          grantedScopes,
        };
      });
      this.#pending.delete(flowId);
      return {
        state: "connected",
        retryAfterSeconds: null,
        message: "Microsoft 365 Read is connected.",
      };
    } catch (error) {
      if (
        admitted &&
        flow.generation === this.#generation &&
        (!tokenResponseSettled || credentialIssued)
      ) {
        this.#uncertainCredentialState = true;
      }
      throw error;
    } finally {
      this.#polling.delete(flowId);
    }
  }

  prepare(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      if (this.#uncertainCredentialState)
        throw new Error("Microsoft credential state is uncertain.");
      if (this.#closed || this.#disconnecting)
        throw new Error("Microsoft 365 Read is unavailable.");
      const access = this.#accessToken;
      if (access && access.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) return;
      const credential = await this.#readCredential(context?.signal);
      if (!credential) return;
      let admitted = false;
      try {
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        const { response, json } = await this.#postForm(
          "token",
          {
            client_id: this.#clientId,
            grant_type: "refresh_token",
            [REFRESH_TOKEN_FIELD]: credential.refreshToken,
            scope: [OFFLINE_SCOPE, ...credential.grantedScopes].join(" "),
          },
          commitSignal,
        );
        if (!response.ok) {
          throw new IntegrationProviderPublicError(
            "Microsoft access could not be refreshed. Disconnect and reconnect.",
          );
        }
        const accessToken = boundedString(json.access_token, MAX_TOKEN_CHARS);
        const rotatedValue = boundedString(
          json[REFRESH_TOKEN_FIELD] ?? credential.refreshToken,
          MAX_TOKEN_CHARS,
        );
        const grantedScopes = canonicalScopes(json.scope, credential.grantedScopes);
        const expiresInSeconds = boundedInteger(json.expires_in, 60, 86_400);
        await this.#writeCredential(
          {
            version: 1,
            [refreshValueField]: rotatedValue,
            grantedScopes,
            updatedAt: new Date().toISOString(),
          },
          commitSignal,
        );
        this.#credentialRevision += 1;
        this.#accessToken = {
          value: accessToken,
          expiresAt: Date.now() + expiresInSeconds * 1_000,
          grantedScopes,
        };
      } catch (error) {
        if (admitted) this.#uncertainCredentialState = true;
        throw error;
      }
    });
  }

  disconnect(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      this.#disconnecting = true;
      this.#generation += 1;
      this.#pending.clear();
      this.#accessToken = null;
      let admitted = false;
      try {
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        await Effect.runPromise(this.#secrets.remove(MICROSOFT_GRAPH_SECRET_SUFFIX), {
          signal: commitSignal,
        });
        this.#credentialRevision += 1;
        this.#uncertainCredentialState = false;
      } catch (error) {
        if (admitted) this.#uncertainCredentialState = true;
        throw error;
      } finally {
        this.#disconnecting = false;
      }
    });
  }

  async #graph(path: string, accessToken: string, signal?: AbortSignal) {
    const { response, json } = await this.#request(
      `${GRAPH_API_ROOT}${path}`,
      { headers: { authorization: `Bearer ${accessToken}` }, signal: signal ?? null },
      GRAPH_RESPONSE_BYTES,
      (received) => {
        if (received.status === 401 && this.#accessToken?.value === accessToken) {
          this.#accessToken = null;
        }
      },
    );
    if (!response.ok)
      throw new Error(`Microsoft Graph request failed with HTTP ${response.status}.`);
    return json;
  }

  async invoke(
    toolName: string,
    input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown> {
    if (this.#closed || this.#disconnecting || this.#uncertainCredentialState) {
      throw new Error("Microsoft 365 Read is unavailable.");
    }
    if (context?.signal.aborted) throw new Error("Microsoft request was cancelled.");
    const access = this.#accessToken;
    if (!access || access.expiresAt - ACCESS_TOKEN_SKEW_MS <= Date.now()) {
      throw new IntegrationProviderPublicError(
        "The Microsoft 365 Read session needs a safe refresh. Disconnect and reconnect.",
      );
    }
    const generation = this.#generation;
    if (toolName === "microsoft365.mail.search") {
      if (!access.grantedScopes.includes(CAPABILITY_SCOPES["mail.read"])) {
        throw new IntegrationProviderPublicError("Microsoft 365 Read mail access is not granted.");
      }
      const values = await decodeMailSearchInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const query = values.query?.trim() ?? "";
      const limit = values.limit ?? 10;
      const params = new URLSearchParams({
        $select: "id,subject,from,receivedDateTime,isRead",
        $top: String(limit),
      });
      if (query) {
        params.set("$search", '"' + query.replaceAll('"', " ").replaceAll("\\", " ") + '"');
      } else params.set("$orderby", "receivedDateTime desc");
      const result = await this.#graph(
        `/me/messages?${params.toString()}`,
        access.value,
        context?.signal,
      );
      if (
        this.#closed ||
        this.#disconnecting ||
        this.#uncertainCredentialState ||
        generation !== this.#generation
      ) {
        throw new Error("Microsoft access was revoked or became uncertain.");
      }
      return mailResult(result, limit);
    }
    if (toolName === "microsoft365.calendar.events") {
      if (!access.grantedScopes.includes(CAPABILITY_SCOPES["calendar.read"])) {
        throw new IntegrationProviderPublicError(
          "Microsoft 365 Read calendar access is not granted.",
        );
      }
      const values = await decodeCalendarEventsInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const start = isoTimestamp(values.start ?? new Date().toISOString());
      const end = isoTimestamp(
        values.end ?? new Date(Date.parse(start) + 7 * 86_400_000).toISOString(),
      );
      const range = Date.parse(end) - Date.parse(start);
      if (range <= 0 || range > MAX_CALENDAR_RANGE_MS) {
        throw new IntegrationProviderPublicError(
          "Calendar range must be positive and no longer than 31 days.",
        );
      }
      const params = new URLSearchParams({
        startDateTime: start,
        endDateTime: end,
        $select: "id,subject,start,end,location,organizer",
        $top: "50",
        $orderby: "start/dateTime",
      });
      const result = await this.#graph(
        `/me/calendarView?${params.toString()}`,
        access.value,
        context?.signal,
      );
      if (
        this.#closed ||
        this.#disconnecting ||
        this.#uncertainCredentialState ||
        generation !== this.#generation
      ) {
        throw new Error("Microsoft access was revoked or became uncertain.");
      }
      return calendarResult(result);
    }
    throw new Error("Unsupported Microsoft 365 Read tool.");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#pending.clear();
    this.#accessToken = null;
    for (const controller of this.#requestControllers) controller.abort();
    await this.#credentialMutation;
  }
}
