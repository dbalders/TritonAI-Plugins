import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationProvider } from "../dist/index.mjs";

const API_KEY = "eyJhbGciOiJIUzI1NiJ9.fixture.signature";
const APP_ID = "5d5f337395a039001e48a649";
const DOCUMENT_ID = "5f6a389d77d701400f543a29";
const endpoint = "https://ucsd.kualibuild.com/app/api/v0/graphql";
const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

function memorySecrets(initial = null, options = {}) {
  let value = initial;
  const calls = [];
  return {
    calls,
    service: {
      async get(name) {
        calls.push(`get:${name}`);
        if (options.failGet) throw new Error("fixture get failure");
        return value;
      },
      async set(name, next) {
        calls.push(`set:${name}`);
        value = next;
        if (options.failSetAfterWrite) throw new Error("fixture set failure");
      },
      async remove(name) {
        calls.push(`remove:${name}`);
        value = null;
        if (options.failRemoveAfterWrite) throw new Error("fixture remove failure");
      },
    },
    value: () => value,
  };
}

function storedCredential(apiKey = API_KEY) {
  return JSON.stringify({ version: 1, apiKey, capabilities: ["kuali-build.read"] });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sequence(responses) {
  const requests = [];
  let index = 0;
  const implementation = async (input, init) => {
    requests.push({ url: String(input), init });
    const response = responses[index++];
    if (response instanceof Error) throw response;
    if (typeof response === "function") return response(input, init);
    if (!response) throw new Error("unexpected fixture request");
    return response;
  };
  return { implementation, requests };
}

function lifecycle(events = []) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    async beginCommit() {
      events.push("beginCommit");
      return controller.signal;
    },
  };
}

function invocation(events = []) {
  return { ...lifecycle(events), writeApproved: false };
}

function factory(_t, secrets, fetchImplementation, configuration = {}) {
  globalThis.fetch = fetchImplementation;
  return createIntegrationProvider({ secrets, configuration });
}

async function connect(provider, events = []) {
  const first = await provider.connect(["kuali-build.read"], lifecycle(events));
  return provider.connect(["kuali-build.read"], lifecycle(events), {
    kind: "api_key",
    flowId: first.flowId,
    value: API_KEY,
  });
}

test("factory pins the exact UCSD HTTPS origin and rejects malformed contexts", () => {
  const secrets = memorySecrets();
  globalThis.fetch = async () => json({ data: { apps: [] } });
  assert.throws(
    () =>
      createIntegrationProvider({
        secrets: secrets.service,
        configuration: { tenantUrl: "https://evil.example" },
      }),
    (error) => error.code === "invalid_configuration",
  );
  for (const tenantUrl of [
    "http://ucsd.kualibuild.com",
    "https://ucsd.kualibuild.com.evil.example",
    "https://ucsd.kualibuild.com:444",
    "https://user@ucsd.kualibuild.com",
    "https://ucsd.kualibuild.com/app/api/v0/graphql",
    "https://ucsd.kualibuild.com?next=http://127.0.0.1",
  ]) {
    assert.throws(
      () => createIntegrationProvider({ secrets: secrets.service, configuration: { tenantUrl } }),
      (error) => error.code === "invalid_configuration",
    );
  }
  assert.throws(
    () =>
      createIntegrationProvider({
        secrets: secrets.service,
        configuration: JSON.parse('{"__proto__":null}'),
      }),
    (error) => error.code === "invalid_input",
  );
  assert.equal(
    createIntegrationProvider({ secrets: secrets.service, configuration: {} }).id,
    "kuali-build",
  );
});

test("lifecycle contexts require commit admission while read invocation does not", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const provider = factory(t, secrets.service, async () => json({ data: { apps: [] } }));
  const signal = new AbortController().signal;
  await assert.rejects(
    () => provider.connect(["kuali-build.read"], { signal }),
    (error) => error.code === "invalid_context",
  );
  await assert.rejects(
    () => provider.disconnect({ signal }),
    (error) => error.code === "invalid_context",
  );
  assert.deepEqual(
    await provider.invoke("kuali-build.apps.list", {}, { signal, writeApproved: false }),
    { apps: [], returned: 0, truncated: false },
  );
});

