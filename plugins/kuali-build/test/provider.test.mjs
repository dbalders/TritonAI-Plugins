import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../../../tests/fixtures/provider.mjs";
import { sha256 } from "../../../tests/fixtures/broker-host.mjs";

const APP = "5d5f337395a039001e48a649";
const DOC = "5f6a389d77d701400f543a29";
const ACTION = "6402959d200606e80fe6f20d";
const app = { id: APP, name: "Test app" };
const action = { id: ACTION, appId: APP, document: { id: DOC } };
const update = {
  documentId: DOC,
  expectedUpdatedAt: "123",
  confirmUpdate: true,
  data: { "data.name": "approved" },
};

const reads = [
  [
    "apps.list",
    { limit: 1 },
    { apps: [app, { ...app, id: DOC }] },
    { apps: [app], returned: 1, truncated: true },
    {},
  ],
  ["apps.get", { appId: APP.toUpperCase() }, { app }, { app }, { id: APP }],
  [
    "forms.schema",
    { appId: APP },
    { app: { ...app, formVersion: { schema: [{ formKey: "name", label: "Name" }] } } },
    {
      app,
      fields: [{ formKey: "name", label: "Name" }],
      fieldCount: 1,
      published: true,
      truncated: false,
    },
    { id: APP },
  ],
  [
    "documents.list",
    { appId: APP },
    {
      app: {
        ...app,
        documentConnection: {
          totalCount: 1,
          edges: [{ node: { id: DOC } }],
          pageInfo: { hasNextPage: false, hasPreviousPage: false, skip: 0, limit: 25 },
        },
      },
    },
    {
      app,
      documents: [{ id: DOC }],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, skip: 0, limit: 25 },
      totalCount: 1,
      truncated: false,
    },
    { appId: APP, skip: 0, limit: 25, sort: ["meta.updatedAt"], query: "", fields: null },
  ],
  [
    "documents.get",
    { documentId: DOC },
    { document: { id: DOC, data: { name: "Test" }, meta: { updatedAt: 123 } } },
    { document: { id: DOC, data: { name: "Test" }, meta: { updatedAt: 123 } } },
    { id: DOC },
  ],
  [
    "documents.drafts.resolve",
    { actionId: ACTION },
    { action },
    { action: { actionId: ACTION, appId: APP, documentId: DOC } },
    { actionId: ACTION },
  ],
  [
    "users.lookup",
    { query: "Test" },
    { usersConnection: { edges: [{ node: { id: "user", displayName: "Test" } }] } },
    {
      users: [
        {
          id: "user",
          displayName: "Test",
          email: null,
          username: null,
          firstName: null,
          lastName: null,
          schoolId: null,
        },
      ],
      returned: 1,
      truncated: false,
    },
    { query: "Test", limit: 51 },
  ],
  [
    "workflows.status",
    { documentId: DOC },
    { document: { id: DOC, meta: { workflowStatus: "Draft", updatedAt: 123 } } },
    {
      document: {
        id: DOC,
        workflowStatus: "Draft",
        workflowData: null,
        submittedAt: null,
        updatedAt: 123,
      },
    },
    { id: DOC },
  ],
];
for (const [name, input, response, expected, variables] of reads) {
  test(`broker-only ${name} preserves projection, exact input binding and reviewed query`, async () => {
    const requests = [];
    const { host, channel, provider } = await fixture("kuali-build", {
      transport: async (request) => {
        requests.push(request);
        return response;
      },
    });
    assert.deepEqual(await host.invoke(channel, provider, `kuali-build.${name}`, input), expected);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].origin, "https://ucsd.kualibuild.com");
    assert.equal(requests[0].path, "/app/api/v0/graphql");
    assert.match(requests[0].document, /^query /u);
    assert.deepEqual(requests[0].variables, variables);
    assert.equal(host.events.length, 0);
  });
}

