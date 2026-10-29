import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationProvider } from "../dist/index.mjs";

const API_KEY = "eyJhbGciOiJIUzI1NiJ9.fixture.signature";
const DOCUMENT_ID = "5f6a389d77d701400f543a29";
const APP_ID = "5d5f337395a039001e48a649";
const endpoint = "https://ucsd.kualibuild.com/app/api/v0/graphql";
const READ = "kuali-build.read";
const WRITE = "kuali-build.edit";
const PREVIOUS_WRITE = "kuali-build.write";
const ADMIN = "kuali-build.admin";
const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

function memorySecrets(capabilities) {
  let value =
    capabilities === null ? null : JSON.stringify({ version: 1, apiKey: API_KEY, capabilities });
  return {
    service: {
      async get() {
        return value;
      },
      async set(_name, next) {
        value = next;
      },
      async remove() {
        value = null;
      },
    },
    value: () => value,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sequence(responses) {
  const requests = [];
  let index = 0;
  const implementation = async (input, init) => {
    requests.push({ url: String(input), init, body: JSON.parse(init.body) });
    const response = responses[index++];
    if (response instanceof Error) throw response;
    if (!response) throw new Error("unexpected fixture request");
    return response;
  };
  return { implementation, requests };
}

function provider(capabilities, responses) {
  const mock = sequence(responses);
  globalThis.fetch = mock.implementation;
  const secrets = memorySecrets(capabilities);
  return {
    mock,
    secrets,
    provider: createIntegrationProvider({ secrets: secrets.service, configuration: {} }),
  };
}

function readContext() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    writeApproved: false,
    async beginCommit() {
      return controller.signal;
    },
  };
}

function writeContext(events = []) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    writeApproved: true,
    async beginCommit() {
      events.push("beginCommit");
      return controller.signal;
    },
  };
}

const UPDATE = `mutation Update($id: ID!, $data: JSON!) { updateDocument(args: { id: $id, data: $data }) { id } }`;
const DELETE = `mutation Delete($id: ID!) { deleteDocument(id: $id) }`;

test("queries run with read access and return data plus sanitized errors", async () => {
  const { provider: kuali, mock } = provider(
    [READ],
    [
      json({
        data: { app: { id: APP_ID, name: "Travel", apiKey: "leaked-value" } },
        errors: [{ message: "Field\u0000 partially\nfailed", path: ["app"] }],
      }),
    ],
  );
  const result = await kuali.invoke(
    "kuali-build.graphql.query",
    {
      document: `query App($id: ID) { app(id: $id) { id name apiKey } }`,
      variables: { id: APP_ID },
    },
    readContext(),
  );
  assert.deepEqual(result.data, {
    app: { id: APP_ID, name: "Travel", apiKey: "[redacted by TritonAI]" },
  });
  assert.deepEqual(result.errors, ["Field  partially failed"]);
  assert.deepEqual(result.rootFields, ["app"]);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].url, endpoint);
  assert.equal(mock.requests[0].init.headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(mock.requests[0].body.variables, { id: APP_ID });
});

test("the query tool refuses mutations, subscriptions, and multiple operations before any request", async () => {
  const { provider: kuali, mock } = provider([READ, WRITE, ADMIN], []);
  const cases = [
    [UPDATE, "wrong_tool"],
    [`subscription S { documentChanged { id } }`, "graphql_unsupported"],
    [`query A { apps { id } } query B { apps { name } }`, "graphql_unsupported"],
    [`query A { apps @defer { id } }`, "graphql_unsupported"],
    [`type Query { apps: [App] }`, "graphql_unsupported"],
    [`query A { apps { id }`, "graphql_syntax_error"],
    [`{ ...Loop } fragment Loop on Query { ...Loop }`, "graphql_syntax_error"],
  ];
  for (const [document, code] of cases) {
    await assert.rejects(
      () => kuali.invoke("kuali-build.graphql.query", { document }, readContext()),
      (error) => error.code === code,
      document,
    );
  }
  assert.equal(mock.requests.length, 0);
});