test("API-key lifecycle validates remotely and commits only after host admission", async (t) => {
  const secrets = memorySecrets();
  const mock = sequence([json({ data: { apps: [] } }), json({ data: { apps: [] } })]);
  const provider = factory(t, secrets.service, mock.implementation);
  const events = [];
  const flow = await provider.connect(["kuali-build.read"], lifecycle(events));
  assert.equal(flow.setupUrl, "https://ucsd.kualibuild.com/build/space/favorites/account/api-keys");
  assert.deepEqual(flow.setupInstructions, [
    "Open API key settings and sign in with your UC San Diego account if prompted.",
    "Create a new API key and copy the full key when Kuali displays it.",
    "Return here, paste the key below, and select Connect. TritonAI validates it against the UCSD tenant before saving it.",
  ]);
  const result = await provider.connect(["kuali-build.read"], lifecycle(events), {
    kind: "api_key",
    flowId: flow.flowId,
    value: API_KEY,
  });
  assert.equal(result.kind, "connected");
  assert.deepEqual(events, ["beginCommit"]);
  assert.deepEqual(secrets.calls, ["set:api-key"]);
  assert.equal(JSON.parse(secrets.value()).apiKey, API_KEY);
  assert.deepEqual(await provider.status(lifecycle()), {
    state: "connected",
    accountLabel: "UC San Diego Kuali Build",
    grantedCapabilities: ["kuali-build.read"],
    message: null,
  });
  assert.equal(mock.requests[0].url, endpoint);
  assert.equal(mock.requests[0].init.redirect, "error");
  assert.equal(mock.requests[0].init.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(mock.requests[0].init.method, "POST");
});

test("connection rejects bad grants, bad flows, auth failure, and abort before commit", async (t) => {
  const secrets = memorySecrets();
  const mock = sequence([json({ error: { message: "Unauthorized" } }, 401)]);
  const provider = factory(t, secrets.service, mock.implementation);
  await assert.rejects(
    () => provider.connect([], lifecycle()),
    (error) => error.code === "invalid_capabilities",
  );
  const flows = [];
  for (let index = 0; index < 9; index += 1) {
    flows.push(await provider.connect(["kuali-build.read"], lifecycle()));
  }
  await assert.rejects(
    () =>
      provider.connect(["kuali-build.read"], lifecycle(), {
        kind: "api_key",
        flowId: flows[0].flowId,
        value: API_KEY,
      }),
    (error) => error.code === "flow_expired",
  );
  const flow = flows.at(-1);
  await assert.rejects(
    () =>
      provider.connect(["kuali-build.read"], lifecycle(), {
        kind: "api_key",
        flowId: flow.flowId,
        value: API_KEY,
      }),
    (error) => error.code === "authentication_failed",
  );
  assert.equal(secrets.value(), null);

  const mock2 = sequence([json({ data: { apps: [] } })]);
  const provider2 = factory(t, secrets.service, mock2.implementation);
  const flow2 = await provider2.connect(["kuali-build.read"], lifecycle());
  const controller = new AbortController();
  const events = [];
  const context = {
    signal: controller.signal,
    async beginCommit() {
      events.push("beginCommit");
      controller.abort(new Error("host cancelled"));
      return controller.signal;
    },
  };
  await assert.rejects(
    () =>
      provider2.connect(["kuali-build.read"], context, {
        kind: "api_key",
        flowId: flow2.flowId,
        value: API_KEY,
      }),
    /host cancelled/u,
  );
  assert.deepEqual(events, ["beginCommit"]);
  assert.equal(secrets.value(), null);
});

test("credential write/removal recovery recognizes after-write success", async (t) => {
  const secrets = memorySecrets(null, { failSetAfterWrite: true, failRemoveAfterWrite: true });
  const mock = sequence([json({ data: { apps: [] } })]);
  const provider = factory(t, secrets.service, mock.implementation);
  await connect(provider);
  assert.notEqual(secrets.value(), null);
  const events = [];
  await provider.disconnect(lifecycle(events));
  assert.deepEqual(events, ["beginCommit"]);
  assert.equal(secrets.value(), null);

  const corrupt = memorySecrets('{"apiKey":"corrupt"}');
  const provider2 = factory(t, corrupt.service, async () => json({ data: { apps: [] } }));
  const corruptEvents = [];
  await provider2.disconnect(lifecycle(corruptEvents));
  assert.deepEqual(corruptEvents, ["beginCommit"]);
  assert.deepEqual(corrupt.calls, ["get:api-key", "remove:api-key"]);
  assert.equal(corrupt.value(), null);
});

test("status reports absent, corrupt, and rejected credentials without exposing keys", async (t) => {
  const absent = memorySecrets();
  const provider = factory(t, absent.service, async () => json({ data: { apps: [] } }));
  assert.equal((await provider.status(lifecycle())).state, "not_connected");

  const corrupt = memorySecrets('{"apiKey":"secret"}');
  const provider2 = factory(t, corrupt.service, async () => json({ data: { apps: [] } }));
  const corruptStatus = await provider2.status(lifecycle());
  assert.equal(corruptStatus.state, "error");
  assert.doesNotMatch(corruptStatus.message, /secret/u);

  const rejected = memorySecrets(storedCredential());
  const provider3 = factory(t, rejected.service, async () => json({ message: API_KEY }, 401));
  const status = await provider3.status(lifecycle());
  assert.equal(status.state, "not_connected");
  assert.deepEqual(status.grantedCapabilities, []);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(API_KEY.replaceAll(".", "\\."), "u"));
});

