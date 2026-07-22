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

  it("publishes executable exact Effect schemas and truthful effect metadata", async () => {
    const expected = new Map([
      ["microsoft365.mail.search", { readOnly: true, destructive: false, idempotent: true }],
      ["microsoft365.mail.get", { readOnly: true, destructive: false, idempotent: true }],
      [
        "microsoft365.mail.attachments.list",
        { readOnly: true, destructive: false, idempotent: true },
      ],
      [
        "microsoft365.mail.attachment.get",
        { readOnly: true, destructive: false, idempotent: true },
      ],
      [
        "microsoft365.mail.draft.create",
        { readOnly: false, destructive: false, idempotent: false },
      ],
      ["microsoft365.calendar.events", { readOnly: true, destructive: false, idempotent: true }],
      ["microsoft365.calendar.event.get", { readOnly: true, destructive: false, idempotent: true }],
      [
        "microsoft365.calendar.event.attachments.list",
        { readOnly: true, destructive: false, idempotent: true },
      ],
      [
        "microsoft365.calendar.event.attachment.get",
        { readOnly: true, destructive: false, idempotent: true },
      ],
      [
        "microsoft365.calendar.event.create",
        { readOnly: false, destructive: false, idempotent: false },
      ],
      [
        "microsoft365.calendar.event.update",
        { readOnly: false, destructive: true, idempotent: false },
      ],
      ["microsoft365.chat.list", { readOnly: true, destructive: false, idempotent: true }],
      ["microsoft365.chat.messages", { readOnly: true, destructive: false, idempotent: true }],
      [
        "microsoft365.chat.message.send",
        { readOnly: false, destructive: false, idempotent: false },
      ],
    ]);
    for (const tool of MICROSOFT_GRAPH_TOOLS) {
      expect(tool).toMatchObject({ ...expected.get(tool.name), openWorld: true });
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

  it("maps every selected capability to only its fixed delegated scope", async () => {
    const secrets = memorySecrets();
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse(deviceBody());
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);

    await graph.connect(
      [
        "mail.read",
        "mail.draft.create",
        "calendar.read",
        "calendar.write",
        "chat.read",
        "chat.write",
      ],
      lifecycle(),
    );
    const body = String(calls[0]?.init?.body);
    for (const scope of [
      "Mail.Read",
      "Mail.ReadWrite",
      "Calendars.Read",
      "Calendars.ReadWrite",
      "Chat.Read",
      "Chat.ReadWrite",
    ]) {
      expect(body).toContain(scope);
    }
    expect(body).not.toContain("Mail.Send");
    expect(body).not.toContain("ChatMessage.Send");
    expect(body).not.toContain(".default");
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

  it("accepts additive previously-consented scopes without broadening Graph access", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/devicecode")
        ? jsonResponse(deviceBody())
        : jsonResponse(
            tokenBody(
              "Calendars.Read Calendars.ReadWrite Chat.Read Chat.ReadWrite Contacts.Read " +
                "Contacts.ReadWrite email Files.Read Files.ReadWrite Mail.Read Mail.ReadWrite " +
                "Mail.Send offline_access Presence.Read Tasks.Read Tasks.ReadWrite User.Read " +
                "User.ReadBasic.All profile openid",
            ),
          )) as typeof fetch;
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
    expect(persisted).not.toContain("Mail.ReadWrite");
    expect(persisted).not.toContain("Calendars.ReadWrite");
  });

  it("fails closed on unexpected or missing OAuth scopes", async () => {
    for (const scopes of ["offline_access Calendars.Read", "offline_access Mail.Read Mail.Read"]) {
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
      graphResponse: { value: [] },
    });
    expect(tokenRequests).toBe(2);
  });

  it.each([
    [400, /could not accept/u],
    [401, /session expired/u],
    [403, /denied/u],
    [404, /not found/u],
    [409, /changed or conflicts/u],
    [429, /rate limiting/u],
  ])("surfaces a safe public error for Graph HTTP %i", async (status, message) => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.Read"));
      return jsonResponse({ error: { code: "fixture" } }, status);
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);

    await expect(graph.invoke("microsoft365.mail.search", {})).rejects.toThrow(message);
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
      await expect(invocation).resolves.toMatchObject({
        messages: [],
        graphResponse: { value: [] },
      });
    } finally {
      releaseGraph?.();
      vi.useRealTimers();
    }
  });

  it("keeps compatible mail search fields and reads one complete message efficiently", async () => {
    const secrets = memorySecrets();
    const calls: string[] = [];
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.Read"));
      if (url.includes("/me/messages?")) {
        return jsonResponse({
          value: [
            {
              id: "message-1",
              subject: "Budget",
              from: { emailAddress: { name: "Person", address: "person@example.edu" } },
              receivedDateTime: "2026-07-15T10:00:00Z",
              isRead: false,
              bodyPreview: "Quarterly budget review",
              hasAttachments: true,
              fixtureProperty: { preserved: true },
            },
            {
              id: "message-2",
              subject: "System notice",
              from: { emailAddress: null },
              receivedDateTime: "2026-07-15T11:00:00Z",
              isRead: true,
              bodyPreview: null,
              hasAttachments: false,
            },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/ignored",
        });
      }
      return jsonResponse({
        id: "message-1",
        subject: "Budget",
        from: { emailAddress: { name: "Person", address: "person@example.edu" } },
        receivedDateTime: "2026-07-15T10:00:00Z",
        isRead: false,
        body: { contentType: "html", content: "<p>Complete email body</p>" },
        toRecipients: [{ emailAddress: { address: "recipient@example.edu" } }],
        fixtureProperty: { preserved: true },
      });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);
    const result = await graph.invoke("microsoft365.mail.search", {
      query: 'budget "Q4"',
      limit: 5,
    });
    expect(result).toMatchObject({
      messages: [
        {
          id: "message-1",
          preview: "Quarterly budget review",
          hasAttachments: true,
        },
        { id: "message-2", from: null, preview: null, hasAttachments: false },
      ],
      hasMore: true,
      graphResponse: {
        value: [{ id: "message-1", fixtureProperty: { preserved: true } }, { id: "message-2" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/ignored",
      },
    });
    await expect(
      graph.invoke("microsoft365.mail.get", { messageId: "message/id?fixture" }),
    ).resolves.toMatchObject({
      id: "message-1",
      from: { name: "Person", address: "person@example.edu" },
      body: { content: "<p>Complete email body</p>" },
      graphResponse: {
        toRecipients: [{ emailAddress: { address: "recipient@example.edu" } }],
        fixtureProperty: { preserved: true },
      },
    });
    expect(calls.filter((url) => url.includes("/me/messages?"))).toHaveLength(1);
    const graphUrl = calls.find((url) => url.includes("/me/messages?")) ?? "";
    expect(graphUrl.startsWith("https://graph.microsoft.com/v1.0/me/messages?")).toBe(true);
    expect(graphUrl).toContain("%24top=5");
    expect(decodeURIComponent(graphUrl)).toContain(
      "$select=id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments",
    );
    expect(graphUrl).not.toContain("Q4%22");
    expect(calls.at(-1)).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/message%2Fid%3Ffixture",
    );
  });

  it("keeps calendar discovery light and reads one complete event", async () => {
    const secrets = memorySecrets();
    const calls: string[] = [];
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Calendars.Read"));
      if (url.endsWith("/me/events/event%2Fid%3Ffixture")) {
        return jsonResponse({
          id: "event-1",
          subject: "Review",
          start: { dateTime: "2026-07-15T09:00:00", timeZone: "Pacific Standard Time" },
          end: { dateTime: "2026-07-15T10:00:00", timeZone: "Pacific Standard Time" },
          location: { displayName: "Online" },
          attendees: [
            {
              emailAddress: { name: "Person", address: "person@example.edu" },
              type: "required",
              status: { response: "accepted" },
            },
          ],
          webLink: "https://outlook.office.com/calendar/event-1",
          body: { contentType: "html", content: "<p>Complete agenda</p>" },
          fixtureProperty: { preserved: true },
        });
      }
      return jsonResponse({
        value: [
          {
            id: "event-1",
            subject: "Review",
            start: { dateTime: "2026-07-15T09:00:00", timeZone: "Pacific Standard Time" },
            end: { dateTime: "2026-07-15T10:00:00", timeZone: "Pacific Standard Time" },
            location: { displayName: "Online" },
            organizer: { emailAddress: { name: "Person", address: "person@example.edu" } },
            bodyPreview: "Complete agenda",
            hasAttachments: true,
          },
          {
            id: "event-2",
            subject: "System event",
            start: { dateTime: "2026-07-15T11:00:00", timeZone: "Pacific Standard Time" },
            end: { dateTime: "2026-07-15T12:00:00", timeZone: "Pacific Standard Time" },
            location: null,
            organizer: { emailAddress: null },
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
    expect(result).toMatchObject({
      events: [
        { id: "event-1", subject: "Review", location: "Online" },
        { id: "event-2", organizer: null },
      ],
      hasMore: false,
      graphResponse: {
        value: [
          {
            id: "event-1",
            bodyPreview: "Complete agenda",
            hasAttachments: true,
          },
          { id: "event-2", organizer: { emailAddress: null } },
        ],
      },
    });
    const calendarUrl = calls.find((url) => url.includes("/me/calendarView?")) ?? "";
    expect(calendarUrl.startsWith("https://graph.microsoft.com/v1.0/me/calendarView?")).toBe(true);
    expect(decodeURIComponent(calendarUrl)).toContain(
      "$select=id,subject,start,end,location,organizer,bodyPreview,hasAttachments",
    );
    await expect(
      graph.invoke("microsoft365.calendar.event.get", { eventId: "event/id?fixture" }),
    ).resolves.toMatchObject({
      id: "event-1",
      attendees: [{ emailAddress: { address: "person@example.edu" }, type: "required" }],
      graphResponse: {
        body: { content: "<p>Complete agenda</p>" },
        attendees: [{ status: { response: "accepted" } }],
        fixtureProperty: { preserved: true },
      },
    });
    expect(calls.at(-1)).toBe("https://graph.microsoft.com/v1.0/me/events/event%2Fid%3Ffixture");
  });

  it("reads mail and calendar attachments under the existing read capabilities", async () => {
    const secrets = memorySecrets();
    const graphCalls: string[] = [];
    const attachment = {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: "attachment/id?fixture",
      name: "review.txt",
      contentType: "text/plain",
      contentBytes: "cmV2aWV3",
      fixtureProperty: { preserved: true },
    };
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) {
        return jsonResponse(tokenBody("offline_access Mail.Read Calendars.Read"));
      }
      graphCalls.push(url);
      if (url.includes("/events/") && url.includes("$expand=")) {
        return jsonResponse({
          "@odata.type": "#microsoft.graph.itemAttachment",
          id: "attachment/id?fixture",
          name: "Attached event",
          item: {
            "@odata.type": "#microsoft.graph.event",
            id: "attached-event",
            subject: "Full attached event",
            body: { contentType: "html", content: "<p>Attached event body</p>" },
          },
        });
      }
      return url.includes("/attachments?")
        ? jsonResponse({ value: [attachment], "@odata.nextLink": "https://example.invalid/next" })
        : jsonResponse(attachment);
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["mail.read", "calendar.read"]);

    await expect(
      graph.invoke("microsoft365.mail.attachments.list", {
        messageId: "message/id?fixture",
        limit: 3,
      }),
    ).resolves.toMatchObject({
      value: [{ id: "attachment/id?fixture", contentBytes: "cmV2aWV3" }],
      "@odata.nextLink": "https://example.invalid/next",
    });
    await expect(
      graph.invoke("microsoft365.mail.attachment.get", {
        messageId: "message/id?fixture",
        attachmentId: "attachment/id?fixture",
      }),
    ).resolves.toMatchObject({
      id: "attachment/id?fixture",
      contentBytes: "cmV2aWV3",
      fixtureProperty: { preserved: true },
    });
    await expect(
      graph.invoke("microsoft365.calendar.event.attachments.list", {
        eventId: "event/id?fixture",
        limit: 4,
      }),
    ).resolves.toMatchObject({ value: [{ name: "review.txt" }] });
    await expect(
      graph.invoke("microsoft365.calendar.event.attachment.get", {
        eventId: "event/id?fixture",
        attachmentId: "attachment/id?fixture",
      }),
    ).resolves.toMatchObject({
      id: "attachment/id?fixture",
      item: {
        id: "attached-event",
        subject: "Full attached event",
        body: { content: "<p>Attached event body</p>" },
      },
    });

    expect(graphCalls).toEqual([
      "https://graph.microsoft.com/v1.0/me/messages/message%2Fid%3Ffixture/attachments?%24top=3&%24select=id%2Cname%2CcontentType%2Csize%2CisInline%2ClastModifiedDateTime",
      "https://graph.microsoft.com/v1.0/me/messages/message%2Fid%3Ffixture/attachments/attachment%2Fid%3Ffixture?$expand=microsoft.graph.itemattachment/item",
      "https://graph.microsoft.com/v1.0/me/events/event%2Fid%3Ffixture/attachments?%24top=4&%24select=id%2Cname%2CcontentType%2Csize%2CisInline%2ClastModifiedDateTime",
      "https://graph.microsoft.com/v1.0/me/events/event%2Fid%3Ffixture/attachments/attachment%2Fid%3Ffixture?$expand=microsoft.graph.itemattachment/item",
    ]);
  });

  it("creates an unsent draft with attachments and preserves its compatible result", async () => {
    const secrets = memorySecrets();
    const graphCalls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.ReadWrite"));
      graphCalls.push({ url, init });
      return jsonResponse(
        {
          id: "draft-1",
          subject: "Review",
          toRecipients: [{ emailAddress: { address: "person@example.edu" } }],
          ccRecipients: [],
          bccRecipients: [],
          isDraft: true,
          webLink: "https://outlook.office.com/mail/draft-1",
          fixtureProperty: { preserved: true },
        },
        201,
      );
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["mail.draft.create"]);

    await expect(
      graph.invoke("microsoft365.mail.draft.create", {
        to: ["person@example.edu"],
        subject: "Review",
        body: "Please review this draft.",
        attachments: [
          {
            name: "review.txt",
            contentBytes: "cmV2aWV3",
            contentType: "text/plain",
          },
          { name: "empty.txt", contentBytes: "" },
        ],
      }),
    ).resolves.toMatchObject({
      id: "draft-1",
      isDraft: true,
      webLink: "https://outlook.office.com/mail/draft-1",
      to: [{ address: "person@example.edu" }],
      cc: [],
      bcc: [],
      graphResponse: { fixtureProperty: { preserved: true } },
    });
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]?.url).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(graphCalls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(graphCalls[0]?.init?.body))).toEqual({
      subject: "Review",
      body: { contentType: "text", content: "Please review this draft." },
      toRecipients: [{ emailAddress: { address: "person@example.edu" } }],
      ccRecipients: [],
      bccRecipients: [],
      attachments: [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "review.txt",
          contentBytes: "cmV2aWV3",
          contentType: "text/plain",
        },
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "empty.txt",
          contentBytes: "",
        },
      ],
    });
  });

  it("creates and edits calendar events only through fixed event endpoints", async () => {
    const secrets = memorySecrets();
    const graphCalls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const response = {
      id: "event/id?fixture",
      subject: "Planning",
      start: { dateTime: "2026-07-20T16:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-07-20T17:00:00.0000000", timeZone: "UTC" },
      location: { displayName: "Online" },
      attendees: Array.from({ length: 51 }, (_, index) => ({
        emailAddress: { name: "Person", address: "person@example.edu" },
        type: "required",
        fixtureIndex: index,
      })),
      webLink: "https://outlook.office.com/calendar/event",
      fixtureProperty: { preserved: true },
    };
    const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token"))
        return jsonResponse(tokenBody("offline_access Calendars.ReadWrite"));
      graphCalls.push({ url, init });
      return jsonResponse(response, init?.method === "POST" ? 201 : 200);
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["calendar.write"]);

    const created = await graph.invoke("microsoft365.calendar.event.create", {
      subject: "Planning",
      start: "2026-07-20T09:00:00-07:00",
      end: "2026-07-20T10:00:00-07:00",
      location: "Online",
      body: "Agenda",
      attendees: [{ address: "person@example.edu", name: "Person", type: "optional" }],
    });
    expect(created).toMatchObject({
      id: "event/id?fixture",
      subject: "Planning",
      location: "Online",
      graphResponse: {
        location: { displayName: "Online" },
        fixtureProperty: { preserved: true },
      },
    });
    expect((created as { attendees: ReadonlyArray<unknown> }).attendees).toHaveLength(51);
    await expect(
      graph.invoke("microsoft365.calendar.event.update", {
        eventId: "event/id?fixture",
        subject: "Updated planning",
        location: "Room 1",
      }),
    ).resolves.toMatchObject({ id: "event/id?fixture" });

    expect(graphCalls.map(({ init }) => init?.method)).toEqual(["POST", "PATCH"]);
    expect(graphCalls[0]?.url).toBe("https://graph.microsoft.com/v1.0/me/events");
    expect(graphCalls[1]?.url).toBe(
      "https://graph.microsoft.com/v1.0/me/events/event%2Fid%3Ffixture",
    );
    expect(JSON.parse(String(graphCalls[0]?.init?.body))).toMatchObject({
      subject: "Planning",
      start: { dateTime: "2026-07-20T16:00:00.000", timeZone: "UTC" },
      end: { dateTime: "2026-07-20T17:00:00.000", timeZone: "UTC" },
      body: { contentType: "text", content: "Agenda" },
      attendees: [
        {
          emailAddress: { address: "person@example.edu", name: "Person" },
          type: "optional",
        },
      ],
    });
    expect(JSON.parse(String(graphCalls[1]?.init?.body))).toEqual({
      subject: "Updated planning",
      location: { displayName: "Room 1" },
    });
  });

  it("lists chats, reads bounded history, and sends plain text to an existing chat", async () => {
    const secrets = memorySecrets();
    const graphCalls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const message = {
      id: "message-1",
      createdDateTime: "2026-07-16T12:00:00Z",
      lastModifiedDateTime: null,
      from: { user: { id: "user-1", displayName: "Person" } },
      body: { contentType: "text", content: "Hello" },
      webUrl: "https://teams.microsoft.com/message-1",
      attachments: [{ id: "attachment-1" }],
      mentions: [{ id: 0, mentionText: "Person" }],
      fixtureProperty: { preserved: true },
    };
    const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token"))
        return jsonResponse(tokenBody("offline_access Chat.Read Chat.ReadWrite"));
      graphCalls.push({ url, init });
      if (url.includes("/me/chats?")) {
        return jsonResponse({
          value: [
            {
              id: "chat/id?fixture",
              topic: "Project",
              chatType: "group",
              createdDateTime: "2026-07-01T00:00:00Z",
              lastUpdatedDateTime: "2026-07-16T12:00:00Z",
              webUrl: "https://teams.microsoft.com/chat",
            },
          ],
        });
      }
      return init?.method === "POST"
        ? jsonResponse(message, 201)
        : jsonResponse({ value: [message] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["chat.read", "chat.write"]);

    await expect(graph.invoke("microsoft365.chat.list", { limit: 5 })).resolves.toMatchObject({
      chats: [{ id: "chat/id?fixture", topic: "Project" }],
      graphResponse: { value: [{ id: "chat/id?fixture", topic: "Project" }] },
    });
    await expect(
      graph.invoke("microsoft365.chat.messages", { chatId: "chat/id?fixture", limit: 5 }),
    ).resolves.toMatchObject({
      messages: [{ id: "message-1", body: { content: "Hello" } }],
      graphResponse: {
        value: [
          {
            id: "message-1",
            body: { content: "Hello" },
            attachments: [{ id: "attachment-1" }],
            mentions: [{ mentionText: "Person" }],
            fixtureProperty: { preserved: true },
          },
        ],
      },
    });
    await expect(
      graph.invoke("microsoft365.chat.message.send", {
        chatId: "chat/id?fixture",
        body: "Hello",
      }),
    ).resolves.toMatchObject({
      id: "message-1",
      body: { contentType: "text" },
      graphResponse: {
        attachments: [{ id: "attachment-1" }],
        fixtureProperty: { preserved: true },
      },
    });

    expect(graphCalls[0]?.url).not.toContain("%24select");
    expect(graphCalls[1]?.url).toContain("/chats/chat%2Fid%3Ffixture/messages?");
    expect(graphCalls[2]?.url).toBe(
      "https://graph.microsoft.com/v1.0/chats/chat%2Fid%3Ffixture/messages",
    );
    expect(graphCalls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(graphCalls[2]?.init?.body))).toEqual({
      body: { contentType: "text", content: "Hello" },
    });
  });

  it("preserves empty optional fields in compatible and Graph responses", async () => {
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
      graphResponse: {
        value: [{ id: "event-empty-fields", subject: "", location: { displayName: "" } }],
      },
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
      null,
      { messageId: "" },
      { messageId: "x".repeat(513) },
      { messageId: "message-1", extra: true },
    ]) {
      await expect(graph.invoke("microsoft365.mail.get", input)).rejects.toBeDefined();
    }
    for (const input of [null, { eventId: "" }, { eventId: "x".repeat(513), extra: true }]) {
      await expect(graph.invoke("microsoft365.calendar.event.get", input)).rejects.toBeDefined();
    }
    for (const [tool, input] of [
      ["microsoft365.mail.attachments.list", { messageId: "", limit: 1 }],
      ["microsoft365.mail.attachments.list", { messageId: "message-1", limit: 51 }],
      [
        "microsoft365.mail.attachment.get",
        { messageId: "message-1", attachmentId: "", extra: true },
      ],
      ["microsoft365.calendar.event.attachments.list", { eventId: "", limit: 1 }],
      ["microsoft365.calendar.event.attachments.list", { eventId: "event-1", limit: 51 }],
      ["microsoft365.calendar.event.attachment.get", { eventId: "event-1", attachmentId: "" }],
    ] as const) {
      await expect(graph.invoke(tool, input)).rejects.toBeDefined();
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

  it("rejects unsafe write input before Graph", async () => {
    const secrets = memorySecrets();
    let graphCalls = 0;
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) {
        return jsonResponse(
          tokenBody("offline_access Mail.ReadWrite Calendars.ReadWrite Chat.Read Chat.ReadWrite"),
        );
      }
      graphCalls += 1;
      return jsonResponse({});
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["mail.draft.create", "calendar.write", "chat.read", "chat.write"]);

    for (const input of [
      { to: [], subject: "x", body: "x" },
      { to: ["not-an-email"], subject: "x", body: "x" },
      { to: ["person@example.edu"], subject: "x", body: "" },
      { to: ["person@example.edu"], subject: "x".repeat(256), body: "x" },
      { to: ["person@example.edu"], subject: "x", body: "x", send: true },
      {
        to: ["person@example.edu"],
        subject: "x",
        body: "x",
        attachments: [{ name: "bad.txt", contentBytes: "not base64" }],
      },
      {
        to: ["person@example.edu"],
        subject: "x",
        body: "x",
        attachments: [{ name: "", contentBytes: "eA==" }],
      },
      {
        to: ["person@example.edu"],
        subject: "x",
        body: "x",
        attachments: [{ name: "x.txt", contentBytes: "eA==", path: "/tmp/x.txt" }],
      },
      {
        to: ["person@example.edu"],
        subject: "x",
        body: "x",
        attachments: [{ name: "x.png", contentBytes: "eA==", isInline: true }],
      },
    ]) {
      await expect(graph.invoke("microsoft365.mail.draft.create", input)).rejects.toBeDefined();
    }
    await expect(
      graph.invoke("microsoft365.mail.draft.create", {
        to: ["person@example.edu"],
        subject: "x",
        body: "x",
        attachments: [
          { name: "one.bin", contentBytes: "AAAA".repeat(525_000) },
          { name: "two.bin", contentBytes: "AAAA".repeat(525_000) },
        ],
      }),
    ).rejects.toThrow("encoded request must be at most 4 MB");
    for (const input of [
      { eventId: "event-1" },
      { eventId: "event-1", start: "2026-07-20T09:00:00Z" },
      { eventId: "event-1", body: "Do not replace online meeting bodies." },
      { eventId: "event-1", subject: "x".repeat(256) },
      {
        eventId: "event-1",
        start: "2026-07-20T10:00:00Z",
        end: "2026-07-20T09:00:00Z",
      },
      { eventId: "", subject: "Changed" },
    ]) {
      await expect(graph.invoke("microsoft365.calendar.event.update", input)).rejects.toBeDefined();
    }
    await expect(
      graph.invoke("microsoft365.calendar.event.create", {
        subject: "Role required",
        start: "2026-07-20T09:00:00Z",
        end: "2026-07-20T10:00:00Z",
        attendees: [{ address: "person@example.edu" }],
      }),
    ).rejects.toBeDefined();
    for (const [tool, input] of [
      ["microsoft365.chat.messages", { chatId: "", limit: 1 }],
      ["microsoft365.chat.messages", { chatId: "chat-1", limit: 51 }],
      ["microsoft365.chat.message.send", { chatId: "chat-1", body: "" }],
      ["microsoft365.chat.message.send", { chatId: "chat-1", body: "😀".repeat(8_000) }],
      ["microsoft365.chat.message.send", { chatId: "chat-1", body: "x", html: true }],
    ] as const) {
      await expect(graph.invoke(tool, input)).rejects.toBeDefined();
    }
    expect(graphCalls).toBe(0);
  });

  it("validates an explicit calendar start before deriving the default end", async () => {
    const secrets = memorySecrets();
    let graphCalls = 0;
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Calendars.Read"));
      graphCalls += 1;
      return jsonResponse({ value: [] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["calendar.read"]);

    await expect(
      graph.invoke("microsoft365.calendar.events", { start: "not-a-date" }),
    ).rejects.toThrow(/ISO 8601/u);
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
    await expect(
      graph.invoke("microsoft365.calendar.event.attachments.list", { eventId: "event-1" }),
    ).rejects.toThrow(/not granted/u);
    await expect(
      graph.invoke("microsoft365.mail.draft.create", {
        to: ["person@example.edu"],
        subject: "x",
        body: "x",
      }),
    ).rejects.toThrow(/not granted/u);
    await expect(
      graph.invoke("microsoft365.calendar.event.create", {
        subject: "x",
        start: "2026-07-20T09:00:00Z",
        end: "2026-07-20T10:00:00Z",
      }),
    ).rejects.toThrow(/not granted/u);
    await expect(graph.invoke("microsoft365.chat.list", {})).rejects.toThrow(/not granted/u);
    await expect(
      graph.invoke("microsoft365.chat.message.send", { chatId: "chat-1", body: "x" }),
    ).rejects.toThrow(/not granted/u);
    expect(graphCalls).toBe(0);
  });

  it("keeps a bounded compatible body and the complete Graph message", async () => {
    const secrets = memorySecrets();
    const bodyContent = "x".repeat(50_001);
    const response = {
      id: "message-1",
      subject: "Future property",
      from: { emailAddress: { name: "Person", address: "person@example.edu" } },
      receivedDateTime: "2026-07-15T10:00:00Z",
      isRead: false,
      body: { contentType: "html", content: bodyContent },
      futureGraphProperty: { nested: [1, 2, 3] },
    };
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.Read"));
      return jsonResponse(response);
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);

    const result = await graph.invoke("microsoft365.mail.get", { messageId: "message-1" });
    expect(result).toMatchObject({
      id: "message-1",
      from: { name: "Person", address: "person@example.edu" },
      graphResponse: { futureGraphProperty: { nested: [1, 2, 3] } },
    });
    expect((result as { body: { content: string } }).body.content).toBe(
      bodyContent.slice(0, 50_000),
    );
    expect((result as { graphResponse: unknown }).graphResponse).toEqual(response);
  });

  it("rejects a Graph collection larger than the requested result bound", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) return jsonResponse(tokenBody("offline_access Mail.Read"));
      return jsonResponse({ value: Array.from({ length: 26 }, (_, id) => ({ id })) });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph);

    await expect(graph.invoke("microsoft365.mail.search", { limit: 25 })).rejects.toThrow(
      /invalid collection/u,
    );
  });

  it("validates minimum resource identity without projecting response fields", async () => {
    const secrets = memorySecrets();
    const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) return jsonResponse(deviceBody());
      if (url.endsWith("/token")) {
        return jsonResponse(tokenBody("offline_access Mail.Read Mail.ReadWrite"));
      }
      return init?.method === "POST"
        ? jsonResponse({ isDraft: true }, 201)
        : jsonResponse({ value: [null] });
    }) as typeof fetch;
    const graph = provider(secrets.service, fetchImplementation);
    await authorize(graph, ["mail.read", "mail.draft.create"]);

    await expect(graph.invoke("microsoft365.mail.search", {})).rejects.toThrow(/invalid response/u);
    await expect(
      graph.invoke("microsoft365.mail.draft.create", {
        to: ["person@example.edu"],
        subject: "Fixture",
        body: "Fixture",
      }),
    ).rejects.toThrow(/invalid response/u);
  });

  it("rejects overlarge Graph responses before pass-through", async () => {
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
