import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as NodeHttp from "node:http";
import test from "node:test";

import { createIntegrationProvider } from "../dist/index.mjs";

const READ = "jira-data-center.read";
const WRITE = "jira-data-center.write";
const BROKER = "https://broker.example";
const API = "https://its-pro.ucsd.edu/rest/api/2";
const CONFIG = { brokerUrl: BROKER, oauthClientId: "client-123" };
const originalFetch = globalThis.fetch;
const providers = [];

test.afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  globalThis.fetch = originalFetch;
});

function memorySecrets(initial = {}, options = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    values,
    service: {
      async get(name) {
        calls.push(`get:${name}`);
        return values.get(name) ?? null;
      },
      async set(name, value) {
        calls.push(`set:${name}`);
        if (options.failSet?.()) throw new Error("fixture set failure");
        values.set(name, value);
      },
      async remove(name) {
        calls.push(`remove:${name}`);
        values.delete(name);
      },
    },
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Routes fetch calls by "METHOD url-without-query". A handler may be a Response factory or a
// queue of them consumed in order.
function network() {
  const calls = [];
  const routes = new Map();
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? "GET"} ${url.origin}${url.pathname}`;
    const body =
      typeof init.body === "string" && init.body.startsWith("{")
        ? JSON.parse(init.body)
        : init.body;
    const call = { key, url, init, body };
    calls.push(call);
    const route = routes.get(key);
    const handler = Array.isArray(route) ? route.shift() : route;
    if (!handler) throw new Error(`unexpected fixture request ${key}`);
    return handler(call);
  };
  return {
    calls,
    fetch,
    on(key, handler) {
      routes.set(key, handler);
    },
    count(key) {
      return calls.filter((call) => call.key === key).length;
    },
  };
}

function lifecycle(events = [], controller = new AbortController()) {
  return {
    signal: controller.signal,
    async beginCommit() {
      events.push("beginCommit");
      return controller.signal;
    },
  };
}

function invocation(events = [], { writeApproved = false } = {}) {
  return { ...lifecycle(events), writeApproved };
}

function create(secrets, net, configuration = CONFIG) {
  globalThis.fetch = net.fetch;
  const provider = createIntegrationProvider({ secrets: secrets.service, configuration });
  providers.push(provider);
  return provider;
}

function loopback(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const user = (overrides = {}) => ({
  name: "dbalderston",
  key: "JIRAUSER1",
  displayName: "David Balderston",
  active: true,
  ...overrides,
});

const tokens = (n, extra = {}) =>
  json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, ...extra });

async function settle(provider, flowId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await provider.poll(flowId, lifecycle());
    if (result.state !== "pending") return result;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("flow did not settle");
}

async function signIn(
  provider,
  net,
  { capabilities = [READ, WRITE], account = user(), n = 1, events = [] } = {},
) {
  net.on(`POST ${BROKER}/v1/token`, () =>
    tokens(n, { scope: capabilities.includes(WRITE) ? "WRITE" : "READ" }),
  );
  net.on(`GET ${API}/myself`, () => json(account));
  const started = await provider.connect(capabilities, lifecycle());
  const url = new URL(started.authorizationUrl);
  const state = url.searchParams.get("state");
  const port = Number(state.split(".")[0]);
  const callback = await loopback(
    port,
    `/tritonai/jira/callback?state=${encodeURIComponent(state)}&code=code-${n}`,
  );
  assert.equal(callback.status, 200);
  const result = await settle(provider, started.flowId);
  assert.equal(result.state, "connected", result.message);
  return { started, url, state, port };
}

test("configuration pins the UCSD origin and requires an HTTPS relay and client ID", () => {
  const secrets = memorySecrets();
  const net = network();
  globalThis.fetch = net.fetch;
  for (const configuration of [
    {},
    { ...CONFIG, tenantUrl: "https://evil.example" },
    { ...CONFIG, tenantUrl: "https://its-pro.ucsd.edu:444" },
    { ...CONFIG, brokerUrl: "http://broker.example" },
    { ...CONFIG, brokerUrl: "https://broker.example/path" },
    { ...CONFIG, brokerUrl: "https://user@broker.example" },
    { ...CONFIG, brokerUrl: "https://its-pro.ucsd.edu" },
    { ...CONFIG, oauthClientId: "has space" },
    { ...CONFIG, extra: true },
  ]) {
    assert.throws(
      () => createIntegrationProvider({ secrets: secrets.service, configuration }),
      (error) => error.code === "invalid_configuration" || error.code === "invalid_input",
      JSON.stringify(configuration),
    );
  }
  const provider = createIntegrationProvider({ secrets: secrets.service, configuration: CONFIG });
  providers.push(provider);
});

test("connect builds an exact PKCE authorization URL whose relay returns to this machine", async () => {
  const net = network();
  const secrets = memorySecrets();
  const provider = create(secrets, net);
  const { url, state, port } = await signIn(provider, net);
  assert.equal(url.origin + url.pathname, "https://its-pro.ucsd.edu/rest/oauth2/latest/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://broker.example/jira/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "WRITE");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(state, /^\d{4,5}\.[A-Za-z0-9_-]{43}$/u);
  assert.ok(port >= 1024);
  const exchange = net.calls.find((call) => call.key === `POST ${BROKER}/v1/token`);
  assert.deepEqual(Object.keys(exchange.body).sort(), ["code", "code_verifier", "grant_type"]);
  assert.equal(exchange.body.code, "code-1");
  assert.equal(
    createHash("sha256").update(exchange.body.code_verifier).digest("base64url"),
    url.searchParams.get("code_challenge"),
  );
  // The relay never receives the client secret from Harness; only the broker adds it.
  assert.ok(!JSON.stringify(exchange.body).includes("secret"));
  const stored = JSON.parse(secrets.values.get("oauth-credential"));
  assert.equal(stored.refreshToken, "refresh-1");
  assert.equal(stored.scope, "WRITE");
  assert.deepEqual(stored.capabilities, [READ, WRITE]);
  assert.equal(stored.account.key, "JIRAUSER1");
  assert.ok(!("accessToken" in stored));
  const status = await provider.status(lifecycle());
  assert.equal(status.state, "connected");
  assert.equal(status.accountLabel, "David Balderston");
  assert.deepEqual(status.grantedCapabilities, [READ, WRITE]);
  assert.ok(!JSON.stringify(status).includes("access-1"));
  assert.ok(!JSON.stringify(status).includes("refresh-1"));
  // The listener closes once the callback is answered.
  await assert.rejects(loopback(port, "/tritonai/jira/callback"));
});

test("read-only connections request READ and grant only read tools", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  const { url } = await signIn(provider, net, { capabilities: [READ] });
  assert.equal(url.searchParams.get("scope"), "READ");
  await assert.rejects(
    provider.invoke(
      "jira.changes.prepare_add_comment",
      { issueKey: "ITS-1", body: "hi" },
      invocation(),
    ),
    (error) => error.code === "capability_required",
  );
});

test("a narrower granted scope never widens to write", async () => {
  const net = network();
  const secrets = memorySecrets();
  const provider = create(secrets, net);
  net.on(`POST ${BROKER}/v1/token`, () => tokens(1, { scope: "READ" }));
  net.on(`GET ${API}/myself`, () => json(user()));
  const started = await provider.connect([READ, WRITE], lifecycle());
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  await loopback(Number(state.split(".")[0]), `/tritonai/jira/callback?state=${state}&code=c`);
  assert.equal((await settle(provider, started.flowId)).state, "connected");
  assert.deepEqual(JSON.parse(secrets.values.get("oauth-credential")).capabilities, [READ]);
});

test("the loopback callback rejects forged state, wrong paths, extra parameters, and replays", async () => {
  const net = network();
  const secrets = memorySecrets();
  const provider = create(secrets, net);
  net.on(`POST ${BROKER}/v1/token`, () => tokens(1));
  net.on(`GET ${API}/myself`, () => json(user()));
  const started = await provider.connect([READ], lifecycle());
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  const port = Number(state.split(".")[0]);
  const forged = `${port}.${"A".repeat(43)}`;
  for (const path of [
    `/tritonai/jira/callback?state=${forged}&code=c`,
    `/other?state=${state}&code=c`,
    `/tritonai/jira/callback?state=${state}&code=c&extra=1`,
    `/tritonai/jira/callback?state=${state}&state=${state}&code=c`,
    `/tritonai/jira/callback?state=${state}`,
    `/tritonai/jira/callback?state=${state}&code=c&error=access_denied`,
  ]) {
    assert.equal((await loopback(port, path)).status, 400, path);
  }
  assert.equal(
    (
      await loopback(port, `/tritonai/jira/callback?state=${state}&code=c`, {
        host: "evil.example",
      })
    ).status,
    400,
  );
  assert.equal(net.count(`POST ${BROKER}/v1/token`), 0);
  assert.equal((await provider.poll(started.flowId, lifecycle())).state, "pending");
  assert.equal((await loopback(port, `/tritonai/jira/callback?state=${state}&code=c`)).status, 200);
  assert.equal((await settle(provider, started.flowId)).state, "connected");
  assert.equal(net.count(`POST ${BROKER}/v1/token`), 1);
});

test("denied consent and rejected codes fail without storing anything", async () => {
  const net = network();
  const secrets = memorySecrets();
  const provider = create(secrets, net);
  const denied = await provider.connect([READ], lifecycle());
  const deniedState = new URL(denied.authorizationUrl).searchParams.get("state");
  await loopback(
    Number(deniedState.split(".")[0]),
    `/tritonai/jira/callback?state=${deniedState}&error=access_denied`,
  );
  const deniedResult = await settle(provider, denied.flowId);
  assert.equal(deniedResult.state, "failed");
  assert.match(deniedResult.message, /not allowed/u);

  net.on(`POST ${BROKER}/v1/token`, () => json({ error: "invalid_grant" }, 400));
  const rejected = await provider.connect([READ], lifecycle());
  const state = new URL(rejected.authorizationUrl).searchParams.get("state");
  await loopback(Number(state.split(".")[0]), `/tritonai/jira/callback?state=${state}&code=stale`);
  assert.equal((await settle(provider, rejected.flowId)).state, "failed");
  assert.equal(secrets.values.size, 0);
  assert.equal(net.count(`GET ${API}/myself`), 0);
});

test("a newer sign-in or disconnect cancels an unfinished one", async () => {
  const net = network();
  const secrets = memorySecrets();
  const provider = create(secrets, net);
  const first = await provider.connect([READ], lifecycle());
  const firstPort = Number(new URL(first.authorizationUrl).searchParams.get("state").split(".")[0]);
  const second = await provider.connect([READ], lifecycle());
  assert.equal((await provider.poll(first.flowId, lifecycle())).state, "expired");
  await assert.rejects(loopback(firstPort, "/tritonai/jira/callback"));
  const secondPort = Number(
    new URL(second.authorizationUrl).searchParams.get("state").split(".")[0],
  );
  await provider.disconnect(lifecycle());
  assert.equal((await provider.poll(second.flowId, lifecycle())).state, "expired");
  await assert.rejects(loopback(secondPort, "/tritonai/jira/callback"));
});

test("an aborted poll commits nothing even after the code was redeemed", async () => {
  const net = network();
  const secrets = memorySecrets();
  const provider = create(secrets, net);
  net.on(`POST ${BROKER}/v1/token`, () => tokens(1));
  net.on(`GET ${API}/myself`, () => json(user()));
  const started = await provider.connect([READ], lifecycle());
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  await loopback(Number(state.split(".")[0]), `/tritonai/jira/callback?state=${state}&code=c`);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(net.count(`GET ${API}/myself`), 1, "the code was redeemed before the poll");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const events = [];
  await assert.rejects(provider.poll(started.flowId, lifecycle(events, controller)));
  assert.deepEqual(events, []);
  assert.equal(secrets.values.has("oauth-credential"), false);
  assert.equal((await settle(provider, started.flowId)).state, "connected");
});

function storedCredential(overrides = {}) {
  return JSON.stringify({
    version: 2,
    refreshToken: "refresh-0",
    scope: "WRITE",
    capabilities: [READ, WRITE],
    account: { key: "JIRAUSER1", name: "dbalderston", displayName: "David Balderston" },
    updatedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  });
}

test("refresh rotates the token once under concurrency and commits before sending", async () => {
  const net = network();
  const secrets = memorySecrets({ "oauth-credential": storedCredential() });
  const provider = create(secrets, net);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const events = [];
  net.on(`POST ${BROKER}/v1/token`, async (call) => {
    events.push(`refresh:${call.body.refresh_token}`);
    await gate;
    return tokens(1);
  });
  const first = provider.prepare(lifecycle(events));
  const second = provider.prepare(lifecycle(events));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["beginCommit", "refresh:refresh-0"]);
  assert.equal(JSON.parse(secrets.values.get("oauth-credential")).refreshToken, "refresh-1");
  net.on(`GET ${API}/myself`, (call) => {
    assert.equal(call.init.headers.authorization, "Bearer access-1");
    return json(user());
  });
  const result = await provider.invoke("jira.me.get", {}, invocation());
  assert.equal(result.user.key, "JIRAUSER1");
  assert.ok(!JSON.stringify(result).includes("access-1"));
});

test("a rejected refresh asks the user to connect again without faulting", async () => {
  const net = network();
  const secrets = memorySecrets({ "oauth-credential": storedCredential() });
  const provider = create(secrets, net);
  net.on(`POST ${BROKER}/v1/token`, () => json({ error: "invalid_grant" }, 400));
  await provider.prepare(lifecycle());
  const status = await provider.status(lifecycle());
  assert.equal(status.state, "not_connected");
  assert.match(status.message, /expired or was revoked/u);
  await assert.rejects(
    provider.invoke("jira.me.get", {}, invocation()),
    (error) => error.code === "connection_required",
  );
  await provider.prepare(lifecycle());
  assert.equal(net.count(`POST ${BROKER}/v1/token`), 1);
  const reconnect = await signIn(provider, net, { n: 2 });
  assert.ok(reconnect);
  assert.equal((await provider.status(lifecycle())).state, "connected");
});

test("an unconfirmed refresh keeps the stored token and retries it", async () => {
  const net = network();
  const secrets = memorySecrets({ "oauth-credential": storedCredential() });
  const provider = create(secrets, net);
  net.on(`POST ${BROKER}/v1/token`, [
    () => {
      throw new TypeError("socket hang up");
    },
    () => json({ error: "upstream_unavailable" }, 502),
    () => tokens(1),
  ]);
  await provider.prepare(lifecycle());
  await assert.rejects(
    provider.invoke("jira.me.get", {}, invocation()),
    (error) => error.code === "authorization_unavailable" && error.retryable === true,
  );
  await provider.prepare(lifecycle());
  await provider.prepare(lifecycle());
  const sent = net.calls.filter((call) => call.key === `POST ${BROKER}/v1/token`);
  assert.deepEqual(
    sent.map((call) => call.body.refresh_token),
    ["refresh-0", "refresh-0", "refresh-0"],
  );
  assert.equal(JSON.parse(secrets.values.get("oauth-credential")).refreshToken, "refresh-1");
});

test("a rotated token that cannot be saved stays usable and is saved later", async () => {
  const net = network();
  let failing = true;
  const secrets = memorySecrets(
    { "oauth-credential": storedCredential() },
    { failSet: () => failing },
  );
  const provider = create(secrets, net);
  net.on(`POST ${BROKER}/v1/token`, () => tokens(1));
  await provider.prepare(lifecycle());
  assert.equal(JSON.parse(secrets.values.get("oauth-credential")).refreshToken, "refresh-0");
  assert.match((await provider.status(lifecycle())).message, /could not be saved yet/u);
  net.on(`GET ${API}/myself`, () => json(user()));
  await provider.invoke("jira.me.get", {}, invocation());
  failing = false;
  await provider.prepare(lifecycle());
  assert.equal(net.count(`POST ${BROKER}/v1/token`), 1);
  assert.equal(JSON.parse(secrets.values.get("oauth-credential")).refreshToken, "refresh-1");
});

test("disconnect removes all credentials, revokes previews, and allows reconnecting", async () => {
  const net = network();
  const secrets = memorySecrets({ "personal-access-token": "legacy" });
  const provider = create(secrets, net);
  assert.match((await provider.status(lifecycle())).message, /instead of personal access tokens/u);
  await signIn(provider, net);
  assert.equal(secrets.values.has("personal-access-token"), false);
  const preview = await prepareComment(provider, net);
  await provider.disconnect(lifecycle());
  assert.equal(secrets.values.size, 0);
  assert.equal((await provider.status(lifecycle())).state, "not_connected");
  await assert.rejects(
    provider.invoke(
      "jira.changes.apply",
      applyInput(preview),
      invocation([], { writeApproved: true }),
    ),
    (error) => error.code === "authorization_unavailable",
  );
  await signIn(provider, net, { n: 2 });
  await assert.rejects(
    provider.invoke(
      "jira.changes.apply",
      applyInput(preview),
      invocation([], { writeApproved: true }),
    ),
    (error) => error.code === "preview_required",
  );
});

const issue = (fields = {}) => ({
  id: "10001",
  key: "ITS-1",
  fields: {
    summary: "Printer is down",
    updated: "2026-10-09T10:00:00.000-0700",
    status: { id: "3", name: "In Progress" },
    ...fields,
  },
});

async function prepareComment(provider, net, input = {}) {
  net.on(`GET ${API}/issue/ITS-1`, () => json(issue()));
  return provider.invoke(
    "jira.changes.prepare_add_comment",
    { issueKey: "ITS-1", body: "Replaced the toner.", ...input },
    invocation(),
  );
}

const applyInput = (preview) => ({
  planId: preview.planId,
  previewHash: preview.previewHash,
  summary: preview.summary,
});

test("a prepared comment is applied once, only after approval and commit admission", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const preview = await prepareComment(provider, net);
  assert.equal(preview.status, "preview");
  assert.equal(preview.summary, 'Comment on ITS-1 "Printer is down": "Replaced the toner."');
  assert.equal(net.count(`POST ${API}/issue/ITS-1/comment`), 0);

  await assert.rejects(
    provider.invoke("jira.changes.apply", applyInput(preview), invocation()),
    (error) => error.code === "write_not_approved",
  );
  for (const tampered of [
    { ...applyInput(preview), summary: "Something else" },
    { ...applyInput(preview), previewHash: "0".repeat(64) },
  ]) {
    await assert.rejects(
      provider.invoke("jira.changes.apply", tampered, invocation([], { writeApproved: true })),
      (error) => error.code === "preview_required",
    );
  }
  const events = [];
  net.on(`POST ${API}/issue/ITS-1/comment`, (call) => {
    events.push("POST comment");
    assert.deepEqual(call.body, { body: "Replaced the toner." });
    return json({ id: "500" }, 201);
  });
  const result = await provider.invoke(
    "jira.changes.apply",
    applyInput(preview),
    invocation(events, { writeApproved: true }),
  );
  assert.equal(result.status, "applied");
  assert.equal(result.id, "500");
  assert.deepEqual(events, ["beginCommit", "POST comment"]);
  await assert.rejects(
    provider.invoke(
      "jira.changes.apply",
      applyInput(preview),
      invocation([], { writeApproved: true }),
    ),
    (error) => error.code === "preview_required",
  );
  assert.equal(net.count(`POST ${API}/issue/ITS-1/comment`), 1);
});

test("expired previews are refused before commit", async (t) => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const preview = await prepareComment(provider, net);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 11 * 60 * 1_000);
  const events = [];
  await assert.rejects(
    provider.invoke(
      "jira.changes.apply",
      applyInput(preview),
      invocation(events, { writeApproved: true }),
    ),
    (error) => error.code === "preview_required",
  );
  assert.deepEqual(events, []);
});

test("an item changed after preview is a conflict and nothing is sent", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  net.on(`GET ${API}/issue/ITS-1`, [
    () => json(issue()),
    () => json(issue({ updated: "2026-10-09T10:05:00.000-0700" })),
  ]);
  net.on(`GET ${API}/issue/ITS-1/editmeta`, () =>
    json({ fields: { summary: { name: "Summary", required: true } } }),
  );
  const preview = await provider.invoke(
    "jira.changes.prepare_update_issue",
    { issueKey: "ITS-1", summary: "Printer replaced" },
    invocation(),
  );
  assert.deepEqual(preview.preview.before, { summary: "Printer is down" });
  const events = [];
  await assert.rejects(
    provider.invoke(
      "jira.changes.apply",
      applyInput(preview),
      invocation(events, { writeApproved: true }),
    ),
    (error) => error.code === "conflict",
  );
  assert.deepEqual(events, []);
  assert.equal(net.count(`PUT ${API}/issue/ITS-1`), 0);
});

test("a lost write response is never replayed and blocks an identical blind retry", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const preview = await prepareComment(provider, net);
  net.on(`POST ${API}/issue/ITS-1/comment`, () => {
    throw new TypeError("socket hang up");
  });
  const result = await provider.invoke(
    "jira.changes.apply",
    applyInput(preview),
    invocation([], { writeApproved: true }),
  );
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.retryable, false);
  await assert.rejects(prepareComment(provider, net), (error) => {
    assert.equal(error.code, "unconfirmed_duplicate");
    assert.equal(error.details.operationId, result.operationId);
    return true;
  });
  const different = await prepareComment(provider, net, { body: "A different note." });
  assert.equal(different.status, "preview");
  const acknowledged = await prepareComment(provider, net, {
    afterUnconfirmedOperationId: result.operationId,
  });
  assert.equal(acknowledged.status, "preview");
  assert.equal(net.count(`POST ${API}/issue/ITS-1/comment`), 1);
});

test("Jira server errors after dispatch are unknown; validation refusals are settled", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const first = await prepareComment(provider, net);
  net.on(`POST ${API}/issue/ITS-1/comment`, [
    () => json({ errorMessages: ["Comment body is invalid."], errors: {} }, 400),
    () => new Response("oops", { status: 500 }),
  ]);
  const refused = await provider.invoke(
    "jira.changes.apply",
    applyInput(first),
    invocation([], { writeApproved: true }),
  );
  assert.equal(refused.status, "not_applied");
  assert.deepEqual(refused.jiraMessages, ["Comment body is invalid."]);
  const second = await prepareComment(provider, net);
  const unknown = await provider.invoke(
    "jira.changes.apply",
    applyInput(second),
    invocation([], { writeApproved: true }),
  );
  assert.equal(unknown.status, "outcome_unknown");
  await assert.rejects(
    prepareComment(provider, net),
    (error) => error.code === "unconfirmed_duplicate",
  );
});

test("previews do not survive reconnecting, including as another Jira account", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const preview = await prepareComment(provider, net);
  await signIn(provider, net, { account: user({ key: "JIRAUSER2", name: "someone" }), n: 2 });
  await assert.rejects(
    provider.invoke(
      "jira.changes.apply",
      applyInput(preview),
      invocation([], { writeApproved: true }),
    ),
    (error) => error.code === "preview_required",
  );
});

test("transitions are checked against what Jira offers this user", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  net.on(`GET ${API}/issue/ITS-1`, () => json(issue()));
  net.on(`GET ${API}/issue/ITS-1/transitions`, () =>
    json({
      transitions: [
        {
          id: "31",
          name: "Resolve",
          to: { id: "5", name: "Resolved" },
          fields: {
            resolution: {
              name: "Resolution",
              required: true,
              allowedValues: [
                { id: "1", name: "Fixed" },
                { id: "2", name: "Won't Fix" },
              ],
            },
          },
        },
      ],
    }),
  );
  await assert.rejects(
    provider.invoke(
      "jira.changes.prepare_transition",
      { issueKey: "ITS-1", transitionId: "99" },
      invocation(),
    ),
    (error) => error.code === "invalid_input" && error.details.available[0].id === "31",
  );
  await assert.rejects(
    provider.invoke(
      "jira.changes.prepare_transition",
      { issueKey: "ITS-1", transitionId: "31" },
      invocation(),
    ),
    (error) => error.code === "missing_required_fields",
  );
  await assert.rejects(
    provider.invoke(
      "jira.changes.prepare_transition",
      { issueKey: "ITS-1", transitionId: "31", resolution: "Done-ish" },
      invocation(),
    ),
    (error) => error.code === "invalid_input",
  );
  const preview = await provider.invoke(
    "jira.changes.prepare_transition",
    { issueKey: "ITS-1", transitionId: "31", resolution: "fixed", comment: "Toner replaced." },
    invocation(),
  );
  assert.equal(
    preview.summary,
    'Move ITS-1 "Printer is down" from "In Progress" to "Resolved" (Resolve), resolution "fixed", with comment "Toner replaced."',
  );
  net.on(`POST ${API}/issue/ITS-1/transitions`, (call) => {
    assert.deepEqual(call.body, {
      transition: { id: "31" },
      fields: { resolution: { id: "1" } },
      update: { comment: [{ add: { body: "Toner replaced." } }] },
    });
    return new Response(null, { status: 204 });
  });
  const result = await provider.invoke(
    "jira.changes.apply",
    applyInput(preview),
    invocation([], { writeApproved: true }),
  );
  assert.equal(result.status, "applied");
});

test("issue creation enforces create metadata and required fields before approval", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  net.on(`GET ${API}/issue/createmeta/ITS/issuetypes`, () =>
    json({ values: [{ id: "10002", name: "Task", subtask: false }] }),
  );
  net.on(`GET ${API}/issue/createmeta/ITS/issuetypes/10002`, () =>
    json({
      isLast: true,
      values: [
        { fieldId: "summary", name: "Summary", required: true },
        {
          fieldId: "priority",
          name: "Priority",
          required: false,
          allowedValues: [{ id: "2", name: "High" }],
        },
        {
          fieldId: "customfield_10100",
          name: "Campus",
          required: true,
          allowedValues: [{ id: "7", value: "La Jolla" }],
        },
      ],
    }),
  );
  const base = { projectKey: "ITS", issueTypeId: "10002", summary: "New printer" };
  await assert.rejects(
    provider.invoke("jira.changes.prepare_create_issue", base, invocation()),
    (error) =>
      error.code === "missing_required_fields" && error.message.includes("customfield_10100"),
  );
  await assert.rejects(
    provider.invoke(
      "jira.changes.prepare_create_issue",
      { ...base, labels: ["x"], customFields: { customfield_10100: { value: "La Jolla" } } },
      invocation(),
    ),
    (error) => error.code === "field_not_settable" && error.message.includes("labels"),
  );
  const preview = await provider.invoke(
    "jira.changes.prepare_create_issue",
    { ...base, priority: "High", customFields: { customfield_10100: { value: "La Jolla" } } },
    invocation(),
  );
  assert.equal(
    preview.summary,
    'Create Task in ITS: summary: "New printer"; priority: "High"; Campus (customfield_10100): {"value":"La Jolla"}',
  );
  net.on(`POST ${API}/issue`, (call) => {
    assert.deepEqual(call.body, {
      fields: {
        summary: "New printer",
        priority: { id: "2" },
        customfield_10100: { value: "La Jolla" },
        project: { key: "ITS" },
        issuetype: { id: "10002" },
      },
    });
    return json({ id: "10500", key: "ITS-42" }, 201);
  });
  const result = await provider.invoke(
    "jira.changes.apply",
    applyInput(preview),
    invocation([], { writeApproved: true }),
  );
  assert.equal(result.status, "applied");
  assert.equal(result.issueKey, "ITS-42");
});

test("inputs fail closed before any network access", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const before = net.calls.length;
  for (const [tool, input] of [
    ["jira.issues.get", { issueKey: "not a key" }],
    ["jira.issues.search", { jql: "x", maxResults: 51 }],
    ["jira.changes.prepare_add_comment", { issueKey: "ITS-1", body: "x", extra: 1 }],
    ["jira.changes.prepare_update_issue", { issueKey: "ITS-1" }],
    ["jira.changes.prepare_update_issue", { issueKey: "ITS-1", customFields: { summary: "x" } }],
    ["jira.changes.prepare_assign", { issueKey: "ITS-1" }],
    ["jira.changes.prepare_add_worklog", { issueKey: "ITS-1", timeSpent: "lots" }],
    [
      "jira.changes.prepare_link_issues",
      { linkType: "Blocks", inwardIssueKey: "ITS-1", outwardIssueKey: "its-1" },
    ],
    ["jira.changes.apply", { planId: "nope", previewHash: "x", summary: "s" }],
    ["jira.users.assignable", { query: "dav" }],
  ]) {
    await assert.rejects(
      provider.invoke(tool, input, invocation([], { writeApproved: true })),
      (error) => error.code === "invalid_input",
      tool,
    );
  }
  await assert.rejects(
    provider.invoke("jira.admin.anything", {}, invocation()),
    (error) => error.code === "tool_not_found",
  );
  assert.equal(net.calls.length, before);
});

test("reads are bounded projections and HTTP failures do not leak bodies", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  net.on(`POST ${API}/search`, (call) => {
    assert.equal(call.body.maxResults, 2);
    return json({
      startAt: 0,
      maxResults: 2,
      total: 3,
      issues: [issue(), issue({ summary: "Second" })],
    });
  });
  const search = await provider.invoke(
    "jira.issues.search",
    { jql: "project = ITS", maxResults: 2 },
    invocation(),
  );
  assert.equal(search.returned, 2);
  assert.equal(search.hasMore, true);
  assert.equal(search.issues[0].description, undefined);
  net.on(`GET ${API}/issue/ITS-2`, () => json({ errorMessages: ["secret internal detail"] }, 500));
  await assert.rejects(
    provider.invoke("jira.issues.get", { issueKey: "ITS-2" }, invocation()),
    (error) =>
      error.code === "http_error" && !JSON.stringify(error).includes("secret internal detail"),
  );
  net.on(`GET ${API}/issue/ITS-3`, () => json({}, 429, { "retry-after": "30" }));
  await assert.rejects(
    provider.invoke("jira.issues.get", { issueKey: "ITS-3" }, invocation()),
    (error) => error.code === "rate_limited" && error.details.retryAfterSeconds === 30,
  );
});

test("close is terminal and stops pending sign-ins", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  const started = await provider.connect([READ], lifecycle());
  const port = Number(new URL(started.authorizationUrl).searchParams.get("state").split(".")[0]);
  await provider.close();
  await assert.rejects(loopback(port, "/tritonai/jira/callback"));
  await assert.rejects(provider.status(lifecycle()), (error) => error.code === "provider_closed");
});

test("multi-line comments produce a one-line summary that still applies", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const preview = await prepareComment(provider, net, {
    body: "Replaced toner.\nAlso cleaned\tthe tray.",
  });
  assert.equal(
    preview.summary,
    'Comment on ITS-1 "Printer is down": "Replaced toner. Also cleaned the tray."',
  );
  net.on(`POST ${API}/issue/ITS-1/comment`, (call) => {
    assert.equal(call.body.body, "Replaced toner.\nAlso cleaned\tthe tray.");
    return json({ id: "501" }, 201);
  });
  const result = await provider.invoke(
    "jira.changes.apply",
    applyInput(preview),
    invocation([], { writeApproved: true }),
  );
  assert.equal(result.status, "applied");
});

test("editing a restricted comment keeps its visibility and shows it for approval", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const restricted = {
    id: "77",
    body: "Internal note",
    updated: "2026-10-09T10:00:00.000-0700",
    author: user(),
    visibility: { type: "role", value: "Developers" },
  };
  net.on(`GET ${API}/issue/ITS-1/comment/77`, [() => json(restricted), () => json(restricted)]);
  const preview = await provider.invoke(
    "jira.changes.prepare_update_comment",
    { issueKey: "ITS-1", commentId: "77", body: "Internal note, updated" },
    invocation(),
  );
  assert.match(preview.summary, /stays visible only to role "Developers"/u);
  net.on(`PUT ${API}/issue/ITS-1/comment/77`, (call) => {
    assert.deepEqual(call.body, {
      body: "Internal note, updated",
      visibility: { type: "role", value: "Developers" },
    });
    return json({ id: "77" });
  });
  const result = await provider.invoke(
    "jira.changes.apply",
    applyInput(preview),
    invocation([], { writeApproved: true }),
  );
  assert.equal(result.status, "applied");
});

test("approval summaries carry the values being written", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  net.on(`GET ${API}/issue/ITS-1`, () => json(issue()));
  net.on(`GET ${API}/issue/ITS-1/editmeta`, () =>
    json({ fields: { description: { name: "Description" }, customfield_5: { name: "Notes" } } }),
  );
  const preview = await provider.invoke(
    "jira.changes.prepare_update_issue",
    {
      issueKey: "ITS-1",
      description: "Send all badges to evil.example",
      customFields: { customfield_5: "x".repeat(400) },
    },
    invocation(),
  );
  assert.match(preview.summary, /description: "Send all badges to evil\.example"/u);
  assert.match(preview.summary, /Notes \(customfield_5\): "x{120}…" \(400 characters\)/u);
  assert.ok(preview.summary.length <= 590);
});

test("oversized changes are refused at preview, before any approval or commit", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  net.on(`GET ${API}/issue/ITS-1`, () => json(issue()));
  await assert.rejects(
    provider.invoke(
      "jira.changes.prepare_add_comment",
      { issueKey: "ITS-1", body: "界".repeat(30_000) },
      invocation(),
    ),
    (error) => error.code === "request_too_large",
  );
});

test("the duplicate guard survives reconnecting as the same account but not another", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const preview = await prepareComment(provider, net);
  net.on(`POST ${API}/issue/ITS-1/comment`, () => new Response("oops", { status: 502 }));
  const unknown = await provider.invoke(
    "jira.changes.apply",
    applyInput(preview),
    invocation([], { writeApproved: true }),
  );
  assert.equal(unknown.status, "outcome_unknown");
  await signIn(provider, net, { n: 2 });
  await assert.rejects(
    prepareComment(provider, net),
    (error) => error.code === "unconfirmed_duplicate",
  );
  await signIn(provider, net, { n: 3, account: user({ key: "JIRAUSER2", name: "someone" }) });
  assert.equal((await prepareComment(provider, net)).status, "preview");
});

test("abandoned previews never block new ones", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const first = await prepareComment(provider, net, { body: "note 0" });
  for (let index = 1; index <= 8; index += 1)
    await prepareComment(provider, net, { body: `note ${index}` });
  await assert.rejects(
    provider.invoke(
      "jira.changes.apply",
      applyInput(first),
      invocation([], { writeApproved: true }),
    ),
    (error) => error.code === "preview_required",
  );
});

test("link previews state the resulting sentence", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  net.on(`GET ${API}/issueLinkType`, () =>
    json({
      issueLinkTypes: [{ id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" }],
    }),
  );
  net.on(`GET ${API}/issue/ITS-1`, () => json(issue()));
  net.on(`GET ${API}/issue/ITS-2`, () => json(issue({ summary: "Second" })));
  const preview = await provider.invoke(
    "jira.changes.prepare_link_issues",
    { linkType: "blocks", inwardIssueKey: "ITS-1", outwardIssueKey: "ITS-2" },
    invocation(),
  );
  assert.equal(preview.summary, 'Link: ITS-1 blocks ITS-2 ("Blocks")');
});

test("two concurrent approvals of one preview send it once", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const preview = await prepareComment(provider, net);
  net.on(`POST ${API}/issue/ITS-1/comment`, () => json({ id: "500" }, 201));
  const results = await Promise.allSettled([
    provider.invoke(
      "jira.changes.apply",
      applyInput(preview),
      invocation([], { writeApproved: true }),
    ),
    provider.invoke(
      "jira.changes.apply",
      applyInput(preview),
      invocation([], { writeApproved: true }),
    ),
  ]);
  assert.deepEqual(results.map((result) => result.value?.status ?? result.reason.code).toSorted(), [
    "applied",
    "preview_required",
  ]);
  assert.equal(net.count(`POST ${API}/issue/ITS-1/comment`), 1);
});

test("an older identical preview cannot send after an unconfirmed outcome", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const first = await prepareComment(provider, net);
  const second = await prepareComment(provider, net);
  net.on(`POST ${API}/issue/ITS-1/comment`, () => {
    throw new TypeError("socket hang up");
  });
  const lost = await provider.invoke(
    "jira.changes.apply",
    applyInput(first),
    invocation([], { writeApproved: true }),
  );
  assert.equal(lost.status, "outcome_unknown");
  const events = [];
  await assert.rejects(
    provider.invoke(
      "jira.changes.apply",
      applyInput(second),
      invocation(events, { writeApproved: true }),
    ),
    (error) =>
      error.code === "unconfirmed_duplicate" && error.details.operationId === lost.operationId,
  );
  assert.deepEqual(events, []);
  assert.equal(net.count(`POST ${API}/issue/ITS-1/comment`), 1);
});

test("a disconnect while sign-in is starting cannot be outlived by that sign-in", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  const connecting = provider.connect([READ], lifecycle());
  await provider.disconnect(lifecycle());
  await assert.rejects(connecting, (error) => error.code === "cancelled");
});

test("a preparation that spans a reconnect is refused", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let reading;
  const read = new Promise((resolve) => (reading = resolve));
  net.on(`GET ${API}/issue/ITS-1`, async () => {
    reading();
    await gate;
    return json(issue());
  });
  const preparing = provider.invoke(
    "jira.changes.prepare_add_comment",
    { issueKey: "ITS-1", body: "Replaced the toner." },
    invocation(),
  );
  await read;
  await signIn(provider, net, { n: 2 });
  release();
  await assert.rejects(preparing, (error) => error.code === "preview_required");
});

test("values beyond a truncated allowed list are left for Jira to check", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const components = Array.from({ length: 150 }, (_, index) => ({
    id: String(index),
    name: `Team ${index}`,
  }));
  net.on(`GET ${API}/issue/ITS-1`, () => json(issue()));
  net.on(`GET ${API}/issue/ITS-1/editmeta`, () =>
    json({ fields: { components: { name: "Components", allowedValues: components } } }),
  );
  const preview = await provider.invoke(
    "jira.changes.prepare_update_issue",
    { issueKey: "ITS-1", components: ["Team 5", "Team 140"] },
    invocation(),
  );
  assert.equal(preview.status, "preview");
  net.on(`PUT ${API}/issue/ITS-1`, (call) => {
    assert.deepEqual(call.body.fields.components, [{ id: "5" }, { name: "Team 140" }]);
    return new Response(null, { status: 204 });
  });
  const result = await provider.invoke(
    "jira.changes.apply",
    applyInput(preview),
    invocation([], { writeApproved: true }),
  );
  assert.equal(result.status, "applied");
  net.on(`GET ${API}/issue/ITS-1/editmeta`, () =>
    json({ fields: { components: { name: "Components", allowedValues: components.slice(0, 3) } } }),
  );
  await assert.rejects(
    provider.invoke(
      "jira.changes.prepare_update_issue",
      { issueKey: "ITS-1", components: ["Team 140"] },
      invocation(),
    ),
    (error) => error.code === "invalid_input",
  );
});

test("later worklogs stay reachable when Jira ignores paging", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const worklogs = Array.from({ length: 30 }, (_, index) => ({
    id: String(index),
    author: user(),
    timeSpent: "1h",
  }));
  net.on(`GET ${API}/issue/ITS-1/worklog`, () => json({ startAt: 0, total: 30, worklogs }));
  const page = await provider.invoke(
    "jira.worklogs.list",
    { issueKey: "ITS-1", startAt: 25, maxResults: 10 },
    invocation(),
  );
  assert.deepEqual(
    page.worklogs.map((worklog) => worklog.id),
    ["25", "26", "27", "28", "29"],
  );
  assert.equal(page.startAt, 25);
  assert.equal(page.hasMore, false);
});

test("an identical append waiting for admission cannot send after another goes unconfirmed", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const first = await prepareComment(provider, net);
  const second = await prepareComment(provider, net);
  let admit;
  const admission = new Promise((resolve) => (admit = resolve));
  const held = {
    ...invocation([], { writeApproved: true }),
    async beginCommit() {
      await admission;
      return new AbortController().signal;
    },
  };
  const waiting = provider.invoke("jira.changes.apply", applyInput(second), held);
  net.on(`POST ${API}/issue/ITS-1/comment`, () => {
    throw new TypeError("socket hang up");
  });
  const lost = await provider.invoke(
    "jira.changes.apply",
    applyInput(first),
    invocation([], { writeApproved: true }),
  );
  assert.equal(lost.status, "outcome_unknown");
  admit();
  const blocked = await waiting;
  assert.equal(blocked.status, "not_applied");
  assert.equal(blocked.code, "unconfirmed_duplicate");
  assert.equal(blocked.earlierOperationId, lost.operationId);
  assert.equal(net.count(`POST ${API}/issue/ITS-1/comment`), 1);
});

test("previews show the full written text and their hash covers the exact request", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const prefix = "a".repeat(2_500);
  const one = await prepareComment(provider, net, { body: `${prefix} first` });
  const two = await prepareComment(provider, net, { body: `${prefix} second` });
  assert.equal(one.preview.body, `${prefix} first`);
  assert.notEqual(one.previewHash, two.previewHash);
});

test("transition screen fields the issue already has are not reported missing", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  net.on(`GET ${API}/issue/ITS-1`, (call) =>
    json(
      call.url.searchParams.get("fields").includes("customfield_9")
        ? issue({ customfield_9: null })
        : issue(),
    ),
  );
  const transition = (fields) =>
    json({ transitions: [{ id: "41", name: "Close", to: { id: "6", name: "Closed" }, fields }] });
  net.on(`GET ${API}/issue/ITS-1/transitions`, [
    () =>
      transition({
        summary: { name: "Summary", required: true },
        comment: { name: "Comment", required: true },
      }),
    () => transition({ customfield_9: { name: "Root cause", required: true } }),
  ]);
  const preview = await provider.invoke(
    "jira.changes.prepare_transition",
    { issueKey: "ITS-1", transitionId: "41", comment: "Done." },
    invocation(),
  );
  assert.equal(preview.status, "preview");
  await assert.rejects(
    provider.invoke(
      "jira.changes.prepare_transition",
      { issueKey: "ITS-1", transitionId: "41" },
      invocation(),
    ),
    (error) => error.code === "missing_required_fields" && /Root cause/u.test(error.message),
  );
});

test("a runaway loop of Jira calls is stopped locally before reaching Jira", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  net.on(`GET ${API}/issue/ITS-1`, () => json(issue()));
  let sent = 0;
  let refusal;
  for (let attempt = 0; attempt < 40 && !refusal; attempt += 1) {
    try {
      await provider.invoke("jira.issues.get", { issueKey: "ITS-1" }, invocation());
      sent += 1;
    } catch (error) {
      refusal = error;
    }
  }
  assert.equal(refusal?.code, "rate_limited");
  assert.ok(refusal.details.retryAfterSeconds >= 1);
  assert.ok(sent >= 15 && sent < 20, `sent ${sent}`);
  assert.equal(net.count(`GET ${API}/issue/ITS-1`), sent);
});

test("every request stands down while Jira asks to slow down, and identifies itself", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const preview = await prepareComment(provider, net);
  net.on(`GET ${API}/issue/ITS-2`, (call) => {
    assert.equal(call.init.headers["user-agent"], "TritonAI-Harness-Jira/2.0.0");
    return json({}, 503, { "retry-after": "120" });
  });
  await assert.rejects(
    provider.invoke("jira.issues.get", { issueKey: "ITS-2" }, invocation()),
    (error) => error.code === "http_error",
  );
  await assert.rejects(
    provider.invoke("jira.issues.get", { issueKey: "ITS-1" }, invocation()),
    (error) => error.code === "rate_limited" && error.details.retryAfterSeconds > 100,
  );
  const events = [];
  await assert.rejects(
    provider.invoke(
      "jira.changes.apply",
      applyInput(preview),
      invocation(events, { writeApproved: true }),
    ),
    (error) => error.code === "rate_limited",
  );
  assert.deepEqual(events, []);
  assert.equal(net.count(`POST ${API}/issue/ITS-1/comment`), 0);
});

test("at most two Jira requests run at once; the rest wait their turn", async () => {
  const net = network();
  const provider = create(memorySecrets(), net);
  await signIn(provider, net);
  const releases = [];
  let started = 0;
  net.on(`GET ${API}/issue/ITS-1`, async () => {
    started += 1;
    await new Promise((resolve) => releases.push(resolve));
    return json(issue());
  });
  const reads = Array.from({ length: 3 }, () =>
    provider.invoke("jira.issues.get", { issueKey: "ITS-1" }, invocation()),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 2);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 3);
  for (const release of releases) release();
  await Promise.all(reads);
});
