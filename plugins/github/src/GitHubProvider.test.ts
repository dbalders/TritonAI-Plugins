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

const CONFIGURATION = { clientId: "Ov23li1234567890abcd" } as const;
const accessValue = ["gho", "fixture", "access"].join("_");
const oauthScope = "repo, read:org, workflow";

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
function tokenBody() {
  return { access_token: accessValue, token_type: "bearer", scope: oauthScope };
}
function userBody() {
  return { login: "octo-user", id: 42, name: "Octo User" };
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

describe("GitHubProvider OAuth product", () => {
  it("publishes strict schemas and truthful read/write metadata", async () => {
    expect(GITHUB_TOOLS).toHaveLength(28);
    for (const definition of GITHUB_TOOLS) {
      expect(definition.openWorld).toBe(true);
      expect(definition.idempotent).toBe(definition.readOnly);
      expect(definition.input).toBeDefined();
    }
    expect(GITHUB_TOOLS.some(({ name }) => name.includes("installation"))).toBe(false);
    const repositoryGet = GITHUB_TOOLS.find(({ name }) => name === "github.repositories.get")!;
    await expect(
      Schema.decodeUnknownPromise(repositoryGet.input)(
        { owner: "octo", repo: "repo", unexpected: true },
        { errors: "all", onExcessProperty: "error" },
      ),
    ).rejects.toThrow();
    expect(GITHUB_TOOLS.find(({ name }) => name === "github.contents.put")).toMatchObject({
      readOnly: false,
      destructive: true,
    });
  });

  it("accepts OAuth App client IDs and bounded request timeouts", () => {
    const secrets = memorySecrets();
    expect(() => new GitHubProvider(secrets.service, { clientId: "Iv1.1234567890abcdef" })).toThrow(
      /OAuth App/u,
    );
    expect(() => new GitHubProvider(secrets.service, { clientId: "Iv23linqGnywexMxC0xQ" })).toThrow(
      /OAuth App/u,
    );
    expect(() => provider(secrets.service, globalThis.fetch, 30_001)).toThrow(/bounded/u);
    expect(() => provider(secrets.service, globalThis.fetch, 1.5)).toThrow(/bounded/u);
  });

  it("requests the exact standard developer OAuth scopes without a client secret", async () => {
    const secrets = memorySecrets();
    const mock = sequence([json(deviceBody())]);
    const github = provider(secrets.service, mock.fetchImplementation);
    const result = await github.connect(
      ["identity.read", "repository.read", "repository.write"],
      lifecycle(),
    );
    expect(result).toMatchObject({
      kind: "device_code",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-EFGH",
      intervalSeconds: 5,
    });
    const request = mock.requests[0]!;
    expect(request.url).toBe("https://github.com/login/device/code");
    const form = new URLSearchParams(String(request.init?.body));
    expect(form.get("client_id")).toBe(CONFIGURATION.clientId);
    expect(form.get("scope")).toBe("repo read:org workflow");
    expect(form.has("client_secret")).toBe(false);
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
  });

  it("stores an ordinary non-expiring OAuth grant and calls zero installation APIs", async () => {
    const secrets = memorySecrets();
    secrets.values.set("github-app-user", new TextEncoder().encode("obsolete"));
    const mock = sequence([json(deviceBody()), json(tokenBody()), json(userBody())]);
    const github = provider(secrets.service, mock.fetchImplementation);
    const result = await github.poll(
      (
        await github.connect(
          [
            "identity.read",
            "repository.read",
            "repository.write",
            "issues.write",
            "pull-requests.write",
          ],
          lifecycle(),
        )
      ).flowId,
      lifecycle(),
    );
    expect(result).toMatchObject({
      state: "connected",
      message: expect.stringContaining("octo-user"),
    });
    expect(mock.requests.map(({ url }) => url)).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
    expect(mock.requests.some(({ url }) => url.includes("installation"))).toBe(false);
    const stored = JSON.parse(
      new TextDecoder().decode(secrets.values.get(GITHUB_SECRET_SUFFIX)),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 2,
      accessToken: accessValue,
      oauthScopes: ["read:org", "repo", "workflow"],
    });
    expect(stored).not.toHaveProperty("refreshToken");
    expect(stored).not.toHaveProperty("accessTokenExpiresAt");
    expect(secrets.values.has("github-app-user")).toBe(false);
    expect(await github.status()).toMatchObject({
      state: "connected",
      accountLabel: "octo-user",
      grantedCapabilities: [
        "identity.read",
        "issues.write",
        "pull-requests.write",
        "repository.read",
        "repository.write",
      ],
    });
  });

  it("rejects incomplete, excess, and refresh-token grants before storage", async () => {
    for (const grant of [
      { ...tokenBody(), scope: "repo,read:org" },
      { ...tokenBody(), scope: "repo,read:org,workflow,gist" },
      { ...tokenBody(), expires_in: 28_800, refresh_token: "refresh" },
    ]) {
      const secrets = memorySecrets();
      const mock = sequence([json(deviceBody()), json(grant)]);
      const github = provider(secrets.service, mock.fetchImplementation);
      const flow = await github.connect(["identity.read"], lifecycle());
      await expect(github.poll(flow.flowId, lifecycle())).rejects.toThrow(/OAuth scopes|expiring/u);
      expect(secrets.values.size).toBe(0);
    }
  });

  it("drops previously granted Harness write capabilities when reconnecting narrowly", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github, lifecycle(), ["identity.read", "repository.write"]);
    await authorize(github, lifecycle(), ["identity.read"]);
    expect(await github.status()).toMatchObject({
      state: "connected",
      grantedCapabilities: ["identity.read"],
    });
  });

  it("prepares a stored OAuth token using only GET /user and caches its verified identity", async () => {
    const secrets = memorySecrets();
    const mock = sequence([json(deviceBody()), json(tokenBody()), json(userBody())]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    await github.prepare(lifecycle());
    await github.prepare(lifecycle());
    expect(mock.requests).toHaveLength(3);
    expect(mock.requests.some(({ url }) => url.includes("installation"))).toBe(false);
  });

  it("enumerates bounded authenticated-user repositories instead of installations", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json([{ id: 1, full_name: "octo/repo" }]),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    await expect(
      github.invoke("github.repositories.list", { limit: 51 }, invocation()),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(3);
    await expect(
      github.invoke("github.repositories.list", { limit: 1, page: 2 }, invocation()),
    ).resolves.toEqual([{ id: 1, full_name: "octo/repo" }]);
    expect(mock.requests[3]?.url).toBe(
      "https://api.github.com/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated&direction=desc&per_page=1&page=2",
    );
    expect(mock.requests[3]?.url).not.toContain("installation");
  });

  it("supports fixed fork, branch, and bounded content-commit contribution tools", async () => {
    const secrets = memorySecrets();
    const sourceSha = "a".repeat(40);
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json({ id: 80, full_name: "octo-user/project" }, 202),
      json({ sha: sourceSha }),
      json({ ref: "refs/heads/feature/demo", object: { sha: sourceSha } }, 201),
      json({
        content: { path: "README.md", sha: "b".repeat(40) },
        commit: { sha: "c".repeat(40) },
      }),
      json({ number: 12, html_url: "https://github.com/upstream/project/pull/12" }, 201),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github, lifecycle(), [
      "identity.read",
      "repository.read",
      "repository.write",
      "pull-requests.write",
    ]);
    const events: string[] = [];
    await github.invoke(
      "github.repositories.fork",
      { owner: "upstream", repo: "project" },
      invocation(true, events),
    );
    await github.invoke(
      "github.branches.create",
      { owner: "octo-user", repo: "project", branch: "feature/demo", fromRef: "main" },
      invocation(true, events),
    );
    await github.invoke(
      "github.contents.put",
      {
        owner: "octo-user",
        repo: "project",
        path: "README.md",
        branch: "feature/demo",
        message: "Document the contribution",
        content: "Hello, GitHub!",
        sha: "d".repeat(40),
      },
      invocation(true, events),
    );
    await github.invoke(
      "github.pulls.create",
      {
        owner: "upstream",
        repo: "project",
        title: "Contribute the documentation",
        head: "octo-user:feature/demo",
        base: "main",
      },
      invocation(true, events),
    );
    expect(events).toEqual(["beginCommit", "beginCommit", "beginCommit", "beginCommit"]);
    expect(mock.requests.slice(3).map(({ url, init }) => [url, init?.method])).toEqual([
      ["https://api.github.com/repos/upstream/project/forks", "POST"],
      ["https://api.github.com/repos/octo-user/project/commits/main", "GET"],
      ["https://api.github.com/repos/octo-user/project/git/refs", "POST"],
      ["https://api.github.com/repos/octo-user/project/contents/README.md", "PUT"],
      ["https://api.github.com/repos/upstream/project/pulls", "POST"],
    ]);
    expect(JSON.parse(String(mock.requests[5]?.init?.body))).toEqual({
      ref: "refs/heads/feature/demo",
      sha: sourceSha,
    });
    expect(JSON.parse(String(mock.requests[6]?.init?.body))).toEqual({
      message: "Document the contribution",
      content: Buffer.from("Hello, GitHub!").toString("base64"),
      branch: "feature/demo",
      sha: "d".repeat(40),
    });
  });

  it("cannot bypass repository.write, approval, commit admission, or input bounds", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    await expect(
      github.invoke("github.repositories.fork", { owner: "octo", repo: "repo" }, invocation()),
    ).rejects.toThrow(/repository.write access is not enabled/u);
    expect(mock.requests).toHaveLength(3);
    await authorize(github, lifecycle(), ["identity.read", "repository.read", "repository.write"]);
    await expect(
      github.invoke(
        "github.contents.put",
        {
          owner: "octo",
          repo: "repo",
          path: "a.txt",
          branch: "main",
          message: "write",
          content: "safe",
        },
        invocation(false),
      ),
    ).rejects.toThrow(/approval and commit admission/u);
    await expect(
      github.invoke(
        "github.contents.put",
        {
          owner: "octo",
          repo: "repo",
          path: "a.txt",
          branch: "main",
          message: "write",
          content: "é".repeat(600_000),
        },
        invocation(),
      ),
    ).rejects.toThrow(/one-megabyte UTF-8/u);
    await expect(
      github.invoke(
        "github.branches.create",
        { owner: "octo", repo: "repo", branch: "../unsafe", fromRef: "main" },
        invocation(),
      ),
    ).rejects.toThrow();
    await expect(
      github.invoke(
        "github.branches.create",
        { owner: "octo", repo: "repo", branch: ".", fromRef: "main" },
        invocation(),
      ),
    ).rejects.toThrow();
    await expect(
      github.invoke(
        "github.contents.put",
        {
          owner: "octo",
          repo: "repo",
          path: "./README.md",
          branch: "main",
          message: "write",
          content: "safe",
        },
        invocation(),
      ),
    ).rejects.toThrow();
    await expect(
      github.invoke("github.repositories.fork", { owner: "octo", repo: "." }, invocation()),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(6);
  });

  it("keeps issue and pull-request writes behind their independent capabilities", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json({ id: 10, number: 7, title: "Created" }),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github, lifecycle(), ["identity.read", "issues.write"]);
    await expect(
      github.invoke(
        "github.pulls.create",
        { owner: "octo", repo: "repo", title: "PR", head: "feature", base: "main" },
        invocation(),
      ),
    ).rejects.toThrow(/pull-requests.write access is not enabled/u);
    const events: string[] = [];
    await expect(
      github.invoke(
        "github.issues.create",
        { owner: "octo", repo: "repo", title: "Bounded issue" },
        invocation(true, events),
      ),
    ).resolves.toMatchObject({ number: 7 });
    expect(events).toEqual(["beginCommit"]);
  });

  it("uses fixed read endpoints and rejects unsafe search qualifiers before network access", async () => {
    const secrets = memorySecrets();
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
      json({ type: "file", size: 4, content: "dGVzdA==", encoding: "base64", path: "src/a.ts" }),
      json({ total_count: 1, workflow_runs: [{ id: 99, conclusion: "failure" }] }),
    ]);
    const github = provider(secrets.service, mock.fetchImplementation);
    await authorize(github);
    await expect(
      github.invoke("github.repositories.search", { query: "org:another" }, invocation()),
    ).rejects.toThrow();
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
    expect(mock.requests.slice(3).map(({ url }) => url)).toEqual([
      "https://api.github.com/repos/octo/repo/contents/src/a.ts?ref=feature%2Fsafe",
      "https://api.github.com/repos/octo/repo/actions/runs?per_page=1&page=1",
    ]);
  });

  it("bounds responses and sanitizes GitHub API errors", async () => {
    const secrets = memorySecrets();
    const sentinel = "private-server-error-and-token";
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    const mock = sequence([
      json(deviceBody()),
      json(tokenBody()),
      json(userBody()),
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
    const mock = sequence([json(deviceBody()), json(tokenBody()), json(userBody())]);
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
    const mock = sequence([json(deviceBody()), json(tokenBody()), json(userBody())]);
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
