import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { describe, expect, it, vi } from "vite-plus/test";

import type {
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationSecretStore,
} from "./host-contract.ts";
import { IntegrationProviderPublicError } from "./host-contract.ts";
import {
  GOOGLE_WORKSPACE_SECRET_SUFFIX,
  GOOGLE_WORKSPACE_TOOLS,
  GoogleWorkspaceProvider,
} from "./GoogleWorkspaceProvider.ts";

const TEST_CONFIGURATION = {
  clientId: "123456789012-syntheticdesktopclient1234567890.apps.googleusercontent.com",
  clientSecret: "fixture-desktop-client-credential",
} as const;
const decoder = new TextDecoder();

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2_048,
});
const publicJwk = publicKey.export({ format: "jwk" });
const TEST_KID = "fixture-google-key";

interface SecretOptions {
  failGet?: boolean;
  failSet?: boolean;
  failSetAfterWrite?: boolean;
  failRemove?: boolean;
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

function lifecycle(
  events: string[] = [],
  writeApproved?: boolean,
): IntegrationLifecycleContext & { readonly beginCommit: ReturnType<typeof vi.fn> } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    ...(writeApproved === undefined ? {} : { writeApproved }),
    beginCommit: vi.fn(async () => {
      events.push("beginCommit");
      return controller.signal;
    }),
  };
}

