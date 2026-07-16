import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import type { IntegrationLifecycleContext, IntegrationSecretStore } from "./host-contract.ts";
import {
  MICROSOFT_GRAPH_SECRET_SUFFIX,
  MICROSOFT_GRAPH_TOOLS,
  MicrosoftGraphProvider,
} from "./MicrosoftGraphProvider.ts";

const TEST_CONFIGURATION = {
  clientId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
} as const;

const value = (kind: string) => ["fixture", kind].join("-");
const storedFixtureValue = value("refresh-stored");
const accessField = ["access", "token"].join("_");
const refreshField = ["refresh", "token"].join("_");
const storedRefreshField = ["refresh", "Token"].join("");

interface SecretOptions {
  readonly failGet?: boolean;
  readonly failSet?: boolean;
  readonly failSetAfterWrite?: boolean;
  readonly failRemove?: boolean;
}

interface ControlledSecretOptions {
  readonly failSetAfterWriteCall?: number;
  readonly pauseGetCall?: number;
  readonly getPaused?: () => void;
  readonly getGate?: Promise<void>;
}

function memorySecrets(options: SecretOptions = {}) {
  const values = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const service: IntegrationSecretStore = {
    get: (name) =>
      Effect.sync(() => {
        calls.push(`get:${name}`);
        if (options.failGet) throw new Error("fixture get failure");
        return Option.fromUndefinedOr(values.get(name));
      }),
    set: (name, bytes) =>
      Effect.sync(() => {
        calls.push(`set:${name}`);
        if (options.failSet) throw new Error("fixture set failure");
        values.set(name, Uint8Array.from(bytes));
        if (options.failSetAfterWrite) throw new Error("fixture uncertain set");
      }),
    remove: (name) =>
      Effect.sync(() => {
        calls.push(`remove:${name}`);
        if (options.failRemove) throw new Error("fixture remove failure");
        values.delete(name);
      }),
  };
  return { service, values, calls };
}

function controlledSecrets(options: ControlledSecretOptions = {}) {
  const values = new Map<string, Uint8Array>();
  let getCalls = 0;
  let setCalls = 0;
  const service: IntegrationSecretStore = {
    get: (name) =>
      Effect.promise(async () => {
        getCalls += 1;
        if (getCalls === options.pauseGetCall) {
          options.getPaused?.();
          await options.getGate;
        }
        return Option.fromUndefinedOr(values.get(name));
      }),
    set: (name, bytes) =>
      Effect.sync(() => {
        setCalls += 1;
        values.set(name, Uint8Array.from(bytes));
        if (setCalls === options.failSetAfterWriteCall) {
          throw new Error("fixture uncertain set");
        }
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  };
  return { service, values };
}

function lifecycle(events: string[] = []): IntegrationLifecycleContext & {
  readonly beginCommit: ReturnType<typeof vi.fn>;
} {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    beginCommit: vi.fn(async () => {
      events.push("beginCommit");
      return controller.signal;
    }),
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenBody(scopes: string, suffix = "one"): Record<string, unknown> {
  return {
    [accessField]: value(`access-${suffix}`),
    [refreshField]: value(`refresh-${suffix}`),
    expires_in: 3600,
    scope: scopes,
  };
}

function deviceBody(suffix = "one"): Record<string, unknown> {
  return {
    device_code: value(`device-${suffix}`),
    user_code: `CODE-${suffix}`,
    verification_uri: "https://microsoft.com/devicelogin",
    verification_uri_complete: "https://microsoft.com/devicelogin?otc=CODE",
    expires_in: 900,
    interval: 1,
  };
}

function storedCredential(scopes: ReadonlyArray<string> = ["Mail.Read"]) {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      [storedRefreshField]: storedFixtureValue,
      grantedScopes: scopes,
      updatedAt: new Date(0).toISOString(),
    }),
  );
}

function provider(
  secrets: IntegrationSecretStore,
  fetchImplementation: typeof fetch,
  requestTimeoutMs?: number,
) {
  return new MicrosoftGraphProvider(
    secrets,
    TEST_CONFIGURATION,
    fetchImplementation,
    requestTimeoutMs,
  );
}

async function authorize(
  graph: MicrosoftGraphProvider,
  capabilities: ReadonlyArray<string> = ["mail.read"],
  context = lifecycle(),
) {
  const flow = await graph.connect(capabilities, context);
  await graph.poll(flow.flowId, context);
  return flow;
}