test("fixed read tools emit only reviewed GraphQL operations and never cross the write gate", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const responses = [
    json({
      data: {
        apps: [
          { id: APP_ID, name: "Travel" },
          { id: "000000000000000000000000", name: "Hidden by limit" },
        ],
      },
    }),
    json({ data: { app: { id: APP_ID, name: "Travel" } } }),
    json({
      data: {
        app: {
          id: APP_ID,
          name: "Travel",
          formVersion: {
            schema: Array.from({ length: 501 }, (_, index) => ({
              formKey: `data.field${index}`,
              label: index === 0 ? "Name" : `Field ${index}`,
            })),
          },
        },
      },
    }),
    json({
      data: {
        app: {
          id: APP_ID,
          name: "Travel",
          documentConnection: {
            totalCount: 1,
            edges: [{ node: { id: DOCUMENT_ID, data: {}, meta: { workflowStatus: "Complete" } } }],
            pageInfo: { hasNextPage: false, hasPreviousPage: false, skip: 0, limit: 25 },
          },
        },
      },
    }),
    json({
      data: {
        document: { id: DOCUMENT_ID, data: { name: "Ada" }, meta: { workflowStatus: "Complete" } },
      },
    }),
    json({
      data: {
        usersConnection: {
          edges: [{ node: { id: APP_ID, displayName: "Ada Lovelace", email: "ada@ucsd.edu" } }],
        },
      },
    }),
    json({
      data: {
        document: {
          id: DOCUMENT_ID,
          meta: {
            workflowStatus: "In Progress",
            workflowData: { step: "Dean" },
            submittedAt: 1,
            updatedAt: 2,
          },
        },
      },
    }),
  ];
  const mock = sequence(responses);
  const provider = factory(t, secrets.service, mock.implementation);
  const events = [];
  const apps = await provider.invoke("kuali-build.apps.list", { limit: 1 }, invocation(events));
  assert.equal(apps.apps[0].name, "Travel");
  assert.equal(apps.returned, 1);
  assert.equal(apps.truncated, true);
  assert.equal(
    (await provider.invoke("kuali-build.apps.get", { appId: APP_ID }, invocation(events))).app.id,
    APP_ID,
  );
  const schema = await provider.invoke(
    "kuali-build.forms.schema",
    { appId: APP_ID },
    invocation(events),
  );
  assert.equal(schema.fields[0].label, "Name");
  assert.equal(schema.fields.length, 500);
  assert.equal(schema.fieldCount, 501);
  assert.equal(schema.truncated, true);
  const listed = await provider.invoke(
    "kuali-build.documents.list",
    { appId: APP_ID, workflowStatus: "Complete", updatedAfter: 1 },
    invocation(events),
  );
  assert.equal(listed.totalCount, 1);
  assert.equal(
    (
      await provider.invoke(
        "kuali-build.documents.get",
        { documentId: DOCUMENT_ID },
        invocation(events),
      )
    ).document.data.name,
    "Ada",
  );
  assert.equal(
    (
      await provider.invoke(
        "kuali-build.users.lookup",
        { query: "ada@ucsd.edu" },
        invocation(events),
      )
    ).users[0].displayName,
    "Ada Lovelace",
  );
  assert.equal(
    (
      await provider.invoke(
        "kuali-build.workflows.status",
        { documentId: DOCUMENT_ID },
        invocation(events),
      )
    ).document.workflowData.step,
    "Dean",
  );
  assert.deepEqual(events, []);
  for (const request of mock.requests) {
    assert.equal(request.url, endpoint);
    const body = JSON.parse(request.init.body);
    assert.match(body.query, /^query KualiBuild/u);
    assert.doesNotMatch(body.query, /mutation/u);
    assert.deepEqual(Object.keys(body).sort(), ["query", "variables"]);
  }
  const listVariables = JSON.parse(mock.requests[3].init.body).variables;
  assert.deepEqual(listVariables.fields, {
    type: "AND",
    operators: [
      { field: "meta.workflowStatus", type: "IS", value: "Complete" },
      { field: "meta.updatedAt", type: "RANGE", min: "1" },
    ],
  });
  assert.deepEqual(JSON.parse(mock.requests[5].init.body).variables, {
    query: "ada@ucsd.edu",
    limit: 51,
  });
  const workflowRequest = JSON.parse(mock.requests[6].init.body);
  assert.deepEqual(workflowRequest.variables, { id: DOCUMENT_ID });
  assert.doesNotMatch(workflowRequest.query, /\bdata\b/u);
});