test("allowlisted mutations run through the write tool exactly once after approval", async () => {
  const events = [];
  const { provider: kuali, mock } = provider(
    [READ, WRITE],
    [json({ data: { updateDocument: { id: DOCUMENT_ID } } })],
  );
  const result = await kuali.invoke(
    "kuali-build.graphql.mutate",
    {
      document: UPDATE,
      variables: { id: DOCUMENT_ID, data: { fieldA: "new" } },
      confirmMutation: true,
    },
    writeContext(events),
  );
  assert.deepEqual(result, {
    data: { updateDocument: { id: DOCUMENT_ID } },
    rootField: "updateDocument",
    permission: "write",
    committed: true,
  });
  assert.deepEqual(events, ["beginCommit"]);
  assert.equal(mock.requests.length, 1);
});

test("aliases and fragments cannot disguise an admin mutation as a write", async () => {
  const { provider: kuali, mock } = provider([READ, WRITE], []);
  const disguised = [
    `mutation { updateDocument: deleteDocument(id: "${DOCUMENT_ID}") }`,
    `mutation { ...Change } fragment Change on Mutation { deleteDocument(id: "${DOCUMENT_ID}") }`,
    `mutation { ... on Mutation { deleteDocument(id: "${DOCUMENT_ID}") } }`,
  ];
  for (const document of disguised) {
    await assert.rejects(
      () =>
        kuali.invoke(
          "kuali-build.graphql.mutate",
          { document, confirmMutation: true },
          writeContext(),
        ),
      (error) => error.code === "admin_required" && error.details.rootField === "deleteDocument",
      document,
    );
  }
  await assert.rejects(
    () =>
      kuali.invoke(
        "kuali-build.graphql.mutate",
        {
          document: `mutation { updateDocument(args: {}) { id } submitDocument(id: "x") }`,
          confirmMutation: true,
        },
        writeContext(),
      ),
    (error) => error.code === "graphql_unsupported",
  );
  assert.equal(mock.requests.length, 0);
});

test("delete mutations need the admin permission and host approval", async () => {
  const { provider: writeOnly, mock: writeMock } = provider([READ, WRITE], []);
  await assert.rejects(
    () =>
      writeOnly.invoke(
        "kuali-build.graphql.delete",
        { document: DELETE, variables: { id: DOCUMENT_ID }, confirmMutation: true },
        writeContext(),
      ),
    (error) => error.code === "capability_not_granted",
  );
  assert.equal(writeMock.requests.length, 0);

  const { provider: admin, mock } = provider(
    [READ, ADMIN],
    [json({ data: { deleteDocument: true } })],
  );
  await assert.rejects(
    () =>
      admin.invoke(
        "kuali-build.graphql.delete",
        { document: DELETE, variables: { id: DOCUMENT_ID }, confirmMutation: true },
        readContext(),
      ),
    (error) => error.code === "write_not_approved",
  );
  await assert.rejects(
    () =>
      admin.invoke(
        "kuali-build.graphql.delete",
        { document: DELETE, variables: { id: DOCUMENT_ID } },
        writeContext(),
      ),
    (error) => error.code === "confirmation_required",
  );
  assert.equal(mock.requests.length, 0);
  const events = [];
  const result = await admin.invoke(
    "kuali-build.graphql.delete",
    { document: DELETE, variables: { id: DOCUMENT_ID }, confirmMutation: true },
    writeContext(events),
  );
  assert.equal(result.permission, "admin");
  assert.equal(result.rootField, "deleteDocument");
  assert.deepEqual(events, ["beginCommit"]);
  assert.equal(mock.requests.length, 1);
});