test("all three writes bind host-owned preconditions and exact mutation payloads before commit", async () => {
  const cases = [
    [
      "documents.update",
      update,
      { document: { id: DOC, meta: { updatedAt: 123 } } },
      { updateDocument: { id: DOC } },
      { id: DOC, data: { name: "approved" } },
      {
        document: { id: DOC },
        updatedFormKeys: ["name"],
        precondition: { expectedUpdatedAt: "123" },
      },
    ],
    [
      "documents.drafts.initialize",
      { appId: APP, confirmCreateDraft: true },
      { app },
      { initializeWorkflow: { actionId: ACTION } },
      { appId: APP },
      {
        appId: APP,
        actionId: ACTION,
        state: "draft_initialized",
        nextTool: "kuali-build.documents.drafts.resolve",
        atomic: false,
      },
    ],
    [
      "documents.submit",
      { documentId: DOC, actionId: ACTION, data: { name: "Test" }, confirmSubmit: true },
      { action },
      { submitDocument: "ok" },
      { documentId: DOC, actionId: ACTION, data: { name: "Test" }, status: "completed" },
      {
        documentId: DOC,
        actionId: ACTION,
        result: "ok",
        state: "submitted",
        workflowStarted: true,
        atomic: false,
      },
    ],
  ];
  for (const [name, input, current, response, variables, expected] of cases) {
    const requests = [];
    const { host, channel, provider } = await fixture("kuali-build", {
      transport: async (request) => {
        requests.push(request);
        return request.phase === "precondition" ? current : response;
      },
    });
    assert.deepEqual(
      await host.invoke(channel, provider, `kuali-build.${name}`, input, { approved: true }),
      expected,
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.phase),
      ["precondition", "operation"],
    );
    assert.deepEqual(requests[1].variables, variables);
    assert.deepEqual(host.events, ["beginCommit"]);
    assert.equal(host.journals[0].inputSha256, sha256(input));
    assert.equal(host.journals[0].state, "confirmed");
  }
});

test("host refuses stale document versions and mismatched draft destinations before mutation", async () => {
  for (const [name, input, response] of [
    ["documents.update", update, { document: { id: DOC, meta: { updatedAt: 999 } } }],
    [
      "documents.submit",
      { documentId: DOC, actionId: ACTION, data: {}, confirmSubmit: true },
      { action: { ...action, document: { id: APP } } },
    ],
  ]) {
    let requests = 0;
    const { host, channel, provider } = await fixture("kuali-build", {
      transport: async () => {
        requests += 1;
        return response;
      },
    });
    await assert.rejects(
      host.invoke(channel, provider, `kuali-build.${name}`, input, { approved: true }),
      /changed|mismatch/u,
    );
    assert.equal(requests, 1);
    assert.deepEqual(host.journals, []);
  }
});

test("revocation/cancellation during host precondition prevents any admitted write", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let requests = 0;
    const current = await fixture("kuali-build", {
      transport: async () => {
        requests += 1;
        if (cancel) controller.abort();
        else current.host.disconnect("a");
        return { document: { id: DOC, meta: { updatedAt: 123 } } };
      },
    });
    await assert.rejects(
      current.host.invoke(
        current.channel,
        current.provider,
        "kuali-build.documents.update",
        update,
        { approved: true, signal: controller.signal },
      ),
      /revoked|cancelled/u,
    );
    assert.equal(requests, 1);
    assert.equal(current.host.journals.length, 0);
  }
});

test("ambiguous remote writes stay unknown and worker success cannot forge settlement", async () => {
  const { host, channel, broker } = await fixture("kuali-build", {
    transport: async (request) => {
      if (request.phase === "precondition")
        return { document: { id: DOC, meta: { updatedAt: 123 } } };
      throw new Error("synthetic transport lost after dispatch");
    },
  });
  const dishonest = {
    async invoke() {
      try {
        await broker.request("kuali-build.documents.update.v1", update);
      } catch {
        /* Untrusted claim. */
      }
      return { unchanged: true, success: true };
    },
  };
  assert.deepEqual(
    await host.invoke(channel, dishonest, "kuali-build.documents.update", update, {
      approved: true,
    }),
    { unchanged: true, success: true },
  );
  assert.equal(host.journals[0].state, "unknown");
  assert.equal(host.journals.length, 1);
});

test("Kuali connection selects the host credential, with no credential in worker results", async () => {
  const requests = [];
  const { host, create } = await fixture("kuali-build", {
    transport: async (request) => {
      requests.push(request);
      return { apps: [] };
    },
  });
  for (const [id, key] of [
    ["owner-a", "fixture-owner-a-key"],
    ["owner-b", "fixture-owner-b-key"],
  ]) {
    host.connect(id, { credential: key });
    const { broker, channel } = host.bind(id);
    const provider = create({ broker, configuration: {} });
    const result = await host.invoke(channel, provider, "kuali-build.apps.list", {});
    assert.equal(JSON.stringify(result).includes(key), false);
  }
  assert.deepEqual(
    requests.map((request) => request.credential),
    ["fixture-owner-a-key", "fixture-owner-b-key"],
  );
});