test("strict input rejects exotic objects, extra keys, pollution keys, and bounds", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const provider = factory(t, secrets.service, async () => json({ data: { apps: [] } }));
  const cases = [
    ["kuali-build.apps.list", []],
    ["kuali-build.apps.list", new Date()],
    ["kuali-build.apps.list", { extra: true }],
    ["kuali-build.apps.list", { limit: 101 }],
    ["kuali-build.apps.get", { appId: "../../etc/passwd" }],
    ["kuali-build.documents.list", { appId: APP_ID, limit: 51 }],
    ["kuali-build.documents.list", { appId: APP_ID, skip: -1 }],
    ["kuali-build.documents.list", { appId: APP_ID, query: "\u0000" }],
    ["kuali-build.users.lookup", { query: " ".repeat(2) }],
  ];
  const accessor = {};
  Object.defineProperty(accessor, "appId", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  cases.push(["kuali-build.apps.get", accessor]);
  const polluted = JSON.parse('{"__proto__":{"admin":true}}');
  cases.push(["kuali-build.apps.list", polluted]);
  for (const [tool, input] of cases) {
    await assert.rejects(
      () => provider.invoke(tool, input, invocation()),
      (error) => error.code === "invalid_input",
    );
  }
  await assert.rejects(
    () => provider.invoke("kuali-build.graphql", { query: "query { apps { id } }" }, invocation()),
    (error) => error.code === "tool_not_found",
  );
});

test("HTTP, redirect, content-type, network, and rate-limit failures are bounded", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const redirected = json({ data: { apps: [] } });
  Object.defineProperty(redirected, "url", { value: "https://evil.example/graphql" });
  const cases = [
    [redirected, "redirect_rejected", false],
    [new Response("ok", { headers: { "content-type": "text/plain" } }), "invalid_response", false],
    [json({}, 429, { "retry-after": "17" }), "rate_limited", true],
    [json({}, 503), "http_error", true],
    [new Error(`network ${API_KEY}`), "network_error", true],
  ];
  for (const [response, code, retryable] of cases) {
    const provider = factory(t, secrets.service, sequence([response]).implementation);
    await assert.rejects(
      () => provider.invoke("kuali-build.apps.list", {}, invocation()),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(API_KEY.replaceAll(".", "\\."), "u"));
        if (code === "rate_limited") assert.equal(error.details.retryAfterSeconds, 17);
        return true;
      },
    );
  }
});