test("mutation failures after dispatch are never retried and report unknown outcomes", async () => {
  const input = { document: DELETE, variables: { id: DOCUMENT_ID }, confirmMutation: true };
  for (const response of [
    new Error("socket closed"),
    json({ errors: [{ message: "boom" }] }, 500),
    json({ data: { deleteDocument: null }, errors: [{ message: "Failed halfway" }] }),
    json({ data: null, errors: [{ message: "Non-null field failed during execution" }] }),
  ]) {
    const { provider: kuali, mock } = provider([READ, ADMIN], [response]);
    await assert.rejects(
      () => kuali.invoke("kuali-build.graphql.delete", input, writeContext()),
      (error) => {
        assert.equal(error.code, "external_commit_outcome_unknown");
        assert.equal(error.retryable, false);
        assert.equal(error.details.rootField, "deleteDocument");
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
  }
});

test("mutations Kuali rejects before running are reported as not executed", async () => {
  const { provider: kuali, mock } = provider(
    [READ, ADMIN],
    [
      json(
        { errors: [{ message: 'Cannot query field "deleteDocument" on type "Mutation".' }] },
        400,
      ),
    ],
  );
  await assert.rejects(
    () =>
      kuali.invoke(
        "kuali-build.graphql.delete",
        { document: DELETE, variables: { id: DOCUMENT_ID }, confirmMutation: true },
        writeContext(),
      ),
    (error) => {
      assert.equal(error.code, "graphql_error");
      assert.equal(error.details.executed, false);
      assert.deepEqual(error.details.messages, [
        "Kuali returned HTTP 400.",
        'Cannot query field "deleteDocument" on type "Mutation".',
      ]);
      return true;
    },
  );
  assert.equal(mock.requests.length, 1);
});

test("schema browsing lists roots with each mutation's permission and caches the type list", async () => {
  const roots = json({
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types: [
          { name: "Query", kind: "OBJECT" },
          { name: "Mutation", kind: "OBJECT" },
          { name: "Document", kind: "OBJECT" },
          { name: "__Type", kind: "OBJECT" },
        ],
      },
    },
  });
  const typeRef = (name) => ({ kind: "OBJECT", name, ofType: null });
  const queryType = json({
    data: {
      __type: {
        name: "Query",
        kind: "OBJECT",
        description: null,
        fields: [
          {
            name: "apps",
            description: "Apps",
            isDeprecated: false,
            args: [],
            type: typeRef("App"),
          },
        ],
        inputFields: null,
        enumValues: null,
        possibleTypes: null,
      },
    },
  });
  const mutationType = json({
    data: {
      __type: {
        name: "Mutation",
        kind: "OBJECT",
        description: null,
        fields: [
          {
            name: "updateDocument",
            description: null,
            isDeprecated: false,
            args: [
              {
                name: "args",
                type: { kind: "NON_NULL", name: null, ofType: typeRef("UpdateDocumentInput") },
              },
            ],
            type: typeRef("Document"),
          },
          {
            name: "deleteApp",
            description: null,
            isDeprecated: false,
            args: [],
            type: typeRef("Boolean"),
          },
          {
            name: "approveDocument",
            description: null,
            isDeprecated: false,
            args: [],
            type: typeRef("Boolean"),
          },
        ],
        inputFields: null,
        enumValues: null,
        possibleTypes: null,
      },
    },
  });
  const documentType = json({
    data: {
      __type: {
        name: "Document",
        kind: "OBJECT",
        description: null,
        fields: [
          { name: "id", description: null, isDeprecated: false, args: [], type: typeRef("ID") },
        ],
        inputFields: null,
        enumValues: null,
        possibleTypes: null,
      },
    },
  });
  const { provider: kuali, mock } = provider(
    [READ],
    [roots, queryType, mutationType, documentType],
  );
  const overview = await kuali.invoke("kuali-build.graphql.schema", {}, readContext());
  assert.deepEqual(
    overview.mutations.map(({ name, permission }) => [name, permission]),
    [
      ["updateDocument", "write"],
      ["deleteApp", "admin"],
      ["approveDocument", "write"],
    ],
  );
  assert.equal(overview.mutations[0].args[0].type, "UpdateDocumentInput!");
  assert.deepEqual(
    overview.types.map(({ name }) => name),
    ["Query", "Mutation", "Document"],
  );
  const detail = await kuali.invoke(
    "kuali-build.graphql.schema",
    { typeName: "Document" },
    readContext(),
  );
  assert.equal(detail.type.fields[0].name, "id");
  assert.equal(mock.requests.length, 4, "the root schema request is cached between calls");
});

test("existing connections keep their grants and can add admin without re-entering the key", async () => {
  const { provider: kuali, secrets } = provider(
    [READ, WRITE],
    [json({ data: { apps: [] } }), json({ data: { apps: [] } })],
  );
  assert.deepEqual((await kuali.status(readContext())).grantedCapabilities, [READ, WRITE]);
  const result = await kuali.connect([READ, WRITE, ADMIN], readContext());
  assert.equal(result.kind, "connected");
  assert.match(result.message, /write and admin/u);
  assert.deepEqual(JSON.parse(secrets.value()).capabilities, [READ, WRITE, ADMIN]);
});