function invocation(writeApproved?: boolean): IntegrationInvocationContext {
  return {
    signal: new AbortController().signal,
    ...(writeApproved === undefined ? {} : { writeApproved }),
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function signIdToken(
  nonce: string,
  claims: Readonly<Record<string, unknown>> = {},
  key: NodeCrypto.KeyObject = privateKey,
): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: TEST_KID, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: TEST_CONFIGURATION.clientId,
      azp: TEST_CONFIGURATION.clientId,
      exp: now + 3_600,
      iat: now,
      nonce,
      sub: "google-subject-1",
      email: "fixture-user@ucsd.edu",
      email_verified: true,
      hd: "ucsd.edu",
      ...claims,
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`, "ascii"),
    key,
  );
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

interface OAuthFixtureOptions {
  readonly secrets?: ReturnType<typeof memorySecrets>;
  readonly tokenStatus?: number;
  readonly tokenOverrides?: Readonly<Record<string, unknown>>;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly signingKey?: NodeCrypto.KeyObject;
  readonly refreshOverrides?: Readonly<Record<string, unknown>>;
  /** Replaces the refresh response for the given 1-based refresh attempt. */
  readonly refreshFailure?: (attempt: number) => Promise<Response> | undefined;
  readonly revokeStatus?: number;
  readonly api?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  readonly requestTimeoutMs?: number;
  readonly beforeAuthorizationCodeTokenResponse?: () => Promise<void>;
}

function oauthFixture(options: OAuthFixtureOptions = {}) {
  const secrets = options.secrets ?? memorySecrets();
  const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  let nonce = "";
  let scopes = "";
  let refreshCount = 0;
  let omitAuthorizationRefreshToken = false;
  const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return jsonResponse({
        keys: [
          {
            ...publicJwk,
            kid: TEST_KID,
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") {
        refreshCount += 1;
        const failure = options.refreshFailure?.(refreshCount);
        if (failure) return failure;
        return jsonResponse({
          access_token: `fixture-access-refresh-${refreshCount}`,
          expires_in: 3_600,
          scope: scopes,
          refresh_token: `fixture-refresh-rotated-${refreshCount}`,
          ...options.refreshOverrides,
        });
      }
      await options.beforeAuthorizationCodeTokenResponse?.();
      return jsonResponse(
        {
          access_token: "fixture-access-initial",
          ...(omitAuthorizationRefreshToken ? {} : { refresh_token: "fixture-refresh-initial" }),
          expires_in: 3_600,
          scope: scopes,
          id_token: signIdToken(nonce, options.claims, options.signingKey),
          ...options.tokenOverrides,
        },
        options.tokenStatus ?? 200,
      );
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      return new Response("", { status: options.revokeStatus ?? 200 });
    }
    if (options.api) return options.api(url, init);
    return jsonResponse({ error: { message: "unexpected fixture request" } }, 500);
  }) as typeof fetch;
  const provider = new GoogleWorkspaceProvider(
    secrets.service,
    TEST_CONFIGURATION,
    fetchImplementation,
    options.requestTimeoutMs,
  );

  async function begin(
    capabilities: ReadonlyArray<string> = ["identity.read", "mail.read"],
    context = lifecycle(),
  ) {
    const flow = await provider.connect(capabilities, context);
    if (flow.kind !== "authorization_url") throw new Error("Expected authorization URL flow.");
    const authorizationUrl = new URL(flow.authorizationUrl);
    nonce = authorizationUrl.searchParams.get("nonce") ?? "";
    scopes = authorizationUrl.searchParams.get("scope") ?? "";
    return { flow, authorizationUrl };
  }

  async function complete(
    capabilities: ReadonlyArray<string> = ["identity.read", "mail.read"],
    context = lifecycle(),
  ) {
    const started = await begin(capabilities, context);
    const callback = new URL(started.authorizationUrl.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", started.authorizationUrl.searchParams.get("state")!);
    callback.searchParams.set("iss", "https://accounts.google.com");
    callback.searchParams.set("code", "fixture-authorization-code");
    const callbackResponse = await globalThis.fetch(callback);
    expect(callbackResponse.status).toBe(200);
    const result = await provider.poll(started.flow.flowId, context);
    expect(result.state).toBe("connected");
    return { ...started, result };
  }

  const omitRefreshTokenOnAuthorization = () => {
    omitAuthorizationRefreshToken = true;
  };

  return { provider, secrets, calls, begin, complete, omitRefreshTokenOnAuthorization };
}

function callbackUrl(authorizationUrl: URL, values: Record<string, string>): URL {
  const url = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
  url.searchParams.set("iss", "https://accounts.google.com");
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  return url;
}

async function requestWithHost(url: URL, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { host },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

describe("GoogleWorkspaceProvider authorization", () => {
  it("requires deployment-injected desktop client credentials and a bounded timeout", () => {
    const secrets = memorySecrets();
    expect(
      () =>
        new GoogleWorkspaceProvider(secrets.service, {
          clientId: "not-a-google-client",
          clientSecret: TEST_CONFIGURATION.clientSecret,
        }),
    ).toThrow(/desktop OAuth client ID/u);
    expect(
      () =>
        new GoogleWorkspaceProvider(secrets.service, {
          clientId: TEST_CONFIGURATION.clientId,
          clientSecret: "invalid secret",
        }),
    ).toThrow(/desktop OAuth client credential/u);
    expect(
      () =>
        new GoogleWorkspaceProvider(secrets.service, TEST_CONFIGURATION, globalThis.fetch, 30_001),
    ).toThrow(/bounded/u);
  });

  it("publishes exact executable schemas and truthful effect metadata", async () => {
    expect(GOOGLE_WORKSPACE_TOOLS).toHaveLength(38);
    const names = new Set<string>();
    for (const tool of GOOGLE_WORKSPACE_TOOLS) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(Schema.toJsonSchemaDocument(tool.input).schema).toMatchObject({ type: "object" });
      expect(tool.openWorld).toBe(true);
      expect(tool.readOnly).toBe(
        !/\.(?:create|update|append|replace|insert|move|trash|restore|delete)$/u.test(tool.name),
      );
    }
    await expect(
      Schema.decodeUnknownPromise(GOOGLE_WORKSPACE_TOOLS[1]!.input)(
        { text: "budget", extra: true },
        { onExcessProperty: "error" },
      ),
    ).rejects.toBeDefined();
  });

  it("starts a system-browser loopback flow with state, nonce, and PKCE without exposing credentials", async () => {
    const fixture = oauthFixture();
    try {
      const { flow, authorizationUrl } = await fixture.begin([
        "identity.read",
        "drive.read",
        "mail.read",
        "mail.draft.create",
        "calendar.read",
        "calendar.write",
      ]);
      expect(flow).toMatchObject({
        kind: "authorization_url",
        intervalSeconds: 2,
      });
      expect(authorizationUrl.origin).toBe("https://accounts.google.com");
      expect(authorizationUrl.pathname).toBe("/o/oauth2/v2/auth");
      expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizationUrl.searchParams.get("hd")).toBe("ucsd.edu");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
      expect(authorizationUrl.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
      expect(authorizationUrl.searchParams.get("client_secret")).toBeNull();
      const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
      expect(redirect.protocol).toBe("http:");
      expect(redirect.hostname).toBe("127.0.0.1");
      expect(redirect.pathname).toBe("/oauth2/callback");
      const scopes = new Set(authorizationUrl.searchParams.get("scope")?.split(" "));
      expect(scopes).toEqual(
        new Set([
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/documents.readonly",
          "https://www.googleapis.com/auth/spreadsheets.readonly",
          "https://www.googleapis.com/auth/presentations.readonly",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          "https://www.googleapis.com/auth/calendar.events.readonly",
          "https://www.googleapis.com/auth/calendar.events",
        ]),
      );
    } finally {
      await fixture.provider.close();
    }
  });

  it("rejects undeclared, prototype-like, duplicate, empty capabilities and API-key submissions", async () => {
    const fixture = oauthFixture();
    try {
      for (const capabilities of [
        [],
        ["drive.admin"],
        ["constructor"],
        ["__proto__"],
        ["mail.read", "mail.read"],
      ]) {
        await expect(fixture.provider.connect(capabilities, lifecycle())).rejects.toThrow(
          /Unsupported/u,
        );
      }
      await expect(
        fixture.provider.connect(["mail.read"], lifecycle(), {
          kind: "api_key",
          flowId: "flow",
          value: "token",
        }),
      ).rejects.toThrow(/rejects credential submissions/u);
    } finally {
      await fixture.provider.close();
    }
  });

  it("keeps an invalid state, callback path, or Host from consuming the flow", async () => {
    const fixture = oauthFixture();
    try {
      const { flow, authorizationUrl } = await fixture.begin();
      const state = authorizationUrl.searchParams.get("state")!;
      const wrongState = callbackUrl(authorizationUrl, {
        state: `${state}x`,
        code: "hostile-code",
      });
      expect((await globalThis.fetch(wrongState)).status).toBe(400);

      const wrongPath = callbackUrl(authorizationUrl, {
        state,
        code: "hostile-code",
      });
      wrongPath.pathname = "/wrong";
      expect((await globalThis.fetch(wrongPath)).status).toBe(400);

      const duplicate = callbackUrl(authorizationUrl, { state, code: "hostile-code" });
      duplicate.searchParams.append("state", state);
      expect((await globalThis.fetch(duplicate)).status).toBe(400);
      const unknown = callbackUrl(authorizationUrl, { state, code: "hostile-code" });
      unknown.searchParams.set("redirect", "https://example.invalid");
      expect((await globalThis.fetch(unknown)).status).toBe(400);
      const wrongIssuer = callbackUrl(authorizationUrl, {
        state,
        iss: "https://accounts.example.invalid",
        code: "hostile-code",
      });
      expect((await globalThis.fetch(wrongIssuer)).status).toBe(400);
      const missingIssuer = callbackUrl(authorizationUrl, {
        state,
        code: "hostile-code",
      });
      missingIssuer.searchParams.delete("iss");
      expect((await globalThis.fetch(missingIssuer)).status).toBe(400);

      const correct = callbackUrl(authorizationUrl, {
        state,
        code: "fixture-code",
      });
      expect(await requestWithHost(correct, "example.invalid")).toBe(400);
      await expect(fixture.provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
        state: "pending",
      });
      const response = await globalThis.fetch(correct);
      expect(await response.text()).not.toContain("fixture-code");
      await expect(fixture.provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
        state: "connected",
      });
    } finally {
      await fixture.provider.close();
    }
  });

  it("sends the exact PKCE verifier and managed desktop credential only at token exchange", async () => {
    const fixture = oauthFixture();
    try {
      const { authorizationUrl } = await fixture.complete();
      const tokenCall = fixture.calls.find(
        ({ url }) => url === "https://oauth2.googleapis.com/token",
      );
      const form = new URLSearchParams(String(tokenCall?.init?.body));
      const verifier = form.get("code_verifier")!;
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{80,128}$/u);
      expect(NodeCrypto.createHash("sha256").update(verifier, "ascii").digest("base64url")).toBe(
        authorizationUrl.searchParams.get("code_challenge"),
      );
      expect(form.get("client_secret")).toBe(TEST_CONFIGURATION.clientSecret);
      expect(form.get("redirect_uri")).toBe(authorizationUrl.searchParams.get("redirect_uri"));
      expect(authorizationUrl.toString()).not.toContain(TEST_CONFIGURATION.clientSecret);
    } finally {
      await fixture.provider.close();
    }
  });

  it("finishes credential commit while the callback client still holds its response socket", async () => {
    const fixture = oauthFixture();
    try {
      const { flow, authorizationUrl } = await fixture.begin();
      const callback = callbackUrl(authorizationUrl, {
        state: authorizationUrl.searchParams.get("state")!,
        code: "fixture-authorization-code",
      });
      const callbackResponse = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
        const request = NodeHttp.request(callback, resolve);
        request.once("error", reject);
        request.end();
      });
      callbackResponse.pause();

      await expect(fixture.provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
        state: "connected",
      });
      callbackResponse.destroy();
    } finally {
      await fixture.provider.close();
    }
  });

  it("stores only the refresh credential after commit admission and exposes verified identity", async () => {
    const events: string[] = [];
    const fixture = oauthFixture();
    const context = lifecycle(events);
    try {
      await fixture.complete(["identity.read", "mail.read"], context);
      expect(context.beginCommit).toHaveBeenCalledOnce();
      expect(events).toEqual(["beginCommit"]);
      expect([...fixture.secrets.values.keys()]).toEqual([GOOGLE_WORKSPACE_SECRET_SUFFIX]);
      const persisted = decoder.decode(fixture.secrets.values.get(GOOGLE_WORKSPACE_SECRET_SUFFIX));
      expect(persisted).toContain("fixture-refresh-initial");
      expect(persisted).not.toContain("fixture-access-initial");
      expect(persisted).not.toContain("fixture-authorization-code");
      expect(await fixture.provider.status()).toMatchObject({
        state: "connected",
        accountLabel: "fixture-user@ucsd.edu",
        grantedCapabilities: ["identity.read", "mail.read"],
      });
      await expect(
        fixture.provider.invoke("googleworkspace.identity.get", {}, invocation()),
      ).resolves.toEqual({
        subject: "google-subject-1",
        email: "fixture-user@ucsd.edu",
        hostedDomain: "ucsd.edu",
      });
    } finally {
      await fixture.provider.close();
    }
  });

  it("requires Harness commit admission before token exchange, refresh, and disconnect", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = oauthFixture();
    const missingCommit = {
      signal: new AbortController().signal,
    } as IntegrationLifecycleContext;
    try {
      const { flow, authorizationUrl } = await fixture.begin();
      await globalThis.fetch(
        callbackUrl(authorizationUrl, {
          state: authorizationUrl.searchParams.get("state")!,
          code: "fixture-code",
        }),
      );
      await expect(fixture.provider.poll(flow.flowId, missingCommit)).rejects.toThrow(
        /commit admission/u,
      );
      expect(
        fixture.calls.filter(({ url }) => url === "https://oauth2.googleapis.com/token"),
      ).toHaveLength(0);
      await expect(fixture.provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
        state: "connected",
      });

      vi.setSystemTime(Date.now() + 3_700_000);
      await expect(fixture.provider.prepare(missingCommit)).rejects.toThrow(/commit admission/u);
      await fixture.provider.prepare(lifecycle());
      await expect(fixture.provider.disconnect(missingCommit)).rejects.toThrow(/commit admission/u);
      expect(fixture.secrets.values.has(GOOGLE_WORKSPACE_SECRET_SUFFIX)).toBe(true);
      await fixture.provider.disconnect(lifecycle());
    } finally {
      vi.useRealTimers();
      await fixture.provider.close();
    }
  });

  it("ignores additive Google scopes without broadening provider capabilities", async () => {
    const fixture = oauthFixture({
      tokenOverrides: {
        scope:
          "openid email profile https://www.googleapis.com/auth/gmail.readonly " +
          "https://www.googleapis.com/auth/contacts.readonly " +
          "https://www.googleapis.com/auth/admin.directory.user.readonly",
      },
    });
    try {
      await fixture.complete(["identity.read", "mail.read"]);
      await expect(fixture.provider.status()).resolves.toMatchObject({
        grantedCapabilities: ["identity.read", "mail.read"],
      });
      const persisted = decoder.decode(fixture.secrets.values.get(GOOGLE_WORKSPACE_SECRET_SUFFIX));
      expect(persisted).not.toContain("contacts");
      expect(persisted).not.toContain("admin.directory");
      await expect(
        fixture.provider.invoke(
          "googleworkspace.mail.draft.create",
          {
            to: ["person@ucsd.edu"],
            subject: "Denied",
            body: "This must not be created.",
          },
          invocation(true),
        ),
      ).rejects.toThrow(/not granted/u);
    } finally {
      await fixture.provider.close();
    }
  });

  it("binds incremental authorization to the already connected Google subject", async () => {
    const claims: Record<string, unknown> = {};
    const fixture = oauthFixture({ claims });
    try {
      await fixture.complete(["identity.read", "mail.read"]);
      claims.sub = "different-google-subject";
      claims.email = "other-user@ucsd.edu";
      const { flow, authorizationUrl } = await fixture.begin([
        "identity.read",
        "mail.read",
        "calendar.read",
      ]);
      expect(authorizationUrl.searchParams.get("login_hint")).toBe("fixture-user@ucsd.edu");
      await globalThis.fetch(
        callbackUrl(authorizationUrl, {
          state: authorizationUrl.searchParams.get("state")!,
          code: "different-account-code",
        }),
      );
      await expect(fixture.provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
        state: "failed",
      });
      await expect(fixture.provider.status()).resolves.toMatchObject({
        state: "connected",
        accountLabel: "fixture-user@ucsd.edu",
        grantedCapabilities: ["identity.read", "mail.read"],
      });
    } finally {
      await fixture.provider.close();
    }
  });

  it("rejects invalid signature, nonce, hosted domain, unverified email, and changed subject", async () => {
    const other = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2_048 }).privateKey;
    const cases: ReadonlyArray<OAuthFixtureOptions> = [
      { signingKey: other },
      { claims: { nonce: "wrong-nonce" } },
      { claims: { hd: "example.edu", email: "person@example.edu" } },
      { claims: { email_verified: false } },
    ];
    for (const options of cases) {
      const fixture = oauthFixture(options);
      try {
        const { flow, authorizationUrl } = await fixture.begin();
        const callback = callbackUrl(authorizationUrl, {
          state: authorizationUrl.searchParams.get("state")!,
          code: "fixture-code",
        });
        await globalThis.fetch(callback);
        await expect(fixture.provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
          state: "failed",
          message: expect.stringContaining("authorized UC San Diego"),
        });
        expect(
          fixture.calls.some(({ url }) => url === "https://oauth2.googleapis.com/revoke"),
        ).toBe(true);
        expect(fixture.secrets.values.size).toBe(0);
      } finally {
        await fixture.provider.close();
      }
    }
  });

  it("expires flows without callbacks and supersedes concurrent flows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = oauthFixture();
    try {
      const older = await fixture.begin();
      const newer = await fixture.begin(["identity.read", "calendar.read"]);
      await expect(fixture.provider.poll(older.flow.flowId, lifecycle())).rejects.toThrow(
        /not found/u,
      );
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await expect(fixture.provider.poll(newer.flow.flowId, lifecycle())).resolves.toMatchObject({
        state: "expired",
      });
    } finally {
      vi.useRealTimers();
      await fixture.provider.close();
    }
  });

  it("claims a captured OAuth callback after the flow deadline and status pruning", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = oauthFixture();
    try {
      const { flow, authorizationUrl } = await fixture.begin();
      vi.setSystemTime(Date.now() + 299_000);
      const callback = callbackUrl(authorizationUrl, {
        state: authorizationUrl.searchParams.get("state")!,
        code: "fixture-code",
      });
      expect((await globalThis.fetch(callback)).status).toBe(200);
      await expect(globalThis.fetch(callback)).rejects.toBeDefined();

      vi.setSystemTime(Date.now() + 2_000);
      await expect(fixture.provider.status()).resolves.toMatchObject({ state: "connecting" });
      await expect(fixture.provider.poll(flow.flowId, lifecycle())).resolves.toMatchObject({
        state: "connected",
      });
    } finally {
      vi.useRealTimers();
      await fixture.provider.close();
    }
  });

  it("expires a captured OAuth callback when its bounded claim window is not used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = oauthFixture();
    try {
      const { flow, authorizationUrl } = await fixture.begin();
      const callback = callbackUrl(authorizationUrl, {
        state: authorizationUrl.searchParams.get("state")!,
        code: "fixture-code",
      });
      expect((await globalThis.fetch(callback)).status).toBe(200);

      vi.setSystemTime(Date.now() + 61_000);
      await expect(fixture.provider.status()).resolves.toMatchObject({ state: "not_connected" });
      await expect(fixture.provider.poll(flow.flowId, lifecycle())).rejects.toThrow(/not found/u);
    } finally {
      vi.useRealTimers();
      await fixture.provider.close();
    }
  });

  it("finishes an admitted token exchange when the flow deadline passes in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const fixture = oauthFixture({
      beforeAuthorizationCodeTokenResponse: () => tokenGate,
    });
    try {
      const { flow, authorizationUrl } = await fixture.begin();
      const callback = callbackUrl(authorizationUrl, {
        state: authorizationUrl.searchParams.get("state")!,
        code: "fixture-code",
      });
      expect((await globalThis.fetch(callback)).status).toBe(200);
      const result = fixture.provider.poll(flow.flowId, lifecycle());
      await vi.waitFor(() =>
        expect(fixture.calls.some(({ url }) => url === "https://oauth2.googleapis.com/token")).toBe(
          true,
        ),
      );
      vi.setSystemTime(Date.now() + 6 * 60_000);
      releaseToken();
      await expect(result).resolves.toMatchObject({ state: "connected" });
    } finally {
      releaseToken();
      vi.useRealTimers();
      await fixture.provider.close();
    }
  });

  it("supersedes an incremental flow when a later request is already authorized", async () => {
    const fixture = oauthFixture();
    try {
      await fixture.complete(["identity.read", "mail.read"]);
      const pending = await fixture.begin(["identity.read", "calendar.read"]);
      await expect(
        fixture.provider.connect(["identity.read", "mail.read"], lifecycle()),
      ).resolves.toMatchObject({ kind: "connected" });
      await expect(
        globalThis.fetch(
          callbackUrl(pending.authorizationUrl, {
            state: pending.authorizationUrl.searchParams.get("state")!,
            code: "late-incremental-code",
          }),
        ),
      ).rejects.toBeDefined();
      await expect(fixture.provider.poll(pending.flow.flowId, lifecycle())).rejects.toThrow(
        /not found/u,
      );
    } finally {
      await fixture.provider.close();
    }
  });

  it("rotates refresh credentials, revokes on disconnect, and cleans up listeners on close", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = oauthFixture();
    try {
      await fixture.complete(["identity.read", "calendar.read"]);
      vi.setSystemTime(Date.now() + 3_700_000);
      await fixture.provider.prepare(lifecycle());
      const refreshCall = fixture.calls
        .filter(({ url }) => url === "https://oauth2.googleapis.com/token")
        .find(({ init }) => {
          const form = new URLSearchParams(String(init?.body));
          return form.get("grant_type") === "refresh_token";
        });
      expect(new URLSearchParams(String(refreshCall?.init?.body)).get("client_secret")).toBe(
        TEST_CONFIGURATION.clientSecret,
      );
      const persisted = decoder.decode(fixture.secrets.values.get(GOOGLE_WORKSPACE_SECRET_SUFFIX));
      expect(persisted).toContain("fixture-refresh-rotated-1");
      await fixture.provider.disconnect(lifecycle());
      expect(fixture.secrets.values.size).toBe(0);
      const revokeCall = fixture.calls.find(
        ({ url }) => url === "https://oauth2.googleapis.com/revoke",
      );
      expect(String(revokeCall?.init?.body)).toContain("fixture-refresh-rotated-1");

      const pending = await fixture.begin();
      await fixture.provider.close();
      const callback = callbackUrl(pending.authorizationUrl, {
        state: pending.authorizationUrl.searchParams.get("state")!,
        code: "late-code",
      });
      await expect(globalThis.fetch(callback)).rejects.toBeDefined();
    } finally {
      vi.useRealTimers();
      await fixture.provider.close();
    }
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "a server error",
      () => Promise.resolve(jsonResponse({ error: "temporarily_unavailable" }, 503)),
    ],
    [
      "a non-JSON gateway error",
      () =>
        Promise.resolve(
          new Response("bad gateway", { status: 502, headers: { "content-type": "text/html" } }),
        ),
    ],
  ] as const)("keeps the connection after a refresh fails with %s", async (_label, failure) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = oauthFixture({
      refreshFailure: (attempt) => (attempt === 1 ? failure() : undefined),
    });
    try {
      await fixture.complete(["identity.read", "mail.read"]);
      const stored = fixture.secrets.values.get(GOOGLE_WORKSPACE_SECRET_SUFFIX);
      vi.setSystemTime(Date.now() + 3_700_000);
      const events: string[] = [];

      await expect(fixture.provider.prepare(lifecycle(events))).rejects.toThrow();
      // Harness faults a provider whose admitted operation rejects, so a failed request must
      // never have asked for commit admission.
      expect(events).toEqual([]);
      expect(fixture.secrets.values.get(GOOGLE_WORKSPACE_SECRET_SUFFIX)).toEqual(stored);
      await expect(fixture.provider.status()).resolves.toMatchObject({ state: "connected" });

      await fixture.provider.prepare(lifecycle());
      await expect(
        fixture.provider.invoke("googleworkspace.identity.get", {}, invocation()),
      ).resolves.toMatchObject({ email: "fixture-user@ucsd.edu" });
    } finally {
      vi.useRealTimers();
      await fixture.provider.close();
    }
  });

  it("keeps using a refreshed token when saving the rotated credential fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const secretOptions: { failSet?: boolean } = {};
    const fixture = oauthFixture({ secrets: memorySecrets(secretOptions) });
    try {
      await fixture.complete(["identity.read", "mail.read"]);
      vi.setSystemTime(Date.now() + 3_700_000);
      secretOptions.failSet = true;

      await fixture.provider.prepare(lifecycle());
      await expect(fixture.provider.status()).resolves.toMatchObject({
        state: "connected",
        message: expect.stringMatching(/could not be saved/u),
      });
      await expect(
        fixture.provider.invoke("googleworkspace.identity.get", {}, invocation()),
      ).resolves.toMatchObject({ email: "fixture-user@ucsd.edu" });
    } finally {
      vi.useRealTimers();
      await fixture.provider.close();
    }
  });

  it("reports an expired sign-in when Google answers invalid_grant until reconnect", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = oauthFixture({
      refreshFailure: () => Promise.resolve(jsonResponse({ error: "invalid_grant" }, 400)),
    });
    try {
      await fixture.complete(["identity.read", "mail.read"]);
      vi.setSystemTime(Date.now() + 3_700_000);
      const events: string[] = [];

      await expect(fixture.provider.prepare(lifecycle(events))).rejects.toThrow(/sign-in expired/u);
      expect(events).toEqual([]);
      await expect(fixture.provider.status()).resolves.toMatchObject({
        state: "error",
        grantedCapabilities: [],
        message: expect.stringMatching(/sign-in expired/u),
      });
      // Reconnecting must start a fresh sign-in even though the scopes are still on record.
      await expect(
        fixture.provider.connect(["identity.read", "mail.read"], lifecycle()),
      ).resolves.toMatchObject({ kind: "authorization_url" });
      // A sign-in that returns no new refresh token cannot fall back to the rejected one.
      fixture.omitRefreshTokenOnAuthorization();
      const retry = await fixture.begin(["identity.read", "mail.read"]);
      await globalThis.fetch(
        callbackUrl(retry.authorizationUrl, {
          state: retry.authorizationUrl.searchParams.get("state")!,
          code: "fixture-code",
        }),
      );
      await expect(fixture.provider.poll(retry.flow.flowId, lifecycle())).resolves.toMatchObject({
        state: "failed",
      });
      await expect(fixture.provider.status()).resolves.toMatchObject({ state: "error" });

      await fixture.provider.disconnect(lifecycle());
      await expect(fixture.provider.status()).resolves.toMatchObject({ state: "not_connected" });
    } finally {
      vi.useRealTimers();
      await fixture.provider.close();
    }
  });

  it("faults uncertain after an admitted token-store failure and requires reset", async () => {
    const secrets = memorySecrets({ failSetAfterWrite: true });
    const fixture = oauthFixture({ secrets });
    try {
      const { flow, authorizationUrl } = await fixture.begin();
      const callback = callbackUrl(authorizationUrl, {
        state: authorizationUrl.searchParams.get("state")!,
        code: "fixture-code",
      });
      await globalThis.fetch(callback);
      await expect(fixture.provider.poll(flow.flowId, lifecycle())).rejects.toThrow(
        /uncertain set/u,
      );
      await expect(fixture.provider.status()).resolves.toMatchObject({
        state: "error",
        message: expect.stringContaining("uncertain"),
      });
      await expect(fixture.provider.connect(["mail.read"], lifecycle())).rejects.toThrow(
        /uncertain/u,
      );
    } finally {
      await fixture.provider.close();
    }
  });

  it("keeps the local credential and faults closed when revocation or removal is uncertain", async () => {
    const revokeFailure = oauthFixture({ revokeStatus: 500 });
    try {
      await revokeFailure.complete(["identity.read", "mail.read"]);
      await expect(revokeFailure.provider.disconnect(lifecycle())).rejects.toThrow(
        /could not revoke/u,
      );
      expect(revokeFailure.secrets.values.has(GOOGLE_WORKSPACE_SECRET_SUFFIX)).toBe(true);
      await expect(revokeFailure.provider.status()).resolves.toMatchObject({
        state: "error",
        message: expect.stringContaining("uncertain"),
      });
    } finally {
      await revokeFailure.provider.close();
    }

    const secrets = memorySecrets({ failRemove: true });
    const removeFailure = oauthFixture({ secrets });
    try {
      await removeFailure.complete(["identity.read", "mail.read"]);
      await expect(removeFailure.provider.disconnect(lifecycle())).rejects.toThrow(
        /fixture remove failure/u,
      );
      expect(removeFailure.secrets.values.has(GOOGLE_WORKSPACE_SECRET_SUFFIX)).toBe(true);
      await expect(removeFailure.provider.status()).resolves.toMatchObject({ state: "error" });
    } finally {
      await removeFailure.provider.close();
    }
  });

  it("sanitizes token and callback errors without leaking remote descriptions or codes", async () => {
    const secretMarker = "do-not-leak-refresh-token";
    const fixture = oauthFixture({
      tokenStatus: 400,
      tokenOverrides: {
        error: "access_denied",
        error_description: secretMarker,
      },
    });
    try {
      const { flow, authorizationUrl } = await fixture.begin();
      const callback = callbackUrl(authorizationUrl, {
        state: authorizationUrl.searchParams.get("state")!,
        code: "do-not-leak-code",
      });
      await globalThis.fetch(callback);
      const result = await fixture.provider.poll(flow.flowId, lifecycle());
      expect(result).toEqual({
        state: "failed",
        retryAfterSeconds: null,
        message: "Google Workspace sign-in failed. Start again.",
      });
      expect(JSON.stringify(result)).not.toContain(secretMarker);
      expect(JSON.stringify(result)).not.toContain("do-not-leak-code");
      expect(JSON.stringify(result)).not.toContain(TEST_CONFIGURATION.clientSecret);
    } finally {
      await fixture.provider.close();
    }
  });
});

describe("GoogleWorkspaceProvider fixed tools", () => {
  it("binds opaque Drive and Gmail cursors to tool, query, and account", async () => {
    let page = 0;
    const fixture = oauthFixture({
      api: (url) => {
        if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
          page += 1;
          return jsonResponse({
            files: [
              {
                id: `file-${page}`,
                name: "Budget",
                mimeType: "application/pdf",
                modifiedTime: "2026-07-20T00:00:00Z",
              },
            ],
            ...(page === 1 ? { nextPageToken: "raw-drive-page-token" } : {}),
          });
        }
        return jsonResponse({ messages: [], nextPageToken: "raw-gmail-page-token" });
      },
    });
    try {
      await fixture.complete(["identity.read", "drive.read", "mail.read"]);
      const first = (await fixture.provider.invoke(
        "googleworkspace.drive.search",
        { text: "Budget", limit: 1 },
        invocation(),
      )) as { readonly cursor: string; readonly files: ReadonlyArray<unknown> };
      expect(first.cursor).not.toContain("raw-drive-page-token");
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.search",
          { text: "Budget", limit: 1, cursor: first.cursor },
          invocation(),
        ),
      ).resolves.toMatchObject({ files: [{ id: "file-2" }] });
      const secondUrl = fixture.calls.at(-1)?.url ?? "";
      expect(secondUrl).toContain("pageToken=raw-drive-page-token");
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.search",
          { text: "Different", limit: 1, cursor: first.cursor },
          invocation(),
        ),
      ).rejects.toThrow(/another request/u);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.mail.search",
          { text: "Budget", limit: 1, cursor: first.cursor },
          invocation(),
        ),
      ).rejects.toThrow(/another request/u);
    } finally {
      await fixture.provider.close();
    }
  });

  it("uses fixed encoded resource paths and never returns raw continuation URLs", async () => {
    const urls: string[] = [];
    const fixture = oauthFixture({
      api: (url) => {
        urls.push(url);
        if (url.includes("/drive/v3/files/")) {
          return jsonResponse({
            id: "file-1",
            name: "Review",
            mimeType: "application/pdf",
            parents: [],
          });
        }
        if (url.includes("/gmail/v1/users/me/messages/")) {
          return jsonResponse({
            id: "message-1",
            threadId: "thread-1",
            labelIds: ["INBOX"],
            snippet: "Review",
            internalDate: "1784563200000",
            payload: {
              mimeType: "text/plain",
              headers: [{ name: "Subject", value: "Review" }],
              body: { data: Buffer.from("Complete body").toString("base64url"), size: 13 },
            },
          });
        }
        return jsonResponse({ error: true }, 500);
      },
    });
    try {
      await fixture.complete(["identity.read", "drive.read", "mail.read"]);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.get",
          { itemId: "file_id-safe" },
          invocation(),
        ),
      ).resolves.toMatchObject({ id: "file-1", name: "Review" });
      await expect(
        fixture.provider.invoke(
          "googleworkspace.mail.message.get",
          { messageId: "message_id-safe" },
          invocation(),
        ),
      ).resolves.toMatchObject({
        id: "message-1",
        headers: { subject: "Review" },
        body: { text: "Complete body" },
      });
      expect(urls[0]).toContain("/drive/v3/files/file_id-safe?");
      expect(urls[1]).toContain("/gmail/v1/users/me/messages/message_id-safe?");
      expect(urls.every((url) => !url.includes("access_token"))).toBe(true);
    } finally {
      await fixture.provider.close();
    }
  });

  it("decodes bounded Gmail text using the declared MIME charset", async () => {
    const fixture = oauthFixture({
      api: (url) => {
        if (!url.includes("/gmail/v1/users/me/messages/")) {
          return jsonResponse({ error: true }, 500);
        }
        return jsonResponse({
          id: "message-latin1",
          threadId: "thread-latin1",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "Subject", value: "Charset" },
              { name: "Content-Type", value: "text/plain; charset=iso-8859-1" },
            ],
            body: { data: Buffer.from([0x4f, 0x6c, 0xe1]).toString("base64url"), size: 3 },
          },
        });
      },
    });
    try {
      await fixture.complete(["identity.read", "mail.read"]);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.mail.message.get",
          { messageId: "message-latin1" },
          invocation(),
        ),
      ).resolves.toMatchObject({ body: { text: "Olá" } });
    } finally {
      await fixture.provider.close();
    }
  });

  it("falls back to lenient UTF-8 for unknown-8bit Gmail text but rejects malformed base64", async () => {
    const fixture = oauthFixture({
      api: (url) => {
        if (!url.includes("/gmail/v1/users/me/messages/")) {
          return jsonResponse({ error: true }, 500);
        }
        const malformed = url.includes("/messages/message-malformed");
        return jsonResponse({
          id: malformed ? "message-malformed" : "message-unknown-8bit",
          threadId: "thread-charset",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "Subject", value: "Charset" },
              { name: "Content-Type", value: "text/plain; charset=unknown-8bit" },
            ],
            body: {
              data: malformed ? "%%%not-base64%%%" : Buffer.from("Olá").toString("base64url"),
              size: malformed ? 16 : 4,
            },
          },
        });
      },
    });
    try {
      await fixture.complete(["identity.read", "mail.read"]);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.mail.message.get",
          { messageId: "message-unknown-8bit" },
          invocation(),
        ),
      ).resolves.toMatchObject({ body: { text: "Olá" } });
      await expect(
        fixture.provider.invoke(
          "googleworkspace.mail.message.get",
          { messageId: "message-malformed" },
          invocation(),
        ),
      ).rejects.toThrow(/Gmail body data is invalid/u);
    } finally {
      await fixture.provider.close();
    }
  });

  it("creates only an unsent plain-text Gmail draft after invocation-time approval", async () => {
    const apiCalls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const events: string[] = [];
    const fixture = oauthFixture({
      api: (url, init) => {
        events.push("api");
        apiCalls.push({ url, init });
        return jsonResponse(
          { id: "draft-1", message: { id: "message-1", threadId: "thread-1" } },
          200,
        );
      },
    });
    try {
      await fixture.complete(["identity.read", "mail.draft.create"]);
      const input = {
        to: ["person@ucsd.edu"],
        subject: "Review",
        body: "Please review this draft.",
      };
      await expect(
        fixture.provider.invoke("googleworkspace.mail.draft.create", input, invocation(false)),
      ).rejects.toThrow(/requires task access approval/u);
      expect(apiCalls).toHaveLength(0);
      await expect(
        fixture.provider.invoke("googleworkspace.mail.draft.create", input, invocation(true)),
      ).rejects.toThrow(/commit admission/u);
      expect(apiCalls).toHaveLength(0);
      const context = lifecycle(events, true);
      await expect(
        fixture.provider.invoke("googleworkspace.mail.draft.create", input, context),
      ).resolves.toEqual({
        draftId: "draft-1",
        messageId: "message-1",
        threadId: "thread-1",
        status: "draft-created",
        sent: false,
      });
      expect(events).toEqual(["beginCommit", "api"]);
      expect(context.beginCommit).toHaveBeenCalledOnce();
      expect(apiCalls).toHaveLength(1);
      expect(apiCalls[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
      expect(apiCalls[0]?.init?.method).toBe("POST");
      expect(apiCalls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
      expect(apiCalls[0]?.init?.signal?.aborted).toBe(false);
      const body = JSON.parse(String(apiCalls[0]?.init?.body)) as {
        readonly message: { readonly raw: string };
      };
      const message = Buffer.from(body.message.raw, "base64url").toString("utf8");
      expect(message).toContain("Content-Type: text/plain; charset=UTF-8");
      expect(message).toContain("Please review this draft.");
      expect(apiCalls[0]?.url).not.toContain("send");
    } finally {
      await fixture.provider.close();
    }
  });

  it("creates and patches only narrow Calendar fields with invitations disabled", async () => {
    const apiCalls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const event = {
      id: "event-1",
      status: "confirmed",
      summary: "Planning",
      start: { dateTime: "2026-07-28T16:00:00.000Z" },
      end: { dateTime: "2026-07-28T17:00:00.000Z" },
      organizer: { email: "fixture-user@ucsd.edu", self: true },
      creator: { email: "fixture-user@ucsd.edu", self: true },
    };
    const fixture = oauthFixture({
      api: (url, init) => {
        apiCalls.push({ url, init });
        return jsonResponse(event);
      },
    });
    try {
      await fixture.complete(["identity.read", "calendar.write"]);
      const createContext = lifecycle([], true);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.calendar.event.create",
          {
            summary: "Planning",
            start: "2026-07-28T09:00:00-07:00",
            end: "2026-07-28T10:00:00-07:00",
            description: "Agenda",
          },
          createContext,
        ),
      ).resolves.toEqual({
        status: "event-created",
        calendarId: "primary",
        eventId: "event-1",
      });
      const updateContext = lifecycle([], true);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.calendar.event.update",
          {
            eventId: "event-1",
            summary: "Updated planning",
            location: "Room 1",
          },
          updateContext,
        ),
      ).resolves.toEqual({
        status: "event-updated",
        calendarId: "primary",
        eventId: "event-1",
      });
      expect(createContext.beginCommit).toHaveBeenCalledOnce();
      expect(updateContext.beginCommit).toHaveBeenCalledOnce();
      expect(apiCalls.map(({ init }) => init?.method)).toEqual(["POST", "PATCH"]);
      for (const call of apiCalls) {
        const url = new URL(call.url);
        expect(url.searchParams.get("sendUpdates")).toBe("none");
        expect(url.searchParams.get("conferenceDataVersion")).toBe("0");
        const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty("attendees");
        expect(body).not.toHaveProperty("conferenceData");
        expect(body).not.toHaveProperty("guestsCanInviteOthers");
      }
      await expect(
        fixture.provider.invoke(
          "googleworkspace.calendar.event.update",
          { eventId: "event-1", start: "2026-07-28T09:00:00-07:00" },
          lifecycle([], true),
        ),
      ).rejects.toThrow(/start and end/u);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.calendar.event.update",
          { eventId: "event-1" },
          lifecycle([], true),
        ),
      ).rejects.toThrow(/at least one/u);
    } finally {
      await fixture.provider.close();
    }
  });

  it("writes Drive, Docs, and Sheets only through fixed endpoints after invocation-time approval", async () => {
    const apiCalls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fixture = oauthFixture({
      api: (url, init) => {
        apiCalls.push({ url, init });
        if (url.includes("docs.googleapis.com")) {
          return jsonResponse({
            documentId: "doc-1",
            replies: url.includes("doc-replace")
              ? [{ replaceAllText: { occurrencesChanged: 3 } }]
              : [{}],
          });
        }
        if (url.includes(":append")) {
          return jsonResponse({
            spreadsheetId: "sheet-1",
            tableRange: "Sheet1!A1:B2",
            updates: {
              spreadsheetId: "sheet-1",
              updatedRange: "Sheet1!A3:B3",
              updatedRows: 1,
              updatedColumns: 2,
              updatedCells: 2,
            },
          });
        }
        if (url.includes("sheets.googleapis.com")) {
          return jsonResponse({
            spreadsheetId: "sheet-1",
            updatedRange: "Sheet1!A1:B2",
            updatedRows: 2,
            updatedColumns: 2,
            updatedCells: 4,
          });
        }
        if (url.includes("/files/native-doc?")) {
          return jsonResponse({ mimeType: "application/vnd.google-apps.document" });
        }
        const body =
          typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        return jsonResponse({
          id: "item-1",
          mimeType: typeof body.mimeType === "string" ? body.mimeType : "text/markdown",
        });
      },
    });
    try {
      const { authorizationUrl } = await fixture.complete(["identity.read", "drive.write"]);
      expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toContain(
        "https://www.googleapis.com/auth/drive",
      );

      const folder = { name: "Reports", parentId: "parent-1" };
      await expect(
        fixture.provider.invoke("googleworkspace.drive.folder.create", folder, invocation(false)),
      ).rejects.toThrow(/requires task access approval/u);
      await expect(
        fixture.provider.invoke("googleworkspace.drive.folder.create", folder, invocation(true)),
      ).rejects.toThrow(/commit admission/u);
      expect(apiCalls).toHaveLength(0);

      const events: string[] = [];
      const folderContext = lifecycle(events, true);
      await expect(
        fixture.provider.invoke("googleworkspace.drive.folder.create", folder, folderContext),
      ).resolves.toEqual({
        status: "folder-created",
        itemId: "item-1",
        mimeType: "application/vnd.google-apps.folder",
      });
      expect(events).toEqual(["beginCommit"]);
      expect(apiCalls[0]?.init?.method).toBe("POST");
      expect(new URL(apiCalls[0]!.url).pathname).toBe("/drive/v3/files");
      expect(JSON.parse(String(apiCalls[0]?.init?.body))).toEqual({
        name: "Reports",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["parent-1"],
      });

      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.file.create",
          {
            name: "Notes",
            parentId: "item-1",
            content: "# Notes\n",
            contentType: "text/markdown",
            convertTo: "document",
          },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ status: "file-created", itemId: "item-1" });
      const upload = apiCalls[1]!;
      const uploadUrl = new URL(upload.url);
      expect(uploadUrl.pathname).toBe("/upload/drive/v3/files");
      expect(uploadUrl.searchParams.get("uploadType")).toBe("multipart");
      const uploadType = new Headers(upload.init?.headers).get("content-type") ?? "";
      expect(uploadType).toMatch(/^multipart\/related; boundary=tritonai-/u);
      const multipart = decoder.decode(upload.init?.body as Uint8Array);
      expect(multipart).toContain(
        '{"name":"Notes","parents":["item-1"],"mimeType":"application/vnd.google-apps.document"}',
      );
      expect(multipart).toContain("Content-Type: text/markdown; charset=UTF-8\r\n\r\n# Notes\n");

      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.file.create",
          { name: "Blank", convertTo: "spreadsheet" },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ mimeType: "application/vnd.google-apps.spreadsheet" });
      expect(new URL(apiCalls[2]!.url).pathname).toBe("/drive/v3/files");

      const rejectedCreate = lifecycle([], true);
      for (const input of [
        { name: "Nothing" },
        { name: "Untyped", content: "text" },
        { name: "Bad", content: "%%%", contentEncoding: "base64", contentType: "image/png" },
        { name: "Native", content: "x", contentType: "application/vnd.google-apps.folder" },
      ]) {
        await expect(
          fixture.provider.invoke("googleworkspace.drive.file.create", input, rejectedCreate),
        ).rejects.toThrow(IntegrationProviderPublicError);
      }
      expect(rejectedCreate.beginCommit).not.toHaveBeenCalled();

      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.file.update",
          {
            itemId: "file/../escape",
            content: png.toString("base64"),
            contentEncoding: "base64",
            contentType: "image/png",
          },
          lifecycle([], true),
        ),
      ).rejects.toBeDefined();
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.file.update",
          {
            itemId: "file-1",
            content: png.toString("base64"),
            contentEncoding: "base64",
            contentType: "image/png",
          },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ status: "file-updated", itemId: "item-1" });
      expect(apiCalls[3]?.init?.method).toBe("GET");
      const media = apiCalls[4]!;
      expect(media.init?.method).toBe("PATCH");
      expect(new URL(media.url).pathname).toBe("/upload/drive/v3/files/file-1");
      expect(new URL(media.url).searchParams.get("uploadType")).toBe("media");
      expect(new Headers(media.init?.headers).get("content-type")).toBe("image/png");
      expect(Buffer.from(media.init?.body as Uint8Array)).toEqual(png);

      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.update",
          { itemId: "file-1" },
          lifecycle([], true),
        ),
      ).rejects.toThrow(/name or description/u);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.update",
          { itemId: "file-1", name: "Renamed" },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ status: "item-updated" });
      expect(apiCalls[5]?.init?.method).toBe("PATCH");
      expect(JSON.parse(String(apiCalls[5]?.init?.body))).toEqual({ name: "Renamed" });

      await expect(
        fixture.provider.invoke(
          "googleworkspace.docs.text.append",
          { documentId: "doc-append", text: "Next steps" },
          lifecycle([], true),
        ),
      ).resolves.toEqual({ status: "text-appended", documentId: "doc-1" });
      expect(apiCalls[6]?.url).toBe(
        "https://docs.googleapis.com/v1/documents/doc-append:batchUpdate",
      );
      expect(JSON.parse(String(apiCalls[6]?.init?.body))).toEqual({
        requests: [{ insertText: { endOfSegmentLocation: {}, text: "Next steps" } }],
      });

      await expect(
        fixture.provider.invoke(
          "googleworkspace.docs.text.replace",
          { documentId: "doc-replace", find: "Draft", replaceWith: "Final" },
          lifecycle([], true),
        ),
      ).resolves.toEqual({ status: "text-replaced", documentId: "doc-1", occurrencesChanged: 3 });
      expect(JSON.parse(String(apiCalls[7]?.init?.body))).toEqual({
        requests: [
          {
            replaceAllText: {
              containsText: { text: "Draft", matchCase: true },
              replaceText: "Final",
            },
          },
        ],
      });

      const values = [
        ["Name", '=IMPORTXML("https://example.invalid","//a")'],
        [1, true],
      ];
      await expect(
        fixture.provider.invoke(
          "googleworkspace.sheets.values.update",
          { spreadsheetId: "sheet-1", range: "Sheet1!A1:B2", values },
          lifecycle([], true),
        ),
      ).resolves.toEqual({
        status: "values-updated",
        spreadsheetId: "sheet-1",
        updatedRange: "Sheet1!A1:B2",
        updatedRows: 2,
        updatedColumns: 2,
        updatedCells: 4,
      });
      const update = apiCalls[8]!;
      expect(update.init?.method).toBe("PUT");
      expect(update.url).toContain("/v4/spreadsheets/sheet-1/values/Sheet1!A1%3AB2?");
      expect(new URL(update.url).searchParams.get("valueInputOption")).toBe("RAW");
      expect(JSON.parse(String(update.init?.body))).toEqual({ majorDimension: "ROWS", values });

      await expect(
        fixture.provider.invoke(
          "googleworkspace.sheets.values.append",
          { spreadsheetId: "sheet-1", range: "Sheet1!A:B", values: [["Row", 2]] },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ status: "values-appended", updatedRange: "Sheet1!A3:B3" });
      const append = new URL(apiCalls[9]!.url);
      expect(apiCalls[9]?.init?.method).toBe("POST");
      expect(append.pathname).toBe("/v4/spreadsheets/sheet-1/values/Sheet1!A%3AB:append");
      expect(append.searchParams.get("valueInputOption")).toBe("RAW");
      expect(append.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");

      const tooMany = Array.from({ length: 51 }, () => Array.from({ length: 200 }, () => 1));
      await expect(
        fixture.provider.invoke(
          "googleworkspace.sheets.values.update",
          { spreadsheetId: "sheet-1", range: "A1", values: tooMany },
          lifecycle([], true),
        ),
      ).rejects.toThrow(/10,000 cells/u);
      const nativeUpdate = lifecycle([], true);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.file.update",
          { itemId: "native-doc", content: "text", contentType: "text/plain" },
          nativeUpdate,
        ),
      ).rejects.toThrow(/native Google files/u);
      expect(nativeUpdate.beginCommit).not.toHaveBeenCalled();
      expect(apiCalls).toHaveLength(11);
      expect(
        apiCalls.every(
          ({ url, init }) =>
            init?.method !== "DELETE" && !url.includes("permissions") && !url.includes("Parents"),
        ),
      ).toBe(true);
    } finally {
      await fixture.provider.close();
    }
  });

  it("edits Slides and moves, trashes, deletes, and shares only through fixed endpoints", async () => {
    const apiCalls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fixture = oauthFixture({
      api: (url, init) => {
        apiCalls.push({ url, init });
        if (url.includes("slides.googleapis.com")) {
          const body = JSON.parse(String(init?.body)) as {
            readonly requests: ReadonlyArray<Record<string, unknown>>;
          };
          const request = body.requests[0] ?? {};
          return jsonResponse({
            presentationId: "deck-1",
            replies: [
              "replaceAllText" in request
                ? { replaceAllText: { occurrencesChanged: 2 } }
                : "createSlide" in request
                  ? { createSlide: { objectId: "slide_2" } }
                  : {},
            ],
          });
        }
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        if (url.includes("/permissions") && init?.method === "GET") {
          return jsonResponse({
            permissions: [
              { id: "perm-1", type: "user", role: "writer", emailAddress: "a@ucsd.edu" },
            ],
            nextPageToken: "raw-permission-page",
          });
        }
        if (url.includes("/permissions")) return jsonResponse({ id: "perm-2" });
        if (url.includes("/files/root?")) {
          return jsonResponse({ id: "root-id", mimeType: "application/vnd.google-apps.folder" });
        }
        if (url.includes("/files/new-1?")) {
          return jsonResponse({ id: "new-1", mimeType: "application/vnd.google-apps.folder" });
        }
        if (init?.method === "GET") {
          return jsonResponse({ id: "file-1", parents: ["root-id", "old-1"] });
        }
        return jsonResponse({ id: "file-1", mimeType: "application/pdf" });
      },
    });
    const body = (index: number) => JSON.parse(String(apiCalls[index]?.init?.body)) as unknown;
    try {
      await fixture.complete([
        "identity.read",
        "drive.write",
        "drive.organize",
        "drive.delete",
        "drive.share",
      ]);

      await expect(
        fixture.provider.invoke(
          "googleworkspace.slides.text.replace",
          { presentationId: "deck-1", find: "Q3", replaceWith: "Q4" },
          lifecycle([], true),
        ),
      ).resolves.toEqual({
        status: "text-replaced",
        presentationId: "deck-1",
        occurrencesChanged: 2,
      });
      expect(apiCalls[0]?.url).toBe(
        "https://slides.googleapis.com/v1/presentations/deck-1:batchUpdate",
      );
      await expect(
        fixture.provider.invoke(
          "googleworkspace.slides.slide.create",
          { presentationId: "deck-1", layout: "TITLE_ONLY", insertionIndex: 1 },
          lifecycle([], true),
        ),
      ).resolves.toEqual({
        status: "slide-created",
        presentationId: "deck-1",
        objectId: "slide_2",
      });
      expect(body(1)).toEqual({
        requests: [
          {
            createSlide: {
              insertionIndex: 1,
              slideLayoutReference: { predefinedLayout: "TITLE_ONLY" },
            },
          },
        ],
      });
      await expect(
        fixture.provider.invoke(
          "googleworkspace.slides.text.insert",
          { presentationId: "deck-1", objectId: "shape_1", text: "Agenda" },
          lifecycle([], true),
        ),
      ).resolves.toEqual({ status: "text-inserted", presentationId: "deck-1" });
      expect(body(2)).toEqual({
        requests: [{ insertText: { objectId: "shape_1", text: "Agenda", insertionIndex: 0 } }],
      });
      await expect(
        fixture.provider.invoke(
          "googleworkspace.slides.object.delete",
          { presentationId: "deck-1", objectId: "slide_2" },
          lifecycle([], true),
        ),
      ).resolves.toEqual({ status: "object-deleted", presentationId: "deck-1" });
      expect(body(3)).toEqual({ requests: [{ deleteObject: { objectId: "slide_2" } }] });

      const moveContext = lifecycle([], true);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.move",
          { itemId: "file-1", folderId: "new-1" },
          moveContext,
        ),
      ).resolves.toEqual({
        status: "item-moved",
        itemId: "file-1",
        mimeType: "application/pdf",
        folderId: "new-1",
      });
      expect(apiCalls[4]?.init?.method).toBe("GET");
      expect(new URL(apiCalls[5]!.url).pathname).toBe("/drive/v3/files/new-1");
      const move = new URL(apiCalls[6]!.url);
      expect(apiCalls[6]?.init?.method).toBe("PATCH");
      expect(move.searchParams.get("addParents")).toBe("new-1");
      expect(move.searchParams.get("removeParents")).toBe("root-id,old-1");
      expect(moveContext.beginCommit).toHaveBeenCalledOnce();

      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.trash",
          { itemId: "file-1" },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ status: "item-trashed" });
      expect(body(7)).toEqual({ trashed: true });
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.restore",
          { itemId: "file-1" },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ status: "item-restored" });
      expect(body(8)).toEqual({ trashed: false });
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.delete",
          { itemId: "file-1" },
          invocation(false),
        ),
      ).rejects.toThrow(/requires task access approval/u);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.delete",
          { itemId: "file-1" },
          lifecycle([], true),
        ),
      ).resolves.toEqual({ status: "item-deleted", itemId: "file-1" });
      expect(apiCalls[9]?.init?.method).toBe("DELETE");
      expect(new URL(apiCalls[9]!.url).pathname).toBe("/drive/v3/files/file-1");

      const listed = (await fixture.provider.invoke(
        "googleworkspace.drive.permissions.list",
        { itemId: "file-1", limit: 1 },
        invocation(),
      )) as { readonly cursor: string; readonly permissions: ReadonlyArray<unknown> };
      expect(listed.permissions).toEqual([
        {
          id: "perm-1",
          type: "user",
          role: "writer",
          emailAddress: "a@ucsd.edu",
          domain: null,
          displayName: null,
          expirationTime: null,
          deleted: false,
        },
      ]);
      expect(listed.cursor).not.toContain("raw-permission-page");

      const rejectedShare = lifecycle([], true);
      for (const input of [
        { itemId: "file-1", type: "user", role: "reader" },
        { itemId: "file-1", type: "anyone", role: "reader", emailAddress: "a@ucsd.edu" },
        { itemId: "file-1", type: "domain", role: "reader" },
        { itemId: "file-1", type: "anyone", role: "reader", notify: true },
      ]) {
        await expect(
          fixture.provider.invoke("googleworkspace.drive.permission.create", input, rejectedShare),
        ).rejects.toThrow(IntegrationProviderPublicError);
      }
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.permission.create",
          { itemId: "file-1", type: "user", role: "owner", emailAddress: "a@ucsd.edu" },
          rejectedShare,
        ),
      ).rejects.toBeDefined();
      expect(rejectedShare.beginCommit).not.toHaveBeenCalled();

      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.permission.create",
          { itemId: "file-1", type: "user", role: "commenter", emailAddress: "b@ucsd.edu" },
          lifecycle([], true),
        ),
      ).resolves.toEqual({
        status: "permission-created",
        itemId: "file-1",
        permissionId: "perm-2",
      });
      const share = new URL(apiCalls[11]!.url);
      expect(share.pathname).toBe("/drive/v3/files/file-1/permissions");
      expect(share.searchParams.get("sendNotificationEmail")).toBe("false");
      expect(body(11)).toEqual({ type: "user", role: "commenter", emailAddress: "b@ucsd.edu" });
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.permission.create",
          { itemId: "file-1", type: "anyone", role: "reader" },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ status: "permission-created" });
      expect(new URL(apiCalls[12]!.url).searchParams.has("sendNotificationEmail")).toBe(false);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.permission.update",
          { itemId: "file-1", permissionId: "perm-2", role: "reader" },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ status: "permission-updated" });
      expect(apiCalls[13]?.init?.method).toBe("PATCH");
      expect(body(13)).toEqual({ role: "reader" });
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.permission.delete",
          { itemId: "file-1", permissionId: "perm-2" },
          lifecycle([], true),
        ),
      ).resolves.toEqual({
        status: "permission-deleted",
        itemId: "file-1",
        permissionId: "perm-2",
      });
      expect(apiCalls[14]?.init?.method).toBe("DELETE");
      expect(new URL(apiCalls[14]!.url).pathname).toBe("/drive/v3/files/file-1/permissions/perm-2");

      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.move",
          { itemId: "file-1", folderId: "root" },
          lifecycle([], true),
        ),
      ).resolves.toMatchObject({ status: "item-moved", folderId: "root-id" });
      const rootMove = new URL(apiCalls[17]!.url);
      expect(rootMove.searchParams.get("addParents")).toBe("root-id");
      expect(rootMove.searchParams.get("removeParents")).toBe("old-1");
      const fileMove = lifecycle([], true);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.item.move",
          { itemId: "file-1", folderId: "file-1" },
          fileMove,
        ),
      ).rejects.toThrow(/must be a folder/u);
      expect(fileMove.beginCommit).not.toHaveBeenCalled();
    } finally {
      await fixture.provider.close();
    }
  });

  it("gates Drive organize, delete, and share tools on their own grants", async () => {
    const fixture = oauthFixture({ api: () => jsonResponse({ id: "item-1", mimeType: "x/y" }) });
    try {
      await fixture.complete(["identity.read", "drive.read"]);
      for (const [tool, capability] of [
        ["googleworkspace.drive.item.trash", "drive.organize"],
        ["googleworkspace.drive.item.delete", "drive.delete"],
        ["googleworkspace.drive.permissions.list", "drive.share"],
      ] as const) {
        await expect(
          fixture.provider.invoke(tool, { itemId: "file-1" }, lifecycle([], true)),
        ).rejects.toThrow(new RegExp(`${capability} access is not granted`, "u"));
      }
    } finally {
      await fixture.provider.close();
    }
  });

  it("requires the drive.write grant for Drive writes", async () => {
    const fixture = oauthFixture({ api: () => jsonResponse({ id: "item-1", mimeType: "x/y" }) });
    try {
      await fixture.complete(["identity.read", "drive.read"]);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.drive.folder.create",
          { name: "Reports" },
          lifecycle([], true),
        ),
      ).rejects.toThrow(/drive.write access is not granted/u);
    } finally {
      await fixture.provider.close();
    }
  });

  it("enforces date, attachment, download, response, abort, timeout, and rate-limit bounds", async () => {
    const fixture = oauthFixture({
      api: (url) => {
        if (url.includes("/attachments/")) {
          return jsonResponse({
            size: 3_500_001,
            data: Buffer.alloc(3_500_001).toString("base64url"),
          });
        }
        return jsonResponse({ error: "quota" }, 429, { "retry-after": "17" });
      },
    });
    try {
      await fixture.complete(["identity.read", "mail.read", "calendar.read"]);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.calendar.events.list",
          {
            start: "2026-07-01T00:00:00Z",
            end: "2026-09-01T00:00:00Z",
          },
          invocation(),
        ),
      ).rejects.toThrow(/31 days/u);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.mail.search",
          { after: "2026-02-30" },
          invocation(),
        ),
      ).rejects.toThrow(/real YYYY-MM-DD/u);
      await expect(
        fixture.provider.invoke("googleworkspace.calendar.list", {}, invocation()),
      ).rejects.toThrow(/rate limiting.*17 seconds/u);
      await expect(
        fixture.provider.invoke(
          "googleworkspace.mail.attachment.get",
          { messageId: "message-1", attachmentId: "attachment-1" },
          invocation(),
        ),
      ).rejects.toThrow(/3.5 MB/u);
    } finally {
      await fixture.provider.close();
    }

    const hangingApi = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason ?? new Error("aborted"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    const timeoutFixture = oauthFixture({ api: hangingApi, requestTimeoutMs: 10 });
    try {
      await timeoutFixture.complete(["identity.read", "mail.read"]);
      await expect(
        timeoutFixture.provider.invoke("googleworkspace.mail.labels.list", {}, invocation()),
      ).rejects.toThrow(/timed out/u);
    } finally {
      await timeoutFixture.provider.close();
    }

    const abortFixture = oauthFixture({ api: hangingApi });
    try {
      await abortFixture.complete(["identity.read", "mail.read"]);
      const controller = new AbortController();
      const pending = abortFixture.provider.invoke(
        "googleworkspace.mail.labels.list",
        {},
        { signal: controller.signal },
      );
      controller.abort();
      await expect(pending).rejects.toThrow(/cancelled/u);
    } finally {
      await abortFixture.provider.close();
    }
  });

  it("maps Google errors to sanitized public messages", async () => {
    const marker = "secret remote diagnostic";
    const statuses = [400, 401, 403, 404, 500] as const;
    for (const status of statuses) {
      const fixture = oauthFixture({
        api: () => jsonResponse({ error: { message: marker } }, status),
      });
      try {
        await fixture.complete(["identity.read", "mail.read"]);
        const error = await fixture.provider
          .invoke("googleworkspace.mail.labels.list", {}, invocation())
          .then(
            () => "",
            (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
          );
        expect(error).not.toContain(marker);
        expect(error).toContain("Google");
      } finally {
        await fixture.provider.close();
      }
    }
  });

  it("recognizes Google's 403 rate-limit reasons without exposing the remote payload", async () => {
    const fixture = oauthFixture({
      api: () =>
        jsonResponse(
          {
            error: {
              message: "sensitive quota diagnostic",
              errors: [{ reason: "userRateLimitExceeded" }],
            },
          },
          403,
          { "retry-after": "9" },
        ),
    });
    try {
      await fixture.complete(["identity.read", "mail.read"]);
      await expect(
        fixture.provider.invoke("googleworkspace.mail.labels.list", {}, invocation()),
      ).rejects.toThrow(/rate limiting.*9 seconds/u);
    } finally {
      await fixture.provider.close();
    }
  });
});
