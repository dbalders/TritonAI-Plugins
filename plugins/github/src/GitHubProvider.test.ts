import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { GITHUB_SECRET_SUFFIX, GITHUB_TOOLS, GitHubProvider } from "./GitHubProvider.ts";
import type {
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationSecretStore,
} from "./host-contract.ts";

const CONFIGURATION = { clientId: "Iv1.1234567890abcdef" } as const;
const accessValue = ["ghu", "fixture", "access"].join("_");
const refreshValue = ["ghr", "fixture", "refresh"].join("_");

function memorySecrets(options: { failSetAfterWrite?: boolean; failRemove?: boolean } = {}) {
  const values = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const service: IntegrationSecretStore = {
    get: (name) =>
      Effect.sync(() => {
        calls.push(`get:${name}`);
        return Option.fromUndefinedOr(values.get(name));
      }),
    set: (name, bytes) =>
      Effect.sync(() => {
        calls.push(`set:${name}`);
        values.set(name, Uint8Array.from(bytes));
        if (options.failSetAfterWrite) throw new Error("fixture secret persistence failed");
      }),
    remove: (name) =>
      Effect.sync(() => {
        calls.push(`remove:${name}`);
        if (options.failRemove) throw new Error("fixture secret removal failed");
        values.delete(name);
      }),
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
function invocation(approved = true, events: string[] = []): IntegrationInvocationContext {
  return { ...lifecycle(events), writeApproved: approved };
}
function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
function deviceBody() {
  return {
    device_code: "device-fixture",
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  };
}
function tokenBody(expiring = false) {
  return {
    access_token: accessValue,
    token_type: "bearer",
    scope: "",
    ...(expiring
      ? { expires_in: 28_800, refresh_token: refreshValue, refresh_token_expires_in: 15_897_600 }
      : {}),
  };
}
function userBody() {
  return { login: "octo-user", id: 42, name: "Octo User" };
}
function installationsBody() {
  return { total_count: 0, installations: [] };
}
function provider(
  secrets: IntegrationSecretStore,
  fetchImplementation: typeof fetch,
  timeout?: number,
) {
  return new GitHubProvider(secrets, CONFIGURATION, fetchImplementation, timeout);
}
function sequence(responses: ReadonlyArray<Response>) {
  let index = 0;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const response = responses[index++];
    if (!response) throw new Error("unexpected fixture request");
    return response;
  }) as unknown as typeof fetch;
  return { fetchImplementation, requests };
}
async function authorize(
  github: GitHubProvider,
  context = lifecycle(),
  capabilities: ReadonlyArray<string> = ["identity.read", "repository.read"],
) {
  const flow = await github.connect(capabilities, context);
  const result = await github.poll(flow.flowId, context);
  expect(result.state).toBe("connected");
  return flow;
}

