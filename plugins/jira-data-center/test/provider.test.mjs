import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationProvider } from "../dist/index.mjs";

const API_TOKEN = "jira-pat-fixture-0123456789abcdef";
const endpoint = "https://its-pro.ucsd.edu/rest/api/2";
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

function storedCredential(apiToken = API_TOKEN) {
  return JSON.stringify({
    version: 1,
    apiToken,
    capabilities: ["jira-data-center.read"],
  });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function user(overrides = {}) {
  return {
    name: "dbalderston",
    key: "dbalderston",
    displayName: "David Balderston",
    emailAddress: "fixture@example.invalid",
    active: true,
    timeZone: "America/Los_Angeles",
    locale: "en_US",
    ...overrides,
  };
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

function factory(secrets, fetchImplementation, configuration = {}) {
  globalThis.fetch = fetchImplementation;
  return createIntegrationProvider({ secrets, configuration });
}

async function connect(provider, events = []) {
  const first = await provider.connect(["jira-data-center.read"], lifecycle(events));
  return provider.connect(["jira-data-center.read"], lifecycle(events), {
    kind: "api_key",
    flowId: first.flowId,
    value: API_TOKEN,
  });
}

test("factory pins the exact UCSD HTTPS origin and rejects malformed contexts", () => {
  const secrets = memorySecrets();
  globalThis.fetch = async () => json(user());
  assert.throws(
    () =>
      createIntegrationProvider({
        secrets: secrets.service,
        configuration: { tenantUrl: "https://evil.example" },
      }),
    (error) => error.code === "invalid_configuration",
  );
  for (const tenantUrl of [
    "http://its-pro.ucsd.edu",
    "https://its-pro.ucsd.edu.evil.example",
    "https://its-pro.ucsd.edu:444",
    "https://user@its-pro.ucsd.edu",
    "https://its-pro.ucsd.edu/rest/api/2",
    "https://its-pro.ucsd.edu?next=http://127.0.0.1",
  ]) {
    assert.throws(
      () =>
        createIntegrationProvider({
          secrets: secrets.service,
          configuration: { tenantUrl },
        }),
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
    "jira-data-center",
  );
});

test("API-token lifecycle links setup, verifies remotely, and commits after host admission", async () => {
  const secrets = memorySecrets();
  const mock = sequence([json(user()), json(user())]);
  const provider = factory(secrets.service, mock.implementation);
  const events = [];
  const flow = await provider.connect(["jira-data-center.read"], lifecycle(events));
  assert.equal(flow.kind, "api_key");
  assert.equal(flow.setupUrl, "https://its-pro.ucsd.edu/secure/ViewPersonalAccessTokens.jspa");
  assert.deepEqual(flow.setupInstructions, [
    "Open token settings and sign in with your UC San Diego account if prompted.",
    "Select Create token, give it a recognizable name, choose an expiration, and copy the token before closing the dialog.",
    "Return here, paste the token below, and select Connect. TritonAI validates it against UCSD Jira before saving it.",
  ]);
  const result = await provider.connect(["jira-data-center.read"], lifecycle(events), {
    kind: "api_key",
    flowId: flow.flowId,
    value: API_TOKEN,
  });
  assert.equal(result.kind, "connected");
  assert.deepEqual(events, ["beginCommit"]);
  assert.deepEqual(secrets.calls, ["set:personal-access-token"]);
  assert.equal(JSON.parse(secrets.value()).apiToken, API_TOKEN);
  assert.deepEqual(await provider.status(lifecycle()), {
    state: "connected",
    accountLabel: "David Balderston",
    grantedCapabilities: ["jira-data-center.read"],
    message: null,
  });
  assert.equal(mock.requests[0].url, `${endpoint}/myself`);
  assert.equal(mock.requests[0].init.redirect, "error");
  assert.equal(mock.requests[0].init.headers.authorization, `Bearer ${API_TOKEN}`);
  assert.equal(mock.requests[0].init.method, "GET");
});

test("connection rejects bad grants, expired flows, auth failure, and abort before commit", async () => {
  const secrets = memorySecrets();
  const mock = sequence([json({ message: "denied" }, 401)]);
  const provider = factory(secrets.service, mock.implementation);
  await assert.rejects(
    () => provider.connect([], lifecycle()),
    (error) => error.code === "invalid_capabilities",
  );
  const flows = [];
  for (let index = 0; index < 9; index += 1) {
    flows.push(await provider.connect(["jira-data-center.read"], lifecycle()));
  }
  await assert.rejects(
    () =>
      provider.connect(["jira-data-center.read"], lifecycle(), {
        kind: "api_key",
        flowId: flows[0].flowId,
        value: API_TOKEN,
      }),
    (error) => error.code === "flow_expired",
  );
  await assert.rejects(
    () =>
      provider.connect(["jira-data-center.read"], lifecycle(), {
        kind: "api_key",
        flowId: flows.at(-1).flowId,
        value: API_TOKEN,
      }),
    (error) => error.code === "authentication_failed",
  );
  assert.equal(secrets.value(), null);

  const second = sequence([json(user())]);
  const provider2 = factory(secrets.service, second.implementation);
  const flow = await provider2.connect(["jira-data-center.read"], lifecycle());
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
      provider2.connect(["jira-data-center.read"], context, {
        kind: "api_key",
        flowId: flow.flowId,
        value: API_TOKEN,
      }),
    /host cancelled/u,
  );
  assert.deepEqual(events, ["beginCommit"]);
  assert.equal(secrets.value(), null);
});

test("credential write and removal recovery recognize after-write success", async () => {
  const secrets = memorySecrets(null, {
    failSetAfterWrite: true,
    failRemoveAfterWrite: true,
  });
  const provider = factory(secrets.service, async () => json(user()));
  await connect(provider);
  assert.notEqual(secrets.value(), null);
  const events = [];
  await provider.disconnect(lifecycle(events));
  assert.deepEqual(events, ["beginCommit"]);
  assert.equal(secrets.value(), null);

  const corrupt = memorySecrets('{"apiToken":"corrupt"}');
  const provider2 = factory(corrupt.service, async () => json(user()));
  const corruptEvents = [];
  await provider2.disconnect(lifecycle(corruptEvents));
  assert.deepEqual(corruptEvents, ["beginCommit"]);
  assert.deepEqual(corrupt.calls, ["get:personal-access-token", "remove:personal-access-token"]);
  assert.equal(corrupt.value(), null);
});

test("status reports absent, corrupt, and rejected credentials without exposing tokens", async () => {
  const absent = memorySecrets();
  const provider = factory(absent.service, async () => json(user()));
  assert.equal((await provider.status(lifecycle())).state, "not_connected");

  const corrupt = memorySecrets('{"apiToken":"secret"}');
  const provider2 = factory(corrupt.service, async () => json(user()));
  const corruptStatus = await provider2.status(lifecycle());
  assert.equal(corruptStatus.state, "error");
  assert.doesNotMatch(corruptStatus.message, /secret/u);

  const rejected = memorySecrets(storedCredential());
  const provider3 = factory(rejected.service, async () => json({ message: API_TOKEN }, 401));
  const status = await provider3.status(lifecycle());
  assert.equal(status.state, "not_connected");
  assert.deepEqual(status.grantedCapabilities, []);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(API_TOKEN, "u"));
});

test("fixed read tools use only reviewed REST operations and bounded projections", async () => {
  const secrets = memorySecrets(storedCredential());
  const issue = {
    id: "10001",
    key: "ITS-42",
    fields: {
      summary: "Fixture issue",
      description: "Detailed fixture description",
      status: { id: "1", name: "Open", extra: API_TOKEN },
      issuetype: { id: "2", name: "Task" },
      priority: { id: "3", name: "Medium" },
      assignee: user({ emailAddress: API_TOKEN }),
      reporter: user({ displayName: "Fixture Reporter" }),
      project: { id: "4", name: "ITS", key: "ITS" },
      resolution: null,
      created: "2026-09-01T10:00:00.000-0700",
      updated: "2026-09-01T11:00:00.000-0700",
      labels: ["fixture"],
      components: [{ id: "5", name: "Harness", description: API_TOKEN }],
      fixVersions: [{ id: "6", name: "1.0" }],
      versions: [],
      duedate: "2026-09-30",
    },
  };
  const responses = [
    json(user()),
    json([
      {
        id: "4",
        key: "ITS",
        name: "ITS Project",
        projectTypeKey: "software",
        archived: false,
        lead: user({ emailAddress: API_TOKEN }),
        projectCategory: { id: "7", name: "UCSD" },
      },
      { id: "8", key: "TWO", name: "Hidden by limit" },
    ]),
    json({ startAt: 0, maxResults: 25, total: 1, issues: [issue] }),
    json(issue),
    json({
      startAt: 0,
      maxResults: 25,
      total: 1,
      comments: [
        {
          id: "9",
          author: user(),
          updateAuthor: user(),
          body: "Fixture comment",
          created: "2026-09-01T10:00:00.000-0700",
          updated: "2026-09-01T10:30:00.000-0700",
          visibility: { type: "role", value: "Developers", extra: API_TOKEN },
        },
      ],
    }),
    json([
      {
        id: "summary",
        name: "Summary",
        custom: false,
        orderable: true,
        navigable: true,
        searchable: true,
        schema: { type: "string", system: "summary", extra: API_TOKEN },
      },
      { id: "customfield_10000", name: "Fixture custom field", custom: true },
    ]),
  ];
  const mock = sequence(responses);
  const provider = factory(secrets.service, mock.implementation);

  const me = await provider.invoke("jira.me.get", {}, invocation());
  assert.equal(me.user.displayName, "David Balderston");

  const projects = await provider.invoke("jira.projects.list", { limit: 1 }, invocation());
  assert.equal(projects.returned, 1);
  assert.equal(projects.truncated, true);
  assert.equal(projects.projects[0].key, "ITS");

  const search = await provider.invoke(
    "jira.issues.search",
    { jql: "project = ITS ORDER BY updated DESC" },
    invocation(),
  );
  assert.equal(search.issues[0].key, "ITS-42");
  assert.equal(Object.hasOwn(search.issues[0], "description"), false);

  const detail = await provider.invoke("jira.issues.get", { issueKey: "its-42" }, invocation());
  assert.equal(detail.issue.description, "Detailed fixture description");
  assert.equal(detail.issue.components[0].name, "Harness");

  const comments = await provider.invoke(
    "jira.comments.list",
    { issueKey: "ITS-42" },
    invocation(),
  );
  assert.equal(comments.comments[0].body, "Fixture comment");
  assert.equal(comments.hasMore, false);

  const fields = await provider.invoke(
    "jira.fields.list",
    { query: "summary", limit: 10 },
    invocation(),
  );
  assert.equal(fields.returned, 1);
  assert.equal(fields.fields[0].schema.system, "summary");

  assert.deepEqual(
    mock.requests.map((request) => request.url),
    [
      `${endpoint}/myself`,
      `${endpoint}/project`,
      `${endpoint}/search`,
      `${endpoint}/issue/ITS-42?fields=summary%2Cstatus%2Cissuetype%2Cpriority%2Cassignee%2Creporter%2Cproject%2Ccreated%2Cupdated%2Cresolution%2Clabels%2Cdescription%2Ccomponents%2CfixVersions%2Cversions%2Cduedate`,
      `${endpoint}/issue/ITS-42/comment?startAt=0&maxResults=25`,
      `${endpoint}/field`,
    ],
  );
  const searchRequest = mock.requests[2];
  assert.equal(searchRequest.init.method, "POST");
  assert.deepEqual(JSON.parse(searchRequest.init.body), {
    jql: "project = ITS ORDER BY updated DESC",
    startAt: 0,
    maxResults: 25,
    fields: [
      "summary",
      "status",
      "issuetype",
      "priority",
      "assignee",
      "reporter",
      "project",
      "created",
      "updated",
      "resolution",
      "labels",
    ],
  });
  assert.doesNotMatch(JSON.stringify({ projects, search, detail, comments, fields }), /jira-pat/u);
});

test("inputs fail closed before network access", async () => {
  const secrets = memorySecrets(storedCredential());
  let requests = 0;
  const provider = factory(secrets.service, async () => {
    requests += 1;
    return json(user());
  });
  const invalid = [
    ["jira.me.get", { extra: true }],
    ["jira.projects.list", { limit: 101 }],
    ["jira.issues.search", { jql: "   " }],
    ["jira.issues.search", { jql: "project = ITS\nOR project = TWO" }],
    ["jira.issues.get", { issueKey: "../../admin" }],
    ["jira.comments.list", { issueKey: "ITS-0" }],
    ["jira.fields.list", { query: "\u0000" }],
    ["jira.unknown", {}],
  ];
  for (const [toolName, input] of invalid) {
    await assert.rejects(
      () => provider.invoke(toolName, input, invocation()),
      (error) => error.code === "invalid_input" || error.code === "tool_not_found",
    );
  }
  assert.equal(requests, 0);
});

test("empty issue descriptions and comment bodies remain valid Jira text", async () => {
  const secrets = memorySecrets(storedCredential());
  const issue = {
    id: "10001",
    key: "ITS-42",
    fields: {
      summary: "Fixture issue",
      description: "",
      status: null,
      issuetype: null,
      priority: null,
      assignee: null,
      reporter: null,
      project: null,
      resolution: null,
      created: null,
      updated: null,
      labels: [],
      components: [],
      fixVersions: [],
      versions: [],
      duedate: null,
    },
  };
  const mock = sequence([
    json(issue),
    json({
      startAt: 0,
      maxResults: 25,
      total: 1,
      comments: [{ id: "9", body: "" }],
    }),
  ]);
  const provider = factory(secrets.service, mock.implementation);
  const detail = await provider.invoke("jira.issues.get", { issueKey: "ITS-42" }, invocation());
  const comments = await provider.invoke(
    "jira.comments.list",
    { issueKey: "ITS-42" },
    invocation(),
  );
  assert.equal(detail.issue.description, "");
  assert.equal(comments.comments[0].body, "");
});

test("HTTP failures are bounded, classified, and do not disclose remote bodies", async () => {
  const cases = [
    [json({ message: API_TOKEN }, 401), "authentication_failed"],
    [json({ message: API_TOKEN }, 403), "permission_denied"],
    [json({ message: API_TOKEN }, 404), "not_found"],
    [json({ message: API_TOKEN }, 429, { "retry-after": "12" }), "rate_limited"],
    [json({ message: API_TOKEN }, 503), "http_error"],
    [
      new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
      "invalid_response",
    ],
  ];
  for (const [response, code] of cases) {
    const secrets = memorySecrets(storedCredential());
    const provider = factory(secrets.service, async () => response);
    await assert.rejects(
      () => provider.invoke("jira.me.get", {}, invocation()),
      (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(API_TOKEN, "u"));
        if (code === "rate_limited") {
          assert.equal(error.details.retryAfterSeconds, 12);
        }
        return true;
      },
    );
  }

  const oversized = memorySecrets(storedCredential());
  const oversizedProvider = factory(oversized.service, async () =>
    json({}, 200, { "content-length": String(2 * 1024 * 1024 + 1) }),
  );
  await assert.rejects(
    () => oversizedProvider.invoke("jira.me.get", {}, invocation()),
    (error) => error.code === "response_too_large",
  );
});

test("read invocation does not cross the write gate and close is terminal", async () => {
  const secrets = memorySecrets(storedCredential());
  const provider = factory(secrets.service, async () => json(user()));
  const events = [];
  const result = await provider.invoke("jira.me.get", {}, invocation(events));
  assert.equal(result.user.name, "dbalderston");
  assert.deepEqual(events, []);
  await provider.close();
  await provider.close();
  await assert.rejects(
    () => provider.status(lifecycle()),
    (error) => error.code === "provider_closed",
  );
});