test("earlier write grants never carry over to the broader Write or Admin", async () => {
  const { provider: kuali } = provider([READ, PREVIOUS_WRITE], [json({ data: { apps: [] } })]);
  assert.deepEqual((await kuali.status(readContext())).grantedCapabilities, [READ]);
});

test("review regressions: errors after execution always mean an unknown outcome", async () => {
  const input = { document: DELETE, variables: { id: DOCUMENT_ID }, confirmMutation: true };
  for (const response of [
    json({
      data: { deleteDocument: null },
      errors: [{ message: "Downstream denied", extensions: { code: "FORBIDDEN" } }],
    }),
    json({ data: null, errors: [{ message: "" }] }),
    json({ data: null, errors: [{ message: "Non-null failure" }] }, 400),
    json({ data: {} }),
  ]) {
    const { provider: kuali, mock } = provider([READ, ADMIN], [response]);
    await assert.rejects(
      () => kuali.invoke("kuali-build.graphql.delete", input, writeContext()),
      (error) => error.code === "external_commit_outcome_unknown",
    );
    assert.equal(mock.requests.length, 1);
  }
  const { provider: kuali } = provider(
    [READ, ADMIN],
    [json({ errors: [{ message: "\n\t" }] }, 400)],
  );
  await assert.rejects(
    () => kuali.invoke("kuali-build.graphql.delete", input, writeContext()),
    (error) => error.code === "graphql_error" && error.details.executed === false,
  );
});

test("review regressions: exponential fragment expansion is bounded", async () => {
  const { provider: kuali, mock } = provider([READ], [json({ data: { __typename: "Query" } })]);
  const fragments = ["fragment F0 on Query { __typename }"];
  for (let level = 1; level <= 22; level += 1) {
    fragments.push(`fragment F${level} on Query { ...F${level - 1} ...F${level - 1} }`);
  }
  const started = Date.now();
  await kuali.invoke(
    "kuali-build.graphql.query",
    { document: `query { ...F22 } ${fragments.join(" ")}` },
    readContext(),
  );
  assert.ok(Date.now() - started < 1_000, "classification stays linear in fragment count");
  assert.equal(mock.requests.length, 1);

  const deep = ["fragment D0 on Query { __typename }"];
  for (let level = 1; level <= 40; level += 1)
    deep.push(`fragment D${level} on Query { ...D${level - 1} }`);
  await assert.rejects(
    () =>
      kuali.invoke(
        "kuali-build.graphql.query",
        { document: `query { ...D40 } ${deep.join(" ")}` },
        readContext(),
      ),
    (error) => error.code === "graphql_too_complex",
  );
});

test("review regressions: aliased credential fields and nested secrets are redacted", async () => {
  const { provider: kuali } = provider(
    [READ],
    [
      json({
        data: { app: { harmless: "credential", secret: { value: "nested" }, name: "Travel" } },
      }),
    ],
  );
  const result = await kuali.invoke(
    "kuali-build.graphql.query",
    { document: `query { app(id: "${APP_ID}") { harmless: apiKey secret { value } name } }` },
    readContext(),
  );
  assert.deepEqual(result.data.app, {
    harmless: "[redacted by TritonAI]",
    secret: "[redacted by TritonAI]",
    name: "Travel",
  });
});

test("review regressions: conditional mutation roots are refused before dispatch", async () => {
  const { provider: kuali, mock } = provider([READ, WRITE], []);
  for (const document of [
    `mutation { initializeWorkflow(args: { id: "${APP_ID}" }) @skip(if: true) { actionId } }`,
    `mutation ($go: Boolean!) { ... @include(if: $go) { initializeWorkflow(args: { id: "${APP_ID}" }) { actionId } } }`,
  ]) {
    await assert.rejects(
      () =>
        kuali.invoke(
          "kuali-build.graphql.mutate",
          { document, variables: { go: true }, confirmMutation: true },
          writeContext(),
        ),
      (error) => error.code === "graphql_unsupported",
    );
  }
  assert.equal(mock.requests.length, 0);
});