describe("GitHubProvider", () => {
  it("publishes executable strict schemas and truthful read/write metadata", async () => {
    expect(GITHUB_TOOLS).toHaveLength(26);
    for (const definition of GITHUB_TOOLS) {
      expect(definition.openWorld).toBe(true);
      expect(definition.idempotent).toBe(definition.readOnly);
      expect(definition.input).toBeDefined();
    }
    const repositoryGet = GITHUB_TOOLS.find(({ name }) => name === "github.repositories.get")!;
    await expect(
      Schema.decodeUnknownPromise(repositoryGet.input)(
        { owner: "octo", repo: "repo", unexpected: true },
        { errors: "all", onExcessProperty: "error" },
      ),
    ).rejects.toThrow();
    const update = GITHUB_TOOLS.find(({ name }) => name === "github.issues.update")!;
    expect(update.readOnly).toBe(false);
    expect(update.destructive).toBe(true);
  });

  it("validates client IDs and bounded request timeouts", () => {
    const secrets = memorySecrets();
    expect(() => new GitHubProvider(secrets.service, { clientId: "short" })).toThrow(
      /valid public/u,
    );
    expect(() => provider(secrets.service, globalThis.fetch, 30_001)).toThrow(/bounded/u);
    expect(() => provider(secrets.service, globalThis.fetch, 1.5)).toThrow(/bounded/u);
  });

  it("starts official clientId-only device flow without scopes or secrets", async () => {
    const secrets = memorySecrets();
    const mock = sequence([json(deviceBody())]);
    const github = provider(secrets.service, mock.fetchImplementation);
    const result = await github.connect(["identity.read", "repository.read"], lifecycle());
    expect(result).toMatchObject({
      kind: "device_code",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-EFGH",
      intervalSeconds: 5,
    });
    const request = mock.requests[0]!;
    expect(request.url).toBe("https://github.com/login/device/code");
    expect(String(request.init?.body)).toBe(
      `client_id=${encodeURIComponent(CONFIGURATION.clientId)}`,
    );
    expect(String(request.init?.body)).not.toMatch(/scope|secret|token/iu);
    expect(secrets.values.size).toBe(0);
  });

  it("handles pending, slow-down, denial, and expiry without storing credentials", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json({ error: "authorization_pending" }, 400),
      json({ error: "slow_down" }, 400),
      json({ error: "access_denied" }, 400),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    const flow = await github.connect(["identity.read"], lifecycle());
    expect(await github.poll(flow.flowId, lifecycle())).toMatchObject({
      state: "pending",
      retryAfterSeconds: 5,
    });
    expect(await github.poll(flow.flowId, lifecycle())).toMatchObject({
      state: "pending",
      retryAfterSeconds: 10,
    });
    expect(await github.poll(flow.flowId, lifecycle())).toMatchObject({
      state: "failed",
      message: expect.stringMatching(/cancelled/u),
    });
    expect(secrets.values.size).toBe(0);
    await expect(github.poll(flow.flowId, lifecycle())).rejects.toThrow(/not found/u);
  });

  it("verifies the token, GitHub App relationship, and empty scope before storing credentials", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody(true)),
      json(userBody()),
      json(installationsBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    const flow = await github.connect(
      ["identity.read", "repository.read", "issues.write"],
      lifecycle(),
    );
    const result = await github.poll(flow.flowId, lifecycle());
    expect(result).toMatchObject({
      state: "connected",
      message: expect.stringContaining("octo-user"),
    });
    expect(mock.requests[2]?.url).toBe("https://api.github.com/user");
    expect(mock.requests[2]?.init?.headers).toMatchObject({
      authorization: `Bearer ${accessValue}`,
    });
    expect(mock.requests[3]?.url).toBe(
      "https://api.github.com/user/installations?per_page=1&page=1",
    );
    expect(secrets.calls).toContain(`set:${GITHUB_SECRET_SUFFIX}`);
    expect([...secrets.values.keys()]).toEqual([GITHUB_SECRET_SUFFIX]);
    const storedText = new TextDecoder().decode(secrets.values.get(GITHUB_SECRET_SUFFIX));
    expect(storedText).toContain(accessValue);
    expect(String(result)).not.toContain(accessValue);
    expect(await github.status()).toMatchObject({
      state: "connected",
      accountLabel: "octo-user",
      grantedCapabilities: ["identity.read", "issues.write", "repository.read"],
    });
  });

  it("reports an aborted status check as cancellation without blaming the credential", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    const controller = new AbortController();
    controller.abort();
    expect(await github.status({ signal: controller.signal })).toMatchObject({
      state: "error",
      message: expect.stringMatching(/cancelled/u),
    });
    expect((await github.status()).state).toBe("connected");
  });

  it("drops previously granted write capabilities when reconnecting more narrowly", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github, lifecycle(), ["identity.read", "issues.write"]);
    await authorize(github, lifecycle(), ["identity.read"]);
    expect(await github.status()).toMatchObject({
      state: "connected",
      grantedCapabilities: ["identity.read"],
    });
  });

  it("rejects classic OAuth scope grants and never commits them", async () => {
    const secrets = memorySecrets();
    const mock = sequence([json(deviceBody()), json({ ...tokenBody(), scope: "repo" })]);
    const github = provider(secrets.service, mock.fetchImplementation);
    const flow = await github.connect(["identity.read"], lifecycle());
    await expect(github.poll(flow.flowId, lifecycle())).rejects.toThrow(/unexpected token grant/u);
    expect(secrets.values.size).toBe(0);
  });

  it("rejects a token that cannot use the GitHub App installations API", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json({ message: "not an app user token" }, 403),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    const flow = await github.connect(["identity.read"], lifecycle());
    await expect(github.poll(flow.flowId, lifecycle())).rejects.toThrow(/denied/u);
    expect(secrets.values.size).toBe(0);
    expect(await github.status()).toMatchObject({
      state: "error",
      message: expect.stringMatching(/uncertain/u),
    });
  });

  it("refreshes rotating device-flow credentials with no client secret and verifies account continuity", async () => {
    const secrets = memorySecrets();
    const expired = {
      version: 1,
      accessToken: "expired-access",
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshToken: refreshValue,
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      account: { login: "octo-user", id: 42 },
      grantedCapabilities: ["identity.read"],
      updatedAt: new Date().toISOString(),
    };
    secrets.values.set(GITHUB_SECRET_SUFFIX, new TextEncoder().encode(JSON.stringify(expired)));
    const mock = sequence([
      json({
        ...tokenBody(true),
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
      }),
      json(userBody()),
      json(installationsBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await github.prepare(lifecycle());
    const form = String(mock.requests[0]?.init?.body);
    expect(form).toContain("grant_type=refresh_token");
    expect(form).toContain(`client_id=${encodeURIComponent(CONFIGURATION.clientId)}`);
    expect(form).not.toContain("client_secret");
    const stored = new TextDecoder().decode(secrets.values.get(GITHUB_SECRET_SUFFIX));
    expect(stored).toContain("rotated-access");
    expect(stored).toContain("rotated-refresh");
  });

  it("reports fully expired credentials without attempting a network request", async () => {
    const secrets = memorySecrets();
    secrets.values.set(
      GITHUB_SECRET_SUFFIX,
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          accessToken: "expired-access",
          accessTokenExpiresAt: new Date(Date.now() - 120_000).toISOString(),
          refreshToken: refreshValue,
          refreshTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          account: { login: "octo-user", id: 42 },
          grantedCapabilities: ["identity.read"],
          updatedAt: new Date().toISOString(),
        }),
      ),
    );
    const mock = sequence([]);
    const github = provider(secrets.service, mock.fetchImplementation);
    expect(await github.status()).toMatchObject({
      state: "error",
      accountLabel: "octo-user",
      message: expect.stringMatching(/expired/u),
    });
    await expect(github.prepare(lifecycle())).rejects.toThrow(/reconnect/iu);
    expect(mock.requests).toHaveLength(0);
  });

  it("requires write approval and beginCommit before any issue mutation", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
      json({ id: 10, number: 7, title: "Created" }),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github, lifecycle(), ["identity.read", "repository.read", "issues.write"]);
    const input = { owner: "octo-org", repo: "repo.one", title: "Bounded issue" };
    await expect(github.invoke("github.issues.create", input, invocation(false))).rejects.toThrow(
      /approval and commit admission/u,
    );
    expect(mock.requests).toHaveLength(4);
    const events: string[] = [];
    const result = await github.invoke("github.issues.create", input, invocation(true, events));
    expect(result).toMatchObject({ number: 7 });
    expect(events).toEqual(["beginCommit"]);
    expect(mock.requests[4]?.url).toBe("https://api.github.com/repos/octo-org/repo.one/issues");
    expect(mock.requests[4]?.init?.method).toBe("POST");
  });

  it("does not let issue updates cross the pull-request capability boundary", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
      json({ number: 7, pull_request: { url: "https://api.github.test/pulls/7" } }),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github, lifecycle(), ["identity.read", "issues.write"]);
    const events: string[] = [];

    await expect(
      github.invoke(
        "github.issues.update",
        { owner: "octo-org", repo: "repo.one", number: 7, title: "Wrong boundary" },
        invocation(true, events),
      ),
    ).rejects.toThrow(/belongs to a pull request/u);
    expect(events).toEqual([]);
    expect(mock.requests).toHaveLength(5);
    expect(mock.requests[4]?.init?.method).toBe("GET");
  });

  it("reuses the verified account while the stored credential revision is unchanged", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);

    await github.prepare(lifecycle());
    await github.prepare(lifecycle());

    expect(mock.requests).toHaveLength(4);
  });

  it("requires an independently enabled write capability even when the token is connected", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    await expect(
      github.invoke(
        "github.pulls.comment.create",
        { owner: "octo", repo: "repo", number: 1, body: "comment" },
        invocation(),
      ),
    ).rejects.toThrow(/pull-requests.write access is not enabled/u);
    expect(mock.requests).toHaveLength(4);
  });

  it("keeps issue and pull-request comment capabilities bound to the target type", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
      json({ number: 1 }),
      json({ number: 2, pull_request: { url: "https://api.github.test/pulls/2" } }),
      json({ number: 3 }),
      json({ id: 30, body: "issue comment" }),
      json({ number: 4, pull_request: { url: "https://api.github.test/pulls/4" } }),
      json({ id: 40, body: "pull comment" }),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github, lifecycle(), ["identity.read", "issues.write", "pull-requests.write"]);

    const mismatchedPullEvents: string[] = [];
    await expect(
      github.invoke(
        "github.pulls.comment.create",
        { owner: "octo", repo: "repo", number: 1, body: "wrong target" },
        invocation(true, mismatchedPullEvents),
      ),
    ).rejects.toThrow(/belongs to an issue/u);
    expect(mismatchedPullEvents).toEqual([]);

    const mismatchedIssueEvents: string[] = [];
    await expect(
      github.invoke(
        "github.issues.comment.create",
        { owner: "octo", repo: "repo", number: 2, body: "wrong target" },
        invocation(true, mismatchedIssueEvents),
      ),
    ).rejects.toThrow(/belongs to a pull request/u);
    expect(mismatchedIssueEvents).toEqual([]);

    const issueEvents: string[] = [];
    await expect(
      github.invoke(
        "github.issues.comment.create",
        { owner: "octo", repo: "repo", number: 3, body: "issue comment" },
        invocation(true, issueEvents),
      ),
    ).resolves.toMatchObject({ id: 30 });
    expect(issueEvents).toEqual(["beginCommit"]);

    const pullEvents: string[] = [];
    await expect(
      github.invoke(
        "github.pulls.comment.create",
        { owner: "octo", repo: "repo", number: 4, body: "pull comment" },
        invocation(true, pullEvents),
      ),
    ).resolves.toMatchObject({ id: 40 });
    expect(pullEvents).toEqual(["beginCommit"]);
    expect(mock.requests.slice(4).map(({ init }) => init?.method ?? "GET")).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
  });

  it("rejects search qualifiers and comma-bearing label filters before network access", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    await expect(
      github.invoke("github.repositories.search", { query: "org:another" }, invocation()),
    ).rejects.toThrow();
    await expect(
      github.invoke(
        "github.code.search",
        { owner: "octo", repo: "repo", query: "repo:another/private" },
        invocation(),
      ),
    ).rejects.toThrow();
    await expect(
      github.invoke(
        "github.issues.search",
        { owner: "octo", repo: "repo", query: "is:private" },
        invocation(),
      ),
    ).rejects.toThrow();
    await expect(
      github.invoke(
        "github.issues.list",
        { owner: "octo", repo: "repo", labels: ["triage, urgent"] },
        invocation(),
      ),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(4);
  });

  it("uses fixed installation, content, and Actions endpoints with bounded pagination", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
      json({ total_count: 1, repositories: [{ id: 1, full_name: "octo/repo" }] }),
      json({ type: "file", size: 4, content: "dGVzdA==", encoding: "base64", path: "src/a.ts" }),
      json({
        total_count: 1,
        workflow_runs: [{ id: 99, status: "completed", conclusion: "failure" }],
      }),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    await expect(
      github.invoke("github.repositories.list", { installationId: 88, limit: 51 }, invocation()),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(4);
    await github.invoke(
      "github.repositories.list",
      { installationId: 88, limit: 1, page: 2 },
      invocation(),
    );
    await github.invoke(
      "github.contents.get",
      { owner: "octo", repo: "repo", path: "src/a.ts", ref: "feature/safe" },
      invocation(),
    );
    await github.invoke(
      "github.actions.runs.list",
      { owner: "octo", repo: "repo", limit: 1 },
      invocation(),
    );
    expect(mock.requests.slice(4).map(({ url }) => url)).toEqual([
      "https://api.github.com/user/installations/88/repositories?per_page=1&page=2",
      "https://api.github.com/repos/octo/repo/contents/src/a.ts?ref=feature%2Fsafe",
      "https://api.github.com/repos/octo/repo/actions/runs?per_page=1&page=1",
    ]);
  });

  it("rejects unsafe refs, directory responses, oversized files, and excess fields", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
      json([{ type: "file", path: "nested" }]),
      json({ type: "file", size: 1_048_577, content: "eA==" }),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    await expect(
      github.invoke(
        "github.contents.get",
        { owner: "octo", repo: "repo", path: "a", ref: "../main" },
        invocation(),
      ),
    ).rejects.toThrow();
    await expect(
      github.invoke(
        "github.contents.get",
        { owner: "octo", repo: "repo", path: "dir" },
        invocation(),
      ),
    ).rejects.toThrow(/directory/u);
    await expect(
      github.invoke(
        "github.contents.get",
        { owner: "octo", repo: "repo", path: "large.bin" },
        invocation(),
      ),
    ).rejects.toThrow(/one-megabyte/u);
    await expect(
      github.invoke("github.identity.get", { token: accessValue }, invocation()),
    ).rejects.toThrow();
  });

  it("bounds response bytes and sanitizes GitHub API errors", async () => {
    const secrets = memorySecrets();
    const sentinel = "private-server-error-and-token";
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
      json({ message: sentinel }, 403),
      json({ value: huge }),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    let failure: unknown;
    try {
      await github.invoke(
        "github.repositories.get",
        { owner: "octo", repo: "private" },
        invocation(),
      );
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toMatch(/denied/u);
    expect(String(failure)).not.toContain(sentinel);
    expect(String(failure)).not.toContain(accessValue);
    await expect(
      github.invoke("github.repositories.get", { owner: "octo", repo: "huge" }, invocation()),
    ).rejects.toThrow(/exceeded/u);
  });

  it("enters uncertain state if an issued token cannot be durably persisted", async () => {
    const secrets = memorySecrets({ failSetAfterWrite: true });
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    const flow = await github.connect(["identity.read"], lifecycle());
    await expect(github.poll(flow.flowId, lifecycle())).rejects.toThrow(/persistence/u);
    expect(await github.status()).toMatchObject({
      state: "error",
      message: expect.stringMatching(/uncertain/u),
    });
  });

  it("disconnect removes the package secret and invalidates in-memory access", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(installationsBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    await github.disconnect(lifecycle());
    expect(secrets.values.has(GITHUB_SECRET_SUFFIX)).toBe(false);
    expect(await github.status()).toMatchObject({ state: "not_connected" });
    await expect(github.invoke("github.identity.get", {}, invocation())).rejects.toThrow(
      /preparation or reconnection/u,
    );
  });

  it("cancels in-flight requests when closed", async () => {
    const secrets = memorySecrets();
    let observedSignal: AbortSignal | undefined;
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        observedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) =>
          observedSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      },
    ) as unknown as typeof fetch;
    const github = provider(secrets.service, fetchImplementation);
    const pending = github.connect(["identity.read"], lifecycle());
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await github.close();
    await expect(pending).rejects.toThrow(/closed/u);
    expect(observedSignal?.aborted).toBe(true);
  });
});