test("GraphQL errors reject partial data and redact server-controlled messages", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const provider = factory(t, secrets.service, async () =>
    json({
      data: { apps: [{ id: APP_ID, name: "must not escape" }] },
      errors: [
        {
          message: `Bearer ${API_KEY}`,
          path: ["apps", 0],
          extensions: { code: "INTERNAL_SERVER_ERROR", stacktrace: [API_KEY] },
        },
      ],
    }),
  );
  await assert.rejects(
    () => provider.invoke("kuali-build.apps.list", {}, invocation()),
    (error) => {
      assert.equal(error.code, "graphql_error");
      assert.deepEqual(error.details, {
        codes: ["INTERNAL_SERVER_ERROR"],
        paths: ["apps.0"],
      });
      assert.doesNotMatch(JSON.stringify(error), new RegExp(API_KEY.replaceAll(".", "\\."), "u"));
      assert.doesNotMatch(JSON.stringify(error), /must not escape/u);
      return true;
    },
  );
});

test("GraphQL authentication codes request reconnection without exposing partial data", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const provider = factory(t, secrets.service, async () =>
    json({
      data: { apps: [{ id: APP_ID, name: "must not escape" }] },
      errors: [{ message: API_KEY, extensions: { code: "FORBIDDEN" } }],
    }),
  );
  await assert.rejects(
    () => provider.invoke("kuali-build.apps.list", {}, invocation()),
    (error) => {
      assert.equal(error.code, "authentication_failed");
      assert.doesNotMatch(JSON.stringify(error), new RegExp(API_KEY.replaceAll(".", "\\."), "u"));
      assert.doesNotMatch(JSON.stringify(error), /must not escape/u);
      return true;
    },
  );
});

test("response byte, depth, breadth, prototype, UTF-8, and envelope limits fail closed", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 40; index += 1) cursor = cursor.next = {};
  const broad = Object.fromEntries(
    Array.from({ length: 1_001 }, (_, index) => [`k${index}`, index]),
  );
  const cases = [
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024 + 1),
      },
    }),
    json({ data: { apps: deep } }),
    json({ data: { apps: broad } }),
    new Response('{"data":{"__proto__":{}}}', { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    json({ extensions: {} }),
  ];
  for (const response of cases) {
    const provider = factory(t, secrets.service, sequence([response]).implementation);
    await assert.rejects(
      () => provider.invoke("kuali-build.apps.list", {}, invocation()),
      (error) => ["response_too_large", "invalid_response"].includes(error.code),
    );
  }
});

test("caller abort and provider close terminate deterministically", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const provider = factory(t, secrets.service, async (_input, init) => {
    await new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = provider.invoke(
    "kuali-build.apps.list",
    {},
    { ...invocation(), signal: controller.signal },
  );
  controller.abort(new Error("caller stopped"));
  await assert.rejects(pending, /caller stopped/u);
  await provider.close();
  await provider.close();
  await assert.rejects(
    () => provider.invoke("kuali-build.apps.list", {}, invocation()),
    (error) => error.code === "provider_closed",
  );
});

test("request timeout is normalized and retryable", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const provider = factory(t, secrets.service, async (_input, init) => {
    await new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 1, ...args);
  try {
    await assert.rejects(
      () => provider.invoke("kuali-build.apps.list", {}, invocation()),
      (error) => error.code === "request_timeout" && error.retryable === true,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("request timeout remains active while a response body is streaming", async (t) => {
  const secrets = memorySecrets(storedCredential());
  const provider = factory(t, secrets.service, async (_input, init) => {
    const body = new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason), {
          once: true,
        });
      },
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
  });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 1, ...args);
  try {
    await assert.rejects(
      () => provider.invoke("kuali-build.apps.list", {}, invocation()),
      (error) => error.code === "request_timeout" && error.retryable === true,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