test("review round 2: error statuses with execution evidence stay unknown outcomes", async () => {
  const input = { document: DELETE, variables: { id: DOCUMENT_ID }, confirmMutation: true };
  const denied = {
    data: null,
    errors: [{ message: "Downstream denied", extensions: { code: "FORBIDDEN" } }],
  };
  for (const response of [
    json(denied, 403),
    json(denied, 401),
    json(denied, 429),
    json({ data: { deleteDocument: true } }, 502),
  ]) {
    const { provider: kuali } = provider([READ, ADMIN], [response]);
    await assert.rejects(
      () => kuali.invoke("kuali-build.graphql.delete", input, writeContext()),
      (error) => error.code === "external_commit_outcome_unknown",
    );
  }
  const { provider: rejected } = provider(
    [READ, ADMIN],
    [json({ errors: [{ message: "bad key" }] }, 401)],
  );
  await assert.rejects(
    () => rejected.invoke("kuali-build.graphql.delete", input, writeContext()),
    (error) => error.code === "authentication_failed",
  );
});

test("review round 2: alias redaction is path-aware", async () => {
  const { provider: kuali } = provider(
    [READ],
    [json({ data: { app: { id: "credential" }, apps: [{ id: "app-id", name: "Travel" }] } })],
  );
  const result = await kuali.invoke(
    "kuali-build.graphql.query",
    { document: `query { app { id: apiKey } apps { id name } }` },
    readContext(),
  );
  assert.deepEqual(result.data, {
    app: { id: "[redacted by TritonAI]" },
    apps: [{ id: "app-id", name: "Travel" }],
  });
});

test("review round 2: fragment depth is enforced across the whole document", async () => {
  const { provider: kuali, mock } = provider([READ], []);
  const chain = (type) => {
    const fragments = [`fragment D0 on ${type} { __typename }`];
    for (let level = 1; level <= 40; level += 1)
      fragments.push(`fragment D${level} on ${type} { ...D${level - 1} }`);
    return fragments.join(" ");
  };
  const spreads = Array.from({ length: 41 }, (_, level) => `...D${level}`).join(" ");
  for (const document of [
    `query { ${spreads} } ${chain("Query")}`,
    `query { app { ...D40 } } ${chain("App")}`,
  ]) {
    await assert.rejects(
      () => kuali.invoke("kuali-build.graphql.query", { document }, readContext()),
      (error) => error.code === "graphql_too_complex",
    );
  }
  assert.equal(mock.requests.length, 0);
});