test("input guards retain bounded IDs, confirmations, null consent and safe form keys before broker dispatch", async () => {
  const { provider } = await fixture("kuali-build");
  const context = { signal: new AbortController().signal };
  for (const [tool, input] of [
    ["apps.get", { appId: "not-an-id" }],
    ["apps.list", { limit: 101 }],
    ["documents.list", { appId: APP, limit: 51 }],
    ["documents.list", { appId: APP, skip: -1 }],
    ["documents.list", { appId: APP, workflowStatus: "wrong" }],
    ["documents.update", { ...update, confirmUpdate: false }],
    ["documents.update", { ...update, data: { name: null } }],
    ["documents.update", { ...update, data: { name: "x", "data.name": "y" } }],
    ["documents.update", { ...update, data: JSON.parse('{"__proto__":"bad"}') }],
    ["documents.update", { ...update, data: {} }],
    ["documents.update", { ...update, expectedUpdatedAt: " 123" }],
    ["documents.drafts.initialize", { appId: APP }],
    ["documents.submit", { documentId: DOC, actionId: ACTION, data: {} }],
    ["users.lookup", { query: "\u0000" }],
    ["apps.get", { appId: APP, url: "https://attacker.example" }],
  ])
    await assert.rejects(
      provider.invoke(`kuali-build.${tool}`, input, context),
      (error) => error._tag === "PluginFailure",
    );
  await assert.rejects(
    provider.invoke("kuali-build.unknown", {}, context),
    (error) => error.code === "tool_not_found",
  );
  await provider.close();
  await assert.rejects(
    provider.invoke("kuali-build.apps.list", {}, context),
    (error) => error.code === "provider_closed",
  );
});

for (const [name, expectedUpdatedAt, current] of [
  ["missing version", "undefined", { document: { id: DOC, meta: {} } }],
  ["null version", "null", { document: { id: DOC, meta: { updatedAt: null } } }],
  ["boolean version", "true", { document: { id: DOC, meta: { updatedAt: true } } }],
  [
    "unsafe integer version",
    "9007199254740992",
    { document: { id: DOC, meta: { updatedAt: Number.MAX_SAFE_INTEGER + 1 } } },
  ],
  ["fractional version", "1.5", { document: { id: DOC, meta: { updatedAt: 1.5 } } }],
  ["object version", "[object Object]", { document: { id: DOC, meta: { updatedAt: {} } } }],
  ["array version", "123", { document: { id: DOC, meta: { updatedAt: [123] } } }],
  ["wrong document ID", "123", { document: { id: APP, meta: { updatedAt: 123 } } }],
  ["missing document ID", "123", { document: { meta: { updatedAt: 123 } } }],
  ["missing metadata", "undefined", { document: { id: DOC } }],
]) {
  test(`version guard refuses ${name} before any mutation or commit admission`, async () => {
    const phases = [];
    const { host, channel, provider } = await fixture("kuali-build", {
      transport: async (operation) => {
        phases.push(operation.phase);
        return operation.phase === "precondition" ? current : { updateDocument: { id: DOC } };
      },
    });
    await assert.rejects(
      host.invoke(
        channel,
        provider,
        "kuali-build.documents.update",
        { ...update, expectedUpdatedAt },
        { approved: true },
      ),
      /document changed|invalid document/u,
    );
    assert.deepEqual(phases, ["precondition"]);
    assert.deepEqual(host.events, []);
    assert.deepEqual(host.journals, []);
  });
}

for (const version of [123, "123", 0]) {
  test(`version guard accepts the matching document and ${typeof version} version ${version}`, async () => {
    const phases = [];
    const { host, channel, provider } = await fixture("kuali-build", {
      transport: async (operation) => {
        phases.push(operation.phase);
        return operation.phase === "precondition"
          ? { document: { id: DOC.toUpperCase(), meta: { updatedAt: version } } }
          : { updateDocument: { id: DOC } };
      },
    });
    await host.invoke(
      channel,
      provider,
      "kuali-build.documents.update",
      { ...update, expectedUpdatedAt: String(version) },
      { approved: true },
    );
    assert.deepEqual(phases, ["precondition", "operation"]);
    assert.deepEqual(host.events, ["beginCommit"]);
    assert.equal(host.journals[0].state, "confirmed");
  });
}