describe("MicrosoftGraphProvider contract", () => {
  it("requires deployment-injected UUID identifiers and a bounded timeout", () => {
    const secrets = memorySecrets();
    expect(
      () =>
        new MicrosoftGraphProvider(secrets.service, {
          clientId: "not-configured",
          tenantId: TEST_CONFIGURATION.tenantId,
        }),
    ).toThrow(/valid Entra client ID/u);
    expect(
      () =>
        new MicrosoftGraphProvider(secrets.service, {
          clientId: TEST_CONFIGURATION.clientId,
          tenantId: "not-configured",
        }),
    ).toThrow(/valid Entra tenant ID/u);
    expect(() => provider(secrets.service, globalThis.fetch, 30_001)).toThrow(/bounded/u);
    expect(() => provider(secrets.service, globalThis.fetch, 1.5)).toThrow(/bounded/u);
  });

  it("publishes executable exact Effect schemas and truthful read metadata", async () => {
    for (const tool of MICROSOFT_GRAPH_TOOLS) {
      expect(tool).toMatchObject({
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: true,
      });
      expect(Schema.toJsonSchemaDocument(tool.input).schema).toMatchObject({ type: "object" });
    }
    const mail = MICROSOFT_GRAPH_TOOLS[0];
    await expect(
      Schema.decodeUnknownPromise(mail.input)(
        { query: "ok", extra: true },
        {
          onExcessProperty: "error",
        },
      ),
    ).rejects.toBeDefined();
  });

  it("requests only explicit incremental read scopes from the fixed tenant host", async () => {
    const secrets = memorySecrets();
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse(deviceBody());
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);

    const result = await graph.connect(["mail.read"], lifecycle());
    const body = String(calls[0]?.init?.body);
    expect(result).toMatchObject({
      kind: "device_code",
      verificationUriComplete: expect.any(String),
    });
    expect(calls[0]?.url).toBe(
      `https://login.microsoftonline.com/${TEST_CONFIGURATION.tenantId}/oauth2/v2.0/devicecode`,
    );
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(body).toContain("offline_access");
    expect(body).toContain("Mail.Read");
    expect(body).not.toContain("Calendars.Read");
    expect(body).not.toContain(".default");
    expect(body).not.toContain("client_secret");
  });

  it("rejects undeclared capabilities, duplicate capabilities, and connection submissions", async () => {
    const secrets = memorySecrets();
    const graph = provider(secrets.service, vi.fn() as unknown as typeof fetch);
    await expect(graph.connect(["mail.write"], lifecycle())).rejects.toThrow(/Unsupported/u);
    await expect(graph.connect(["constructor"], lifecycle())).rejects.toThrow(/Unsupported/u);
    await expect(graph.connect(["__proto__"], lifecycle())).rejects.toThrow(/Unsupported/u);
    await expect(graph.connect(["mail.read", "mail.read"], lifecycle())).rejects.toThrow(
      /Unsupported/u,
    );
    await expect(
      graph.connect(["mail.read"], lifecycle(), { flowId: "x", value: "x" }),
    ).rejects.toThrow(/rejects submissions/u);
  });

  it("rejects a verification URL outside fixed Microsoft identity hosts", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async () =>
      jsonResponse({
        ...deviceBody(),
        verification_uri: "https://example.invalid/device",
      })) as typeof fetch;
    await expect(
      provider(secrets.service, fetchImplementation).connect(["mail.read"], lifecycle()),
    ).rejects.toThrow(/verification address/u);
  });

  it("accepts Microsoft's current login.microsoft.com device verification host", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async () =>
      jsonResponse({
        ...deviceBody(),
        verification_uri: "https://login.microsoft.com/device",
        verification_uri_complete: undefined,
      })) as typeof fetch;

    await expect(
      provider(secrets.service, fetchImplementation).connect(["mail.read"], lifecycle()),
    ).resolves.toMatchObject({
      verificationUri: "https://login.microsoft.com/device",
      verificationUriComplete: null,
    });
  });

  it("admits token redemption before credential commit and stores only the package-local refresh credential", async () => {
    const secrets = memorySecrets();
    const events: string[] = [];
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      events.push(url.endsWith("/devicecode") ? "device" : "token");
      return url.endsWith("/devicecode")
        ? jsonResponse(deviceBody())
        : jsonResponse(tokenBody("offline_access Mail.Read"));
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const context = lifecycle(events);

    const flow = await graph.connect(["mail.read"], context);
    await graph.poll(flow.flowId, context);

    expect(events).toEqual(["device", "beginCommit", "token"]);
    expect(context.beginCommit).toHaveBeenCalledOnce();
    expect([...secrets.values.keys()]).toEqual([MICROSOFT_GRAPH_SECRET_SUFFIX]);
    const persisted = new TextDecoder().decode(secrets.values.get(MICROSOFT_GRAPH_SECRET_SUFFIX));
    expect(persisted).toContain(value("refresh-one"));
    expect(persisted).not.toContain(value("access-one"));
    expect(await graph.status()).toMatchObject({
      state: "connected",
      grantedCapabilities: ["mail.read"],
    });
  });

  it("accepts Microsoft identity response scopes without broadening Graph access", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/devicecode")
        ? jsonResponse(deviceBody())
        : jsonResponse(tokenBody("Calendars.Read Mail.Read profile openid email"))) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);

    const flow = await graph.connect(["mail.read", "calendar.read"], lifecycle());
    await expect(graph.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
      state: "connected",
    });
    await expect(graph.status()).resolves.toMatchObject({
      state: "connected",
      grantedCapabilities: ["calendar.read", "mail.read"],
    });
    const persisted = new TextDecoder().decode(secrets.values.get(MICROSOFT_GRAPH_SECRET_SUFFIX));
    expect(persisted).not.toContain("openid");
    expect(persisted).not.toContain("profile");
    expect(persisted).not.toContain("email");
  });

  it("fails closed on unexpected or missing OAuth scopes", async () => {
    for (const scopes of [
      "offline_access Mail.Read Mail.ReadWrite",
      "offline_access Calendars.Read",
      "offline_access Mail.Read Calendars.Read",
      "offline_access Mail.Read User.Read",
    ]) {
      const secrets = memorySecrets();
      const fetchImplementation = (async (input: RequestInfo | URL) =>
        String(input).endsWith("/devicecode")
          ? jsonResponse(deviceBody())
          : jsonResponse(tokenBody(scopes))) as typeof fetch;
      const graph = provider(secrets.service, fetchImplementation);
      const flow = await graph.connect(["mail.read"], lifecycle());
      await expect(graph.poll(flow.flowId, lifecycle())).rejects.toThrow(/scope/u);
      expect(await graph.status()).toMatchObject({ state: "error", grantedCapabilities: [] });
    }
  });

  it("accepts omitted OAuth scope only as the exactly requested unchanged set", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/devicecode")) return jsonResponse(deviceBody());
      const body = tokenBody("offline_access Mail.Read");
      delete body.scope;
      return jsonResponse(body);
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    expect(await graph.status()).toMatchObject({
      state: "connected",
      grantedCapabilities: ["mail.read"],
    });
  });

  it("sanitizes hostile OAuth errors instead of surfacing remote descriptions", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/devicecode")
        ? jsonResponse(deviceBody())
        : jsonResponse(
            {
              error: "access_denied",
              error_description: `do not expose ${value("refresh-hostile")}`,
            },
            400,
          )) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const flow = await graph.connect(["mail.read"], lifecycle());
    const result = await graph.poll(flow.flowId, lifecycle());
    expect(result).toEqual({
      state: "failed",
      retryAfterSeconds: null,
      message: "Microsoft sign-in failed. Start again.",
    });
    expect(JSON.stringify(result)).not.toContain(value("refresh-hostile"));
  });

  it("prevents concurrent device-code replay and supersedes older flows", async () => {
    const secrets = memorySecrets();
    let deviceCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/devicecode")) {
        deviceCount += 1;
        return jsonResponse(deviceBody(String(deviceCount)));
      }
      await gate;
      return jsonResponse({ error: "authorization_pending" }, 400);
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const older = await graph.connect(["mail.read"], lifecycle());
    const newer = await graph.connect(["calendar.read"], lifecycle());
    await expect(graph.poll(older.flowId, lifecycle())).rejects.toThrow(/not found/u);
    const first = graph.poll(newer.flowId, lifecycle());
    await expect(graph.poll(newer.flowId, lifecycle())).rejects.toThrow(/already/u);
    release();
    await expect(first).resolves.toMatchObject({ state: "pending" });
  });

  it("keeps the newest concurrent connect attempt when responses finish out of order", async () => {
    const secrets = memorySecrets();
    const releases: Array<() => void> = [];
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const fetchImplementation = (async () => {
      if (releases.length >= 2) return jsonResponse({ error: "authorization_pending" }, 400);
      const index = releases.length;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        if (releases.length === 2) markBothStarted();
      });
      return jsonResponse(deviceBody(String(index + 1)));
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const older = graph.connect(["mail.read"], lifecycle());
    const newer = graph.connect(["calendar.read"], lifecycle());
    await bothStarted;
    releases[1]?.();
    const newestFlow = await newer;
    releases[0]?.();
    await expect(older).rejects.toThrow(/superseded/u);
    expect(newestFlow.kind).toBe("device_code");
    await expect(graph.poll(newestFlow.flowId, lifecycle())).resolves.toMatchObject({
      state: "pending",
    });
  });

  it("does not poison a replacement flow when a superseded poll returns pending", async () => {
    const secrets = memorySecrets();
    let deviceCount = 0;
    let tokenCount = 0;
    let releaseOlderPoll!: () => void;
    let markOlderPollStarted!: () => void;
    const olderPollStarted = new Promise<void>((resolve) => {
      markOlderPollStarted = resolve;
    });
    const olderPollGate = new Promise<void>((resolve) => {
      releaseOlderPoll = resolve;
    });
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/devicecode")) {
        deviceCount += 1;
        return jsonResponse(deviceBody(String(deviceCount)));
      }
      tokenCount += 1;
      if (tokenCount === 1) {
        markOlderPollStarted();
        await olderPollGate;
      }
      return jsonResponse({ error: "authorization_pending" }, 400);
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const older = await graph.connect(["mail.read"], lifecycle());
    const olderPoll = graph.poll(older.flowId, lifecycle());
    await olderPollStarted;
    const newer = await graph.connect(["calendar.read"], lifecycle());
    releaseOlderPoll();
    await expect(olderPoll).rejects.toThrow(/superseded/u);
    expect(await graph.status()).toMatchObject({ state: "connecting", grantedCapabilities: [] });
    await expect(graph.poll(newer.flowId, lifecycle())).resolves.toMatchObject({
      state: "pending",
    });
  });

  it("rejects a connect snapshot made stale by an overlapping credential commit", async () => {
    const secrets = memorySecrets();
    let deviceCount = 0;
    let releaseReplacement!: () => void;
    let markReplacementStarted!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      markReplacementStarted = resolve;
    });
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) {
        deviceCount += 1;
        if (deviceCount === 2) {
          markReplacementStarted();
          await replacementGate;
        }
        return jsonResponse(deviceBody(String(deviceCount)));
      }
      return jsonResponse(tokenBody("offline_access Mail.Read"));
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const mailFlow = await graph.connect(["mail.read"], lifecycle());
    const calendarConnect = graph.connect(["calendar.read"], lifecycle());
    await replacementStarted;
    await graph.poll(mailFlow.flowId, lifecycle());
    releaseReplacement();
    await expect(calendarConnect).rejects.toThrow(/superseded/u);
    expect(await graph.status()).toMatchObject({
      state: "connected",
      grantedCapabilities: ["mail.read"],
    });
  });

  it("rotates refresh credentials only through an admitted lifecycle operation", async () => {
    const secrets = memorySecrets();
    secrets.values.set(MICROSOFT_GRAPH_SECRET_SUFFIX, storedCredential());
    const events: string[] = [];
    const fetchImplementation = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      events.push("token");
      expect(String(init?.body)).toContain(storedFixtureValue);
      expect(init?.redirect).toBe("error");
      return jsonResponse(tokenBody("offline_access Mail.Read", "rotated"));
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const context = lifecycle(events);

    expect(await graph.status()).toMatchObject({
      state: "connected",
      grantedCapabilities: ["mail.read"],
    });
    await graph.prepare(context);
    await graph.prepare(context);
    const persisted = new TextDecoder().decode(secrets.values.get(MICROSOFT_GRAPH_SECRET_SUFFIX));
    expect(events).toEqual(["beginCommit", "token"]);
    expect(persisted).toContain(value("refresh-rotated"));
    expect(persisted).not.toContain(value("access-rotated"));
  });

  it("preserves an incremental-consent flow during routine token refresh", async () => {
    const secrets = memorySecrets();
    secrets.values.set(MICROSOFT_GRAPH_SECRET_SUFFIX, storedCredential());
    let tokenCalls = 0;
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/devicecode")) return jsonResponse(deviceBody());
      tokenCalls += 1;
      return tokenCalls === 1
        ? jsonResponse(tokenBody("offline_access Mail.Read", "refreshed"))
        : jsonResponse(tokenBody("offline_access Calendars.Read Mail.Read", "consented"));
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);

    const flow = await graph.connect(["calendar.read"], lifecycle());
    await graph.prepare(lifecycle());
    await expect(graph.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
      state: "connected",
    });
    expect(await graph.status()).toMatchObject({
      state: "connected",
      grantedCapabilities: ["calendar.read", "mail.read"],
    });
  });

  it("does not refresh or mutate credentials from ordinary tool invocation", async () => {
    const secrets = memorySecrets();
    secrets.values.set(MICROSOFT_GRAPH_SECRET_SUFFIX, storedCredential());
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await expect(graph.invoke("microsoft365.mail.search", {})).rejects.toThrow(/safe refresh/u);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(secrets.calls.filter((call) => call.startsWith("set:"))).toEqual([]);
  });

  it("fails status closed after an uncertain successful-write failure", async () => {
    const secrets = memorySecrets({ failSetAfterWrite: true });
    const fetchImplementation = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/devicecode")
        ? jsonResponse(deviceBody())
        : jsonResponse(tokenBody("offline_access Mail.Read"))) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const flow = await graph.connect(["mail.read"], lifecycle());
    await expect(graph.poll(flow.flowId, lifecycle())).rejects.toThrow(/uncertain set/u);
    expect(await graph.status()).toMatchObject({ state: "error", grantedCapabilities: [] });
  });

  it("fails an in-flight status check closed when credential uncertainty arises", async () => {
    let releaseStatusRead!: () => void;
    let markStatusReadPaused!: () => void;
    const statusReadPaused = new Promise<void>((resolve) => {
      markStatusReadPaused = resolve;
    });
    const statusReadGate = new Promise<void>((resolve) => {
      releaseStatusRead = resolve;
    });
    const secrets = controlledSecrets({
      failSetAfterWriteCall: 2,
      pauseGetCall: 3,
      getPaused: markStatusReadPaused,
      getGate: statusReadGate,
    });
    let tokenCalls = 0;
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/devicecode")) return jsonResponse(deviceBody());
      tokenCalls += 1;
      return jsonResponse(
        tokenBody(
          tokenCalls === 1 ? "offline_access Mail.Read" : "offline_access Calendars.Read Mail.Read",
        ),
      );
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    const incremental = await graph.connect(["calendar.read"], lifecycle());
    const status = graph.status();
    await statusReadPaused;
    await expect(graph.poll(incremental.flowId, lifecycle())).rejects.toThrow(/uncertain set/u);
    releaseStatusRead();
    await expect(status).resolves.toMatchObject({ state: "error", grantedCapabilities: [] });
  });

  it("fails an in-flight status snapshot closed after disconnect commits", async () => {
    let releaseStatusRead!: () => void;
    let markStatusReadPaused!: () => void;
    const statusReadPaused = new Promise<void>((resolve) => {
      markStatusReadPaused = resolve;
    });
    const statusReadGate = new Promise<void>((resolve) => {
      releaseStatusRead = resolve;
    });
    const secrets = controlledSecrets({
      pauseGetCall: 1,
      getPaused: markStatusReadPaused,
      getGate: statusReadGate,
    });
    secrets.values.set(MICROSOFT_GRAPH_SECRET_SUFFIX, storedCredential());
    const graph = provider(secrets.service, vi.fn() as unknown as typeof fetch);

    const status = graph.status();
    await statusReadPaused;
    await graph.disconnect(lifecycle());
    releaseStatusRead();

    await expect(status).resolves.toMatchObject({
      state: "error",
      grantedCapabilities: [],
    });
  });

  it("rejects a device-code response when another admitted flow makes credentials uncertain", async () => {
    const secrets = controlledSecrets({ failSetAfterWriteCall: 2 });
    let deviceCalls = 0;
    let tokenCalls = 0;
    let releaseReplacement!: () => void;
    let markReplacementStarted!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      markReplacementStarted = resolve;
    });
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/devicecode")) {
        deviceCalls += 1;
        if (deviceCalls === 3) {
          markReplacementStarted();
          await replacementGate;
        }
        return jsonResponse(deviceBody(String(deviceCalls)));
      }
      tokenCalls += 1;
      return jsonResponse(
        tokenBody(
          tokenCalls === 1 ? "offline_access Mail.Read" : "offline_access Calendars.Read Mail.Read",
        ),
      );
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    const incremental = await graph.connect(["calendar.read"], lifecycle());
    const replacement = graph.connect(["calendar.read"], lifecycle());
    await replacementStarted;
    await expect(graph.poll(incremental.flowId, lifecycle())).rejects.toThrow(/uncertain set/u);
    releaseReplacement();
    await expect(replacement).rejects.toThrow(/superseded/u);
  });

  it("rejects a queued poll commit after refresh makes credentials uncertain", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const secrets = controlledSecrets({ failSetAfterWriteCall: 2 });
    let tokenCalls = 0;
    let releaseRefresh!: () => void;
    let markRefreshStarted!: () => void;
    let markPollTokenReturned!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const pollTokenReturned = new Promise<void>((resolve) => {
      markPollTokenReturned = resolve;
    });
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/devicecode")) return jsonResponse(deviceBody());
      tokenCalls += 1;
      if (tokenCalls === 2) {
        markRefreshStarted();
        await refreshGate;
        return jsonResponse(tokenBody("offline_access Mail.Read", "refreshed"));
      }
      if (tokenCalls === 3) {
        markPollTokenReturned();
        return jsonResponse(tokenBody("offline_access Calendars.Read Mail.Read", "consented"));
      }
      return jsonResponse(tokenBody("offline_access Mail.Read"));
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    try {
      await authorize(graph);
      vi.advanceTimersByTime(3_600_000);
      const incremental = await graph.connect(["calendar.read"], lifecycle());

      const preparing = graph.prepare(lifecycle());
      await refreshStarted;
      const polling = graph.poll(incremental.flowId, lifecycle());
      await pollTokenReturned;
      releaseRefresh();

      await expect(preparing).rejects.toThrow(/uncertain set/u);
      await expect(polling).rejects.toThrow(/superseded/u);
      await expect(graph.status()).resolves.toMatchObject({
        state: "error",
        grantedCapabilities: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves malformed stored credentials untouched and status observational", async () => {
    const secrets = memorySecrets();
    const malformed = new TextEncoder().encode('{"version":1,"unexpected":true}');
    secrets.values.set(MICROSOFT_GRAPH_SECRET_SUFFIX, malformed);
    const graph = provider(secrets.service, vi.fn() as unknown as typeof fetch);
    expect(await graph.status()).toMatchObject({ state: "error", grantedCapabilities: [] });
    expect(secrets.values.get(MICROSOFT_GRAPH_SECRET_SUFFIX)).toEqual(malformed);
    expect(secrets.calls.some((call) => call.startsWith("remove:"))).toBe(false);
  });

  it("fails status closed when the secret store cannot be read", async () => {
    const secrets = memorySecrets({ failGet: true });
    const graph = provider(secrets.service, vi.fn() as unknown as typeof fetch);
    expect(await graph.status()).toMatchObject({ state: "error", grantedCapabilities: [] });
  });

  it("refuses credential mutation when Harness commit admission is absent", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/devicecode")
        ? jsonResponse(deviceBody())
        : jsonResponse(tokenBody("offline_access Mail.Read"))) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const flow = await graph.connect(["mail.read"], lifecycle());
    await expect(graph.poll(flow.flowId)).rejects.toThrow(/commit admission/u);
    expect(secrets.values.has(MICROSOFT_GRAPH_SECRET_SUFFIX)).toBe(false);
  });

  it("uses admitted package-scoped disconnect, is idempotent, and clears uncertainty", async () => {
    const secrets = memorySecrets();
    secrets.values.set(MICROSOFT_GRAPH_SECRET_SUFFIX, storedCredential());
    const graph = provider(secrets.service, vi.fn() as unknown as typeof fetch);
    const context = lifecycle();
    await graph.disconnect(context);
    await graph.disconnect(context);
    expect(context.beginCommit).toHaveBeenCalledTimes(2);
    expect(
      secrets.calls.filter((call) => call === `remove:${MICROSOFT_GRAPH_SECRET_SUFFIX}`),
    ).toHaveLength(2);
    expect(await graph.status()).toMatchObject({ state: "not_connected" });
  });

  it("keeps verified disconnect authoritative over a late admitted poll", async () => {
    const secrets = memorySecrets();
    let releaseToken!: () => void;
    let markTokenStarted!: () => void;
    const tokenStarted = new Promise<void>((resolve) => {
      markTokenStarted = resolve;
    });
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/devicecode")) return jsonResponse(deviceBody());
      markTokenStarted();
      await tokenGate;
      return jsonResponse(tokenBody("offline_access Mail.Read"));
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    const flow = await graph.connect(["mail.read"], lifecycle());
    const polling = graph.poll(flow.flowId, lifecycle());
    await tokenStarted;
    await graph.disconnect(lifecycle());
    releaseToken();
    await expect(polling).rejects.toThrow(/superseded/u);
    expect(await graph.status()).toMatchObject({
      state: "not_connected",
      grantedCapabilities: [],
    });
  });

  it("fails closed when disconnect removal does not settle", async () => {
    const secrets = memorySecrets({ failRemove: true });
    secrets.values.set(MICROSOFT_GRAPH_SECRET_SUFFIX, storedCredential());
    const graph = provider(secrets.service, vi.fn() as unknown as typeof fetch);
    await expect(graph.disconnect(lifecycle())).rejects.toThrow(/remove failure/u);
    expect(await graph.status()).toMatchObject({ state: "error", grantedCapabilities: [] });
  });
});