test("review round 3: unreadable or non-GraphQL error bodies never prove a mutation did not run", async () => {
  const input = { document: DELETE, variables: { id: DOCUMENT_ID }, confirmMutation: true };
  const oversized = new Response(
    `{"data":{"deleteDocument":true},"padding":"${"x".repeat(2 * 1024 * 1024)}"}`,
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
  for (const response of [
    oversized,
    json({}, 400),
    json({ errors: [] }, 400),
    json({ error: "upstream closed" }, 400),
  ]) {
    const { provider: kuali } = provider([READ, ADMIN], [response]);
    await assert.rejects(
      () => kuali.invoke("kuali-build.graphql.delete", input, writeContext()),
      (error) => error.code === "external_commit_outcome_unknown",
    );
  }
  const { provider: reader } = provider(
    [READ],
    [json({ data: { apps: [{ id: "app-id" }] }, errors: [{ message: "\n\t" }] }, 502)],
  );
  const result = await reader.invoke(
    "kuali-build.graphql.query",
    { document: "query { apps { id } }" },
    readContext(),
  );
  assert.deepEqual(result.errors, ["Kuali returned HTTP 502."]);
});

test("PR review: error statuses after dispatch are unknown unless Kuali returned a GraphQL rejection", async () => {
  const input = { document: DELETE, variables: { id: DOCUMENT_ID }, confirmMutation: true };
  const html = new Response("<html>Too Many Requests</html>", {
    status: 429,
    headers: { "content-type": "text/html" },
  });
  for (const response of [html, json({}, 429), json({}, 403), json({ error: "nope" }, 404)]) {
    const { provider: kuali } = provider([READ, ADMIN], [response]);
    await assert.rejects(
      () => kuali.invoke("kuali-build.graphql.delete", input, writeContext()),
      (error) => error.code === "external_commit_outcome_unknown",
    );
  }
  const { provider: limited } = provider(
    [READ, ADMIN],
    [json({ errors: [{ message: "Slow down" }] }, 429)],
  );
  await assert.rejects(
    () => limited.invoke("kuali-build.graphql.delete", input, writeContext()),
    (error) => error.code === "rate_limited" && error.details.rejectedBeforeExecution === true,
  );
});

test("PR review: oversized mutations are refused before commit admission", async () => {
  const events = [];
  const { provider: kuali, mock } = provider([READ, WRITE], []);
  await assert.rejects(
    () =>
      kuali.invoke(
        "kuali-build.graphql.mutate",
        {
          document: UPDATE,
          variables: { id: DOCUMENT_ID, data: { big: "x".repeat(70_000) } },
          confirmMutation: true,
        },
        writeContext(events),
      ),
    (error) => error.code === "request_too_large",
  );
  assert.deepEqual(events, []);
  assert.equal(mock.requests.length, 0);
});

test("Write covers any create or edit mutation and the delete tool covers only deletes", async () => {
  const publish = `mutation { publishApp(args: { id: "${APP_ID}" }) { id } }`;
  const { provider: kuali, mock } = provider(
    [READ, WRITE],
    [json({ data: { publishApp: { id: APP_ID } } })],
  );
  const result = await kuali.invoke(
    "kuali-build.graphql.mutate",
    { document: publish, confirmMutation: true },
    writeContext(),
  );
  assert.equal(result.permission, "write");
  assert.equal(mock.requests.length, 1);

  const { provider: admin, mock: adminMock } = provider([READ, ADMIN], []);
  await assert.rejects(
    () =>
      admin.invoke(
        "kuali-build.graphql.delete",
        { document: publish, confirmMutation: true },
        writeContext(),
      ),
    (error) => error.code === "wrong_tool",
  );
  await assert.rejects(
    () =>
      admin.invoke(
        "kuali-build.graphql.mutate",
        { document: publish, confirmMutation: true },
        writeContext(),
      ),
    (error) => error.code === "capability_not_granted",
  );
  assert.equal(adminMock.requests.length, 0);
});

test("app-building tools send Kuali's builder requests under the right permission", async () => {
  const template = {
    type: "Section",
    children: [{ type: "Text", formKey: "name", label: "Name" }],
  };
  const { provider: kuali, mock } = provider(
    [READ, WRITE],
    [
      json({ data: { updateForm: { id: "form1" } } }),
      json({
        data: {
          updateWorkflowV2: {
            query: { app: { id: APP_ID, hasDraft: true, dataset: { id: APP_ID } } },
          },
        },
      }),
      json({
        data: { app: { id: APP_ID, name: "Travel", dataset: { form: { id: "f", template } } } },
      }),
    ],
  );
  await assert.rejects(
    () => kuali.invoke("kuali-build.forms.update", { appId: APP_ID, template }, writeContext()),
    (error) => error.code === "confirmation_required",
  );
  const saved = await kuali.invoke(
    "kuali-build.forms.update",
    { appId: APP_ID, template, confirmChange: true },
    writeContext(),
  );
  assert.equal(saved.rootField, "updateForm");
  assert.match(
    mock.requests[0].body.query,
    /updateForm\(args: \{ appId: \$appId, pageId: \$pageId, template: \$template \}\)/u,
  );
  assert.deepEqual(mock.requests[0].body.variables, { appId: APP_ID, template });

  const steps = [{ type: "Approval", label: "Supervisor" }];
  await kuali.invoke(
    "kuali-build.workflows.update",
    { appId: APP_ID, workflowId: "wf1", steps, confirmChange: true },
    writeContext(),
  );
  assert.deepEqual(mock.requests[1].body.variables, {
    appId: APP_ID,
    args: { appId: APP_ID, id: "wf1", steps },
  });

  const setup = await kuali.invoke(
    "kuali-build.apps.configuration.get",
    { appId: APP_ID },
    readContext(),
  );
  assert.deepEqual(setup.data.app.dataset.form.template, template);

  await assert.rejects(
    () =>
      kuali.invoke(
        "kuali-build.apps.delete",
        { appId: APP_ID, confirmChange: true },
        writeContext(),
      ),
    (error) => error.code === "capability_not_granted",
  );
  assert.equal(mock.requests.length, 3);

  const { provider: admin, mock: adminMock } = provider(
    [READ, ADMIN],
    [json({ data: { deleteApp: true } })],
  );
  const deleted = await admin.invoke(
    "kuali-build.apps.delete",
    { appId: APP_ID, confirmChange: true },
    writeContext(),
  );
  assert.equal(deleted.permission, "admin");
  assert.deepEqual(adminMock.requests[0].body.variables, { id: APP_ID });
});

test("approving or denying sends Kuali's status values only", async () => {
  const { provider: kuali, mock } = provider(
    [READ, WRITE],
    [
      json({
        data: {
          submitDocumentV2: { id: DOCUMENT_ID, status: "completed", label: "x", validations: [] },
        },
      }),
    ],
  );
  await assert.rejects(
    () =>
      kuali.invoke(
        "kuali-build.documents.act",
        { documentId: DOCUMENT_ID, actionId: "a1", status: "approve", confirmChange: true },
        writeContext(),
      ),
    (error) => error.code === "invalid_input",
  );
  await kuali.invoke(
    "kuali-build.documents.act",
    {
      documentId: DOCUMENT_ID,
      actionId: "a1",
      status: "rejected",
      comment: "Missing receipt",
      confirmChange: true,
    },
    writeContext(),
  );
  assert.equal(mock.requests[0].body.variables.status, "rejected");
  assert.equal(mock.requests[0].body.variables.comment, "Missing receipt");
});

test("council review: Kuali refusals returned as data are reported as not done", async () => {
  const cases = [
    [
      "kuali-build.documents.act",
      { documentId: DOCUMENT_ID, actionId: "a1", status: "approved", confirmChange: true },
      {
        submitDocumentV2: {
          id: DOCUMENT_ID,
          status: "validationFailed",
          label: "x",
          validations: [{ formKeys: ["a"], label: "A", message: "Required" }],
        },
      },
    ],
    [
      "kuali-build.documents.sendback",
      { documentId: DOCUMENT_ID, stepId: "s1", confirmChange: true },
      { sendbackDocument: "Invalid Operation" },
    ],
    [
      "kuali-build.documents.withdraw",
      { documentId: DOCUMENT_ID, confirmChange: true },
      { withdrawSubmission: { __typename: "PermissionError", reason: "Not allowed" } },
    ],
    [
      "kuali-build.documents.duplicate",
      { documentId: DOCUMENT_ID, confirmChange: true },
      { duplicateDocument: { __typename: "InvalidDocumentError", reason: "Gone" } },
    ],
  ];
  for (const [tool, input, data] of cases) {
    const { provider: kuali, mock } = provider([READ, WRITE], [json({ data })]);
    await assert.rejects(
      () => kuali.invoke(tool, input, writeContext()),
      (error) => error.code === "kuali_rejected_action" && error.details.committed === false,
      tool,
    );
    assert.equal(mock.requests.length, 1);
  }
  const { provider: kuali, mock } = provider(
    [READ, WRITE],
    [
      json({
        data: {
          submitDocumentV2: { id: DOCUMENT_ID, status: "approved", label: "x", validations: [] },
        },
      }),
      json({ data: { app: { id: APP_ID, name: "Copy", spaceId: null } } }),
    ],
  );
  const approved = await kuali.invoke(
    "kuali-build.documents.act",
    { documentId: DOCUMENT_ID, actionId: "a1", status: "approved", confirmChange: true },
    writeContext(),
  );
  assert.equal(approved.committed, true);
  assert.equal(mock.requests[0].body.variables.status, "approved");
  await kuali.invoke(
    "kuali-build.apps.copy",
    { sourceAppId: APP_ID, name: "Copy", confirmChange: true },
    writeContext(),
  );
  assert.deepEqual(mock.requests[1].body.variables, { args: { sourceId: APP_ID, name: "Copy" } });
});

test("council round 2: step statuses, more refusals, unclear results, and withheld credentials", async () => {
  const act = (status) => ({
    documentId: DOCUMENT_ID,
    actionId: "a1",
    status,
    confirmChange: true,
  });
  for (const status of ["task completed", "acknowledged"]) {
    const { provider: kuali, mock } = provider(
      [READ, WRITE],
      [
        json({
          data: { submitDocumentV2: { id: DOCUMENT_ID, status, label: "x", validations: [] } },
        }),
      ],
    );
    await kuali.invoke("kuali-build.documents.act", act(status), writeContext());
    assert.equal(mock.requests[0].body.variables.status, status);
  }
  for (const refused of ["submissionsDisabled", "Invalid Operation"]) {
    const { provider: kuali } = provider(
      [READ, WRITE],
      [json({ data: { submitDocumentV2: { id: DOCUMENT_ID, status: refused } } })],
    );
    await assert.rejects(
      () => kuali.invoke("kuali-build.documents.act", act("completed"), writeContext()),
      (error) => error.code === "kuali_rejected_action" && error.details.reason === refused,
    );
  }
  for (const [tool, data] of [
    ["kuali-build.documents.duplicate", { duplicateDocument: null }],
    ["kuali-build.documents.duplicate", { duplicateDocument: {} }],
    ["kuali-build.documents.withdraw", { withdrawSubmission: { __typename: "Mystery" } }],
  ]) {
    const { provider: kuali } = provider([READ, WRITE], [json({ data })]);
    await assert.rejects(
      () => kuali.invoke(tool, { documentId: DOCUMENT_ID, confirmChange: true }, writeContext()),
      (error) => error.code === "external_commit_outcome_unknown",
    );
  }
  const { provider: kuali } = provider(
    [READ, WRITE],
    [json({ data: { createApiKey: "kb_live_SECRET" } })],
  );
  const created = await kuali.invoke(
    "kuali-build.graphql.mutate",
    { document: `mutation { createApiKey(userId: "u1", name: "x") }`, confirmMutation: true },
    writeContext(),
  );
  assert.equal(created.secretWithheld, true);
  assert.doesNotMatch(JSON.stringify(created), /kb_live_SECRET/u);
});

test("council round 2: approval comments may span lines", async () => {
  const { provider: kuali, mock } = provider(
    [READ, WRITE],
    [
      json({
        data: {
          submitDocumentV2: { id: DOCUMENT_ID, status: "approved", label: "x", validations: [] },
        },
      }),
    ],
  );
  const comment = "Approved.\nAttach the receipt next time.";
  await kuali.invoke(
    "kuali-build.documents.act",
    { documentId: DOCUMENT_ID, actionId: "a1", status: "approved", comment, confirmChange: true },
    writeContext(),
  );
  assert.equal(mock.requests[0].body.variables.comment, comment);
});

test("council round 3: missing action results are unknown; boolean credential results stay visible", async () => {
  for (const [tool, input, data] of [
    [
      "kuali-build.documents.act",
      { documentId: DOCUMENT_ID, actionId: "a1", status: "approved", confirmChange: true },
      { submitDocumentV2: null },
    ],
    [
      "kuali-build.documents.act",
      { documentId: DOCUMENT_ID, actionId: "a1", status: "approved", confirmChange: true },
      { submitDocumentV2: { id: DOCUMENT_ID } },
    ],
    [
      "kuali-build.documents.sendback",
      { documentId: DOCUMENT_ID, stepId: "s1", confirmChange: true },
      { sendbackDocument: null },
    ],
  ]) {
    const { provider: kuali } = provider([READ, WRITE], [json({ data })]);
    await assert.rejects(
      () => kuali.invoke(tool, input, writeContext()),
      (error) => error.code === "external_commit_outcome_unknown",
    );
  }
  const { provider: admin } = provider([READ, ADMIN], [json({ data: { revokeApiKey: false } })]);
  const revoked = await admin.invoke(
    "kuali-build.graphql.delete",
    { document: `mutation { revokeApiKey(id: "k1") }`, confirmMutation: true },
    writeContext(),
  );
  assert.equal(revoked.data.revokeApiKey, false);
  assert.equal(revoked.secretWithheld, undefined);
});

test("council round 4: aliased boolean credential results stay visible; successful sendback commits", async () => {
  const { provider: admin } = provider([READ, ADMIN], [json({ data: { token: false } })]);
  const revoked = await admin.invoke(
    "kuali-build.graphql.delete",
    { document: `mutation { token: revokeApiKey(id: "k1") }`, confirmMutation: true },
    writeContext(),
  );
  assert.equal(revoked.data.token, false);

  const { provider: kuali } = provider([READ, WRITE], [json({ data: { sendbackDocument: "ok" } })]);
  const sent = await kuali.invoke(
    "kuali-build.documents.sendback",
    { documentId: DOCUMENT_ID, stepId: "s1", confirmChange: true },
    writeContext(),
  );
  assert.equal(sent.committed, true);
});