describe("MicrosoftGraphProvider tools", () => {
  it("invalidates a rejected access token so the next preparation refreshes it", async () => {
    const secrets = memorySecrets();
    let tokenRequests = 0;
    let graphRequests = 0;
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) {
        tokenRequests += 1;
        return jsonResponse(tokenBody("offline_access Mail.Read", String(tokenRequests)));
      }
      graphRequests += 1;
      if (graphRequests === 1) return new Response(null, { status: 401 });
      return jsonResponse({ value: [] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);

    await expect(graph.invoke("microsoft365.mail.search", {})).rejects.toThrow(/empty response/u);
    await graph.prepare(lifecycle());
    await expect(graph.invoke("microsoft365.mail.search", {})).resolves.toMatchObject({
      messages: [],
    });
    expect(tokenRequests).toBe(2);
  });

  it("does not revoke an in-flight read during routine access-token refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const secrets = memorySecrets();
    let releaseGraph!: () => void;
    const graphGate = new Promise<void>((resolve) => {
      releaseGraph = resolve;
    });
    let markGraphStarted!: () => void;
    const graphStarted = new Promise<void>((resolve) => {
      markGraphStarted = resolve;
    });
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.Read"));
      markGraphStarted();
      await graphGate;
      return jsonResponse({ value: [] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    try {
      await authorize(graph);
      const invocation = graph.invoke("microsoft365.mail.search", {});
      await graphStarted;
      vi.setSystemTime(Date.now() + 3_550_000);
      await graph.prepare(lifecycle());
      releaseGraph();
      await expect(invocation).resolves.toMatchObject({ messages: [] });
    } finally {
      releaseGraph?.();
      vi.useRealTimers();
    }
  });

  it("normalizes mail results, bounds pagination, and never follows nextLink", async () => {
    const secrets = memorySecrets();
    const calls: string[] = [];
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.Read"));
      return jsonResponse({
        value: [
          {
            id: "message-1",
            subject: "Budget",
            from: { emailAddress: { name: "Person", address: "person@example.edu" } },
            receivedDateTime: "2026-07-15T10:00:00Z",
            isRead: false,
          },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/ignored",
      });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    const result = await graph.invoke("microsoft365.mail.search", {
      query: 'budget "Q4"',
      limit: 5,
    });
    expect(result).toMatchObject({ messages: [{ id: "message-1" }], hasMore: true });
    expect(calls.filter((url) => url.includes("/me/messages?"))).toHaveLength(1);
    const graphUrl = calls.at(-1) ?? "";
    expect(graphUrl.startsWith("https://graph.microsoft.com/v1.0/me/messages?")).toBe(true);
    expect(graphUrl).toContain("%24top=5");
    expect(graphUrl).not.toContain("Q4%22");
  });

  it("uses only the fixed bounded calendarView endpoint", async () => {
    const secrets = memorySecrets();
    const calls: string[] = [];
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Calendars.Read"));
      return jsonResponse({
        value: [
          {
            id: "event-1",
            subject: "Review",
            start: { dateTime: "2026-07-15T09:00:00", timeZone: "Pacific Standard Time" },
            end: { dateTime: "2026-07-15T10:00:00", timeZone: "Pacific Standard Time" },
            location: { displayName: "Online" },
            organizer: { emailAddress: { name: "Person", address: "person@example.edu" } },
          },
        ],
      });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["calendar.read"]);
    const result = await graph.invoke("microsoft365.calendar.events", {
      start: "2026-07-15T00:00:00-07:00",
      end: "2026-07-16T00:00:00-07:00",
    });
    expect(result).toMatchObject({ events: [{ id: "event-1" }], hasMore: false });
    expect(calls.at(-1)?.startsWith("https://graph.microsoft.com/v1.0/me/calendarView?")).toBe(
      true,
    );
  });

  it("accepts bounded empty optional fields in Graph projections", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Calendars.Read"));
      return jsonResponse({
        value: [
          {
            id: "event-empty-fields",
            subject: "",
            start: { dateTime: "2026-07-15T09:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-07-15T10:00:00", timeZone: "UTC" },
            location: { displayName: "" },
            organizer: { emailAddress: { name: "", address: "" } },
          },
        ],
      });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["calendar.read"]);
    await expect(
      graph.invoke("microsoft365.calendar.events", {
        start: "2026-07-15T00:00:00Z",
        end: "2026-07-16T00:00:00Z",
      }),
    ).resolves.toMatchObject({
      events: [{ id: "event-empty-fields", subject: "", location: "" }],
    });
  });

  it("rejects malformed, extra, NaN, overlong, and out-of-range tool input before Graph", async () => {
    const secrets = memorySecrets();
    let graphCalls = 0;
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token"))
        return jsonResponse(tokenBody("offline_access Mail.Read Calendars.Read"));
      graphCalls += 1;
      return jsonResponse({ value: [] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["mail.read", "calendar.read"]);
    for (const input of [
      null,
      [],
      { extra: true },
      { limit: Number.NaN },
      { query: "x".repeat(201) },
    ]) {
      await expect(graph.invoke("microsoft365.mail.search", input)).rejects.toBeDefined();
    }
    for (const input of [
      { start: "not-a-date", end: "2026-07-16T00:00:00Z" },
      { start: "2026-07-15T00:00:00", end: "2026-07-16T00:00:00Z" },
      { start: "2026-02-31T00:00:00Z", end: "2026-03-02T00:00:00Z" },
      { start: "2026-07-16T00:00:00Z", end: "2026-07-15T00:00:00Z" },
      { start: "2026-01-01T00:00:00Z", end: "2026-03-01T00:00:00Z" },
    ]) {
      await expect(graph.invoke("microsoft365.calendar.events", input)).rejects.toBeDefined();
    }
    expect(graphCalls).toBe(0);
  });

  it("rejects undeclared tools and capabilities without a network call", async () => {
    const secrets = memorySecrets();
    let graphCalls = 0;
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.Read"));
      graphCalls += 1;
      return jsonResponse({ value: [] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    await expect(graph.invoke("microsoft365.generic.request", {})).rejects.toThrow(/Unsupported/u);
    await expect(graph.invoke("microsoft365.calendar.events", {})).rejects.toThrow(/not granted/u);
    expect(graphCalls).toBe(0);
  });

  it("rejects response-shape abuse and too many items", async () => {
    for (const response of [
      { value: {} },
      { value: Array.from({ length: 26 }, (_, id) => ({ id })) },
      { value: [{ id: "x", subject: "x" }] },
    ]) {
      const secrets = memorySecrets();
      const fetchImplementation = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
        if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.Read"));
        return jsonResponse(response);
      }) as typeof fetch;
      const graph = provider(secrets.service, fetchImplementation);
      await authorize(graph);
      await expect(graph.invoke("microsoft365.mail.search", { limit: 25 })).rejects.toThrow(
        /invalid/u,
      );
    }
  });

  it("rejects overlarge Graph responses before JSON projection", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.Read"));
      return jsonResponse({ value: [], padding: "x".repeat(1024 * 1024) });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    await expect(graph.invoke("microsoft365.mail.search", {})).rejects.toThrow(/exceeded/u);
  });

  it("propagates cancellation and enforces request timeout", async () => {
    const secrets = memorySecrets();
    let requests = 0;
    const fetchImplementation = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;
      if (requests <= 2) {
        return Promise.resolve(
          requests === 1
            ? jsonResponse(deviceBody())
            : jsonResponse(tokenBody("offline_access Mail.Read")),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation, 20);
    await authorize(graph);
    const controller = new AbortController();
    const cancelled = graph.invoke("microsoft365.mail.search", {}, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/u);
    await expect(graph.invoke("microsoft365.mail.search", {})).rejects.toThrow(/timed out/u);
  });

  it("makes close idempotent and aborts in-flight work without deleting credentials", async () => {
    const secrets = memorySecrets();
    let requests = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchImplementation = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;
      if (requests <= 2) {
        return Promise.resolve(
          requests === 1
            ? jsonResponse(deviceBody())
            : jsonResponse(tokenBody("offline_access Mail.Read")),
        );
      }
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    const invocation = graph.invoke("microsoft365.mail.search", {});
    await started;
    const closing = graph.close();
    await expect(invocation).rejects.toThrow(/closed/u);
    await expect(closing).resolves.toBeUndefined();
    await expect(graph.close()).resolves.toBeUndefined();
    expect(secrets.values.has(MICROSOFT_GRAPH_SECRET_SUFFIX)).toBe(true);
  });

  it("does not return data or restore credentials when disconnect races an invocation", async () => {
    const secrets = memorySecrets();
    let requests = 0;
    let releaseGraph!: () => void;
    let markGraphStarted!: () => void;
    const graphStarted = new Promise<void>((resolve) => {
      markGraphStarted = resolve;
    });
    const graphGate = new Promise<void>((resolve) => {
      releaseGraph = resolve;
    });
    const fetchImplementation = (async (_input: RequestInfo | URL) => {
      requests += 1;
      if (requests === 1) return jsonResponse(deviceBody());
      if (requests === 2) return jsonResponse(tokenBody("offline_access Mail.Read"));
      markGraphStarted();
      await graphGate;
      return jsonResponse({ value: [] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    const invocation = graph.invoke("microsoft365.mail.search", {});
    await graphStarted;
    await graph.disconnect(lifecycle());
    releaseGraph();
    await expect(invocation).rejects.toThrow(/revoked/u);
    expect(secrets.values.has(MICROSOFT_GRAPH_SECRET_SUFFIX)).toBe(false);
    expect(await graph.status()).toMatchObject({ state: "not_connected" });
  });

  it("does not return Graph data after an admitted credential mutation becomes uncertain", async () => {
    const secrets = controlledSecrets({ failSetAfterWriteCall: 2 });
    let deviceCalls = 0;
    let tokenCalls = 0;
    let releaseGraph!: () => void;
    let markGraphStarted!: () => void;
    const graphStarted = new Promise<void>((resolve) => {
      markGraphStarted = resolve;
    });
    const graphGate = new Promise<void>((resolve) => {
      releaseGraph = resolve;
    });
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) {
        deviceCalls += 1;
        return jsonResponse(deviceBody(String(deviceCalls)));
      }
      if (url.endsWith("/token")) {
        tokenCalls += 1;
        return jsonResponse(
          tokenBody(
            tokenCalls === 1
              ? "offline_access Mail.Read"
              : "offline_access Calendars.Read Mail.Read",
          ),
        );
      }
      markGraphStarted();
      await graphGate;
      return jsonResponse({ value: [] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    const incremental = await graph.connect(["calendar.read"], lifecycle());
    const invocation = graph.invoke("microsoft365.mail.search", {});
    await graphStarted;
    await expect(graph.poll(incremental.flowId, lifecycle())).rejects.toThrow(/uncertain set/u);
    releaseGraph();
    await expect(invocation).rejects.toThrow(/uncertain/u);
  });

  it("does not return old-session Graph data after a credential replacement", async () => {
    const secrets = memorySecrets();
    let deviceCalls = 0;
    let tokenCalls = 0;
    let releaseGraph!: () => void;
    let markGraphStarted!: () => void;
    const graphStarted = new Promise<void>((resolve) => {
      markGraphStarted = resolve;
    });
    const graphGate = new Promise<void>((resolve) => {
      releaseGraph = resolve;
    });
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) {
        deviceCalls += 1;
        return jsonResponse(deviceBody(String(deviceCalls)));
      }
      if (url.endsWith("/token")) {
        tokenCalls += 1;
        return jsonResponse(
          tokenBody(
            tokenCalls === 1
              ? "offline_access Mail.Read"
              : "offline_access Calendars.Read Mail.Read",
            String(tokenCalls),
          ),
        );
      }
      markGraphStarted();
      await graphGate;
      return jsonResponse({ value: [] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    const replacement = await graph.connect(["calendar.read"], lifecycle());
    const invocation = graph.invoke("microsoft365.mail.search", {});
    await graphStarted;
    await expect(graph.poll(replacement.flowId, lifecycle())).resolves.toMatchObject({
      state: "connected",
    });
    releaseGraph();
    await expect(invocation).rejects.toThrow(/revoked/u);
  });
});
