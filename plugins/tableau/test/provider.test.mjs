import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createIntegrationProvider } from "../dist/index.mjs";
import { validateManifestV1 } from "../../../packages/plugin-sdk/index.mjs";

const ORIGIN = "https://tableau.ucsd.edu";
const SITE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const VIEW = "33333333-3333-4333-8333-333333333333";
const WORKBOOK = "44444444-4444-4444-8444-444444444444";
const realFetch = globalThis.fetch;
const session = {
  session: { site: { id: SITE, contentUrl: "" }, user: { id: USER, name: "test.user" } },
};
function lifecycle(signal = new AbortController().signal) {
  let admitted = false;
  return {
    signal,
    beginCommit: async () => {
      assert.equal(admitted, false);
      admitted = true;
      signal.throwIfAborted();
      return signal;
    },
  };
}
function fixture(t, responder = () => new Response("{}")) {
  const values = new Map();
  const calls = [];
  const secrets = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
  const provider = createIntegrationProvider({ secrets, configuration: {} });
  t.after(() => provider.close());
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(
      String(url).startsWith(ORIGIN + "/"),
      "all provider requests stay on the reviewed origin",
    );
    assert.equal(options.redirect, "error");
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/sessions/current")) return Response.json(session);
    return responder(String(url), options);
  });
  return { provider, values, calls, secrets };
}
async function connect(f, tokenOverrides = {}) {
  const flow = await f.provider.connect(["read"], lifecycle());
  const url = new URL(flow.authorizationUrl);
  const callback = new URL(url.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", url.searchParams.get("state"));
  callback.searchParams.set("code", "one-use-code");
  assert.equal((await realFetch(callback)).status, 200);
  const result = await f.provider.poll(flow.flowId, lifecycle());
  return { flow, url, result, tokenOverrides };
}
const token = (overrides = {}) =>
  Response.json({
    access_token: "access-secret",
    refresh_token: "",
    expires_in: 14400,
    origin_host: "tableau.ucsd.edu",
    ...overrides,
  });
const invoke = (p, name, input) =>
  p.invoke(name, input, {
    signal: new AbortController().signal,
    writeApproved: false,
    beginCommit: async () => {
      throw new Error("read must not admit a write");
    },
  });

test("manifest validates and gates its only write tool behind explicit opt-in", async () => {
  const manifest = validateManifestV1(
    JSON.parse(await readFile(new URL("../.tritonai-plugin/plugin.json", import.meta.url))),
  );
  assert.equal(manifest.tools.length, 14);
  assert.equal(manifest.capabilities.find((c) => c.id === "write").access, "opt-in");
  const writes = manifest.tools.filter((t) => t.effect === "write");
  assert.deepEqual(
    writes.map((t) => t.name),
    ["tableau.changes.apply"],
  );
  assert.equal(writes[0].idempotent, false);
  assert.deepEqual(writes[0].capabilities, ["write"]);
});

test("rejects alternate origins, extra configuration, and unsafe sites", () => {
  for (const configuration of [
    { serverUrl: "https://evil.example" },
    { serverUrl: ORIGIN + "/" },
    { token: "secret" },
    { siteContentUrl: "../x" },
  ]) {
    assert.throws(
      () => createIntegrationProvider({ secrets: {}, configuration }),
      (e) => e._tag === "PluginFailure",
    );
  }
});

test("connects with UCSD's empty refresh token, verifies site, persists, and reloads", async (t) => {
  const f = fixture(t, () => token());
  const { url, result } = await connect(f);
  assert.equal(result.state, "connected");
  const form = f.calls[0].options.body;
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(
    createHash("sha256").update(form.get("code_verifier")).digest("base64url"),
    url.searchParams.get("code_challenge"),
  );
  const stored = JSON.parse(f.values.get("connection"));
  assert.equal(stored.refreshToken, "");
  assert.equal(stored.siteId, SITE);
  const reloaded = createIntegrationProvider({ secrets: f.secrets, configuration: {} });
  t.after(() => reloaded.close());
  assert.equal((await reloaded.status(lifecycle())).state, "connected");
  assert.ok(!JSON.stringify(await reloaded.status(lifecycle())).includes("access-secret"));
});

test("accepts an omitted refresh token without inventing one", async (t) => {
  const f = fixture(t, () =>
    Response.json({
      access_token: "access-secret",
      expires_in: 14400,
      origin_host: "tableau.ucsd.edu",
    }),
  );
  assert.equal((await connect(f)).result.state, "connected");
  assert.equal(JSON.parse(f.values.get("connection")).refreshToken, "");
});

test("rejects wrong callback state and duplicate codes, then accepts the legitimate callback", async (t) => {
  const f = fixture(t, () => token());
  const flow = await f.provider.connect(["read"], lifecycle());
  const auth = new URL(flow.authorizationUrl);
  const url = new URL(auth.searchParams.get("redirect_uri"));
  url.searchParams.set("state", "wrong");
  url.searchParams.set("code", "code");
  assert.equal((await realFetch(url)).status, 400);
  url.searchParams.set("state", auth.searchParams.get("state"));
  url.searchParams.append("code", "second");
  assert.equal((await realFetch(url)).status, 400);
  assert.equal(f.calls.length, 0);
  url.searchParams.delete("code");
  url.searchParams.set("code", "code");
  assert.equal((await realFetch(url)).status, 200);
  assert.equal((await f.provider.poll(flow.flowId, lifecycle())).state, "connected");
  assert.equal((await f.provider.poll(flow.flowId, lifecycle())).state, "expired");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/token")).length, 1);
});

test("authorization denial is a settled failure without exchanging or storing tokens", async (t) => {
  const f = fixture(t);
  const flow = await f.provider.connect(["read"], lifecycle());
  const auth = new URL(flow.authorizationUrl);
  const callback = new URL(auth.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", auth.searchParams.get("state"));
  callback.searchParams.set("error", "access_denied");
  await realFetch(callback);
  assert.equal((await f.provider.poll(flow.flowId, lifecycle())).state, "failed");
  assert.equal(f.values.size, 0);
  assert.equal(f.calls.length, 0);
});

test("does not exchange a code without lifecycle admission", async (t) => {
  const f = fixture(t);
  const flow = await f.provider.connect(["read"], lifecycle());
  const auth = new URL(flow.authorizationUrl);
  const callback = new URL(auth.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", auth.searchParams.get("state"));
  callback.searchParams.set("code", "code");
  await realFetch(callback);
  await assert.rejects(
    f.provider.poll(flow.flowId, {
      signal: new AbortController().signal,
      beginCommit: async () => {
        throw new Error("denied");
      },
    }),
    /denied/u,
  );
  assert.equal(f.calls.length, 0);
});

test("wrong authenticated site and invalid token origin never persist credentials", async (t) => {
  const f = fixture(t, () => token({ origin_host: "other.example" }));
  assert.equal((await connect(f)).result.state, "failed");
  assert.equal(f.values.size, 0);
  t.mock.method(globalThis, "fetch", async (url) =>
    String(url).endsWith("/token")
      ? token()
      : Response.json({ session: { ...session.session, site: { id: SITE, contentUrl: "Other" } } }),
  );
  assert.equal((await connect(f)).result.state, "failed");
  assert.equal(f.values.size, 0);
});

test("expired nonrenewable sessions request reconnect without network or background sign-in", async (t) => {
  const f = fixture(t, () => token());
  await connect(f);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 14400_000);
  const before = f.calls.length;
  await f.provider.prepare(lifecycle());
  assert.equal((await f.provider.status(lifecycle())).state, "not_connected");
  assert.equal(
    (await invoke(f.provider, "tableau.workbooks.list", {})).status,
    "connection_required",
  );
  assert.equal(f.calls.length, before);
});

test("rotates a supplied refresh token once under concurrent preparation", async (t) => {
  const f = fixture(t, (_url, opts) =>
    opts.body.get("grant_type") === "refresh_token"
      ? token({ access_token: "new-access", refresh_token: "new-refresh" })
      : token({ refresh_token: "initial-refresh" }),
  );
  await connect(f);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 14400_000);
  await Promise.all([f.provider.prepare(lifecycle()), f.provider.prepare(lifecycle())]);
  assert.equal(
    f.calls.filter((c) => c.options.body?.get("grant_type") === "refresh_token").length,
    1,
  );
  assert.equal(JSON.parse(f.values.get("connection")).refreshToken, "new-refresh");
  assert.equal((await f.provider.status(lifecycle())).state, "connected");
});

test("failed refresh settles without faulting the lifecycle or repeating a spent token", async (t) => {
  const f = fixture(t, (_url, opts) =>
    opts.body.get("grant_type") === "refresh_token"
      ? new Response("invalid_grant", { status: 400 })
      : token({ refresh_token: "initial-refresh" }),
  );
  await connect(f);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 14400_000);
  await f.provider.prepare(lifecycle());
  await f.provider.prepare(lifecycle());
  assert.equal(f.values.size, 0);
  assert.equal((await f.provider.status(lifecycle())).state, "not_connected");
  assert.equal(
    f.calls.filter((c) => c.options.body?.get("grant_type") === "refresh_token").length,
    1,
  );
});

test("bounds discovery and returns only report metadata", async (t) => {
  const f = fixture(t, (url) =>
    url.endsWith("/token")
      ? token()
      : Response.json({
          pagination: { pageNumber: "2", pageSize: "10", totalAvailable: "25" },
          workbooks: {
            workbook: [
              {
                id: WORKBOOK,
                name: "Report",
                secretInternalField: "omit",
                project: { id: SITE, name: "Test" },
              },
            ],
          },
        }),
  );
  await connect(f);
  const result = await invoke(f.provider, "tableau.workbooks.list", {
    name: "Report",
    page: 2,
    limit: 10,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.workbooks[0].secretInternalField, undefined);
  const url = new URL(f.calls.at(-1).url);
  assert.equal(url.searchParams.get("filter"), "name:eq:Report");
  assert.equal(url.searchParams.get("pageSize"), "10");
});

test("CSV retains quoted values and has explicit coverage, filters and a source link", async (t) => {
  const csv = 'Category,Value\n"A,B",10\n';
  const f = fixture(t, (url) =>
    url.endsWith("/token")
      ? token()
      : url.includes("/data?")
        ? new Response(csv)
        : Response.json({ view: { id: VIEW, name: "A report", contentUrl: "Book/sheets/Report" } }),
  );
  await connect(f);
  const result = await invoke(f.provider, "tableau.views.data", {
    id: VIEW,
    filters: { Year: "2026" },
  });
  assert.equal(result.csv, csv);
  assert.equal(result.coverage, "requested_worksheet_or_first_dashboard_worksheet");
  assert.equal(result.view.sourceUrl, ORIGIN + "/#/views/Book/Report");
  assert.equal(new URL(f.calls.at(-1).url).searchParams.get("vf_Year"), "2026");
});

test("permission denials are tool results, not plugin lifecycle faults", async (t) => {
  let deny = true;
  const f = fixture(t, (url) =>
    url.endsWith("/token")
      ? token()
      : deny
        ? new Response("private error", { status: 403 })
        : Response.json({ workbooks: { workbook: [] } }),
  );
  await connect(f);
  const result = await invoke(f.provider, "tableau.workbooks.list", {});
  assert.equal(result.code, "access_denied");
  assert.ok(!JSON.stringify(result).includes("private error"));
  assert.equal((await f.provider.status(lifecycle())).state, "connected");
  deny = false;
  assert.equal((await invoke(f.provider, "tableau.workbooks.list", {})).status, "ok");
});

test("401 marks the current token stale and lets connect start again", async (t) => {
  const f = fixture(t, (url) =>
    url.endsWith("/token") ? token() : new Response("denied", { status: 401 }),
  );
  await connect(f);
  assert.equal(
    (await invoke(f.provider, "tableau.workbooks.list", {})).code,
    "connection_required",
  );
  assert.equal((await f.provider.status(lifecycle())).state, "not_connected");
  assert.equal((await f.provider.connect(["read"], lifecycle())).kind, "authorization_url");
});

test("oversized CSV fails rather than returning a truncated report", async (t) => {
  const f = fixture(t, (url) =>
    url.endsWith("/token")
      ? token()
      : url.includes("/data?")
        ? new Response("x".repeat(524289))
        : Response.json({ view: { id: VIEW } }),
  );
  await connect(f);
  const result = await invoke(f.provider, "tableau.views.data", { id: VIEW });
  assert.equal(result.code, "response_too_large");
  assert.equal(result.csv, undefined);
});

test("workbook views apply exact-name filtering and pagination to Tableau's unpaginated response", async (t) => {
  const f = fixture(t, (url) =>
    url.endsWith("/token")
      ? token()
      : Response.json({
          views: {
            view: [
              { id: VIEW, name: "Report" },
              { id: WORKBOOK, name: "Other" },
              { id: USER, name: "Report" },
            ],
          },
        }),
  );
  await connect(f);
  const result = await invoke(f.provider, "tableau.views.list", {
    workbookId: WORKBOOK,
    name: "Report",
    page: 2,
    limit: 1,
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.views.map((view) => view.id),
    [USER],
  );
  assert.deepEqual(result.pagination, { pageNumber: 2, pageSize: 1, totalAvailable: 2 });
  assert.ok(f.calls.at(-1).url.endsWith(`/workbooks/${WORKBOOK}/views`));
});

test("invalid paths, filters, pages, and write tools make no remote calls", async (t) => {
  const f = fixture(t);
  for (const [name, input] of [
    ["tableau.views.data", { id: "../../users" }],
    ["tableau.workbooks.list", { limit: 101 }],
    ["tableau.workbooks.list", { name: "x,ownerId:eq:y" }],
    ["tableau.views.data", { id: VIEW, filters: { x: 1 } }],
    ["tableau.views.get", { id: VIEW, url: "https://evil.example" }],
    ["tableau.workbooks.delete", { id: WORKBOOK }],
  ]) {
    await assert.rejects(invoke(f.provider, name, input), (e) => e._tag === "PluginFailure");
  }
  assert.equal(f.calls.length, 0);
});

test("disconnect removes credentials, ends the API session and closes pending callbacks", async (t) => {
  const f = fixture(t, (url) =>
    url.endsWith("/token") ? token() : new Response(null, { status: 204 }),
  );
  await connect(f);
  await f.provider.disconnect(lifecycle());
  assert.equal(f.values.size, 0);
  assert.ok(f.calls.some((c) => c.url.endsWith("/auth/signout") && c.options.method === "POST"));
  const flow = await f.provider.connect(["read"], lifecycle());
  const callback = new URL(flow.authorizationUrl).searchParams.get("redirect_uri");
  await f.provider.disconnect(lifecycle());
  await assert.rejects(realFetch(callback));
});

test("aborted operations and closed providers cannot start network activity", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.provider.connect(["read"], lifecycle(controller.signal)));
  await f.provider.close();
  await assert.rejects(f.provider.connect(["read"], lifecycle()));
  assert.equal(f.calls.length, 0);
});

const JOB = "55555555-5555-4555-8555-555555555555";
const CONNECTION = "66666666-6666-4666-8666-666666666666";
const metadata = () => ({
  id: WORKBOOK,
  name: "Report & forecast",
  description: "Original",
  updatedAt: "2026-10-06T00:00:00Z",
  project: { id: SITE },
  tags: { tag: [] },
});
const queued = () => Response.json({ job: { id: JOB, type: "test" } });
const file = (filename = "report.twb", source = '<workbook version="18.1"></workbook>') => ({
  filename,
  contentBase64: Buffer.from(source).toString("base64"),
});
async function writeFixture(t, respond = () => Response.json({}), detail = metadata()) {
  const f = fixture(t, (url, options) => {
    if (url.endsWith("/token")) return token();
    if (
      (options.method ?? "GET") === "GET" &&
      /\/(workbooks|datasources|views)\/[a-f0-9-]+$/u.test(url)
    )
      return Response.json({ [url.split("/").at(-2).slice(0, -1)]: detail });
    return respond(url, options);
  });
  await connect(f);
  f.calls.length = 0;
  return { ...f, detail };
}
const preview = (
  f,
  input = {
    operation: "update",
    resource: "workbooks",
    id: WORKBOOK,
    changes: { name: "New report" },
  },
) => invoke(f.provider, "tableau.changes.prepare", input);
const apply = (f, plan, context = { writeApproved: true, ...lifecycle() }) =>
  f.provider.invoke(
    "tableau.changes.apply",
    { planId: plan.planId, previewHash: plan.previewHash },
    context,
  );
const mutations = (f) => f.calls.filter((c) => c.options.method !== "GET");

test("preview is read-only and exact metadata is applied after admission exactly once", async (t) => {
  const f = await writeFixture(t, (_url, opts) => {
    assert.equal(admissions, 1);
    return Response.json({ workbook: { ...metadata(), ...JSON.parse(opts.body).workbook } });
  });
  let admissions = 0;
  const plan = await preview(f, {
    operation: "update",
    resource: "workbooks",
    id: WORKBOOK,
    changes: { description: "Revised", showTabs: false, projectId: USER },
  });
  assert.equal(plan.status, "preview");
  assert.equal(mutations(f).length, 0);
  assert.ok(!JSON.stringify(plan).includes("access-secret"));
  const result = await apply(f, plan, {
    signal: new AbortController().signal,
    writeApproved: true,
    beginCommit: async () => {
      admissions++;
      return new AbortController().signal;
    },
  });
  assert.equal(result.status, "applied");
  assert.equal(mutations(f).length, 1);
  assert.deepEqual(JSON.parse(mutations(f)[0].options.body), {
    workbook: { description: "Revised", showTabs: "false", project: { id: USER } },
  });
  await assert.rejects(apply(f, plan), (e) => e.code === "preview_required");
  assert.equal(admissions, 1);
});

test("write opt-in, commit admission, exact preview hash, and account binding are mandatory", async (t) => {
  const f = await writeFixture(t);
  const plan = await preview(f);
  await assert.rejects(
    apply(f, plan, { ...lifecycle(), writeApproved: false }),
    (e) => e.code === "write_not_approved",
  );
  await assert.rejects(
    apply(f, plan, { signal: new AbortController().signal, writeApproved: true }),
    (e) => e.code === "write_not_approved",
  );
  await assert.rejects(
    apply(f, { ...plan, previewHash: "0".repeat(64) }),
    (e) => e.code === "preview_required",
  );
  await assert.rejects(
    apply(f, plan, {
      ...lifecycle(),
      writeApproved: true,
      beginCommit: async () => {
        throw Error("denied");
      },
    }),
    /denied/u,
  );
  const credential = JSON.parse(f.values.get("connection"));
  credential.userId = USER.replace(/^2/u, "3");
  f.values.set("connection", JSON.stringify(credential));
  await assert.rejects(apply(f, plan), (e) => e.code === "preview_required");
  assert.equal(mutations(f).length, 0);
});

test("changed target metadata refuses stale preview before write admission", async (t) => {
  const f = await writeFixture(t);
  const plan = await preview(f);
  f.detail.updatedAt = "2026-10-06T01:00:00Z";
  await assert.rejects(
    apply(f, plan, {
      ...lifecycle(),
      writeApproved: true,
      beginCommit: async () => {
        assert.fail("stale target admitted");
      },
    }),
    (e) => e.code === "conflict",
  );
  assert.equal(mutations(f).length, 0);
});

test("plans expire, are bounded, and disappear on disconnect", async (t) => {
  const f = await writeFixture(t);
  const first = await preview(f);
  for (let i = 0; i < 3; i++) assert.equal((await preview(f)).status, "preview");
  assert.equal((await preview(f)).code, "too_many_previews");
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 600001);
  await assert.rejects(apply(f, first), (e) => e.code === "preview_required");
  const fresh = await preview(f);
  assert.equal(fresh.status, "preview");
  await f.provider.disconnect(lifecycle());
  await connect(f);
  await assert.rejects(apply(f, fresh), (e) => e.code === "preview_required");
});

test("concurrent attempts consume a preview only once", async (t) => {
  const f = await writeFixture(t);
  const plan = await preview(f);
  const results = await Promise.allSettled([apply(f, plan), apply(f, plan)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(mutations(f).length, 1);
});

for (const status of [403, 500, "lost"])
  test(`post-commit ${status} response never becomes success or an automatic retry`, async (t) => {
    const f = await writeFixture(t, () => {
      if (status === "lost") throw Error("private transport details");
      return new Response("private error", { status });
    });
    const plan = await preview(f);
    const result = await apply(f, plan);
    assert.equal(result.retryable, false);
    assert.equal(
      status === 403 ? result.code : result.status,
      status === 403 ? "access_denied" : "outcome_unknown",
    );
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.equal(mutations(f).length, 1);
    await assert.rejects(apply(f, plan), (e) => e.code === "preview_required");
    assert.equal((await f.provider.status(lifecycle())).state, "connected");
  });

test("abort before admission sends no write and abort after admission has a settled result", async (t) => {
  const f = await writeFixture(t);
  const plan = await preview(f);
  const c = new AbortController();
  c.abort();
  await assert.rejects(apply(f, plan, { ...lifecycle(c.signal), writeApproved: true }));
  const result = await apply(f, plan, {
    ...lifecycle(),
    writeApproved: true,
    beginCommit: async () => c.signal,
  });
  assert.equal(result.retryable, false);
  assert.equal(mutations(f).length, 0);
});

test("tags use exact resource routes and encode a removed label as one path segment", async (t) => {
  const f = await writeFixture(t, (_u, o) =>
    o.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({}),
  );
  let plan = await preview(f, {
    operation: "tags_add",
    resource: "views",
    id: WORKBOOK,
    tags: ["FY 26", "FY 26", "Review"],
  });
  assert.equal((await apply(f, plan)).status, "applied");
  assert.deepEqual(JSON.parse(mutations(f)[0].options.body), {
    tags: { tag: [{ label: "FY 26" }, { label: "Review" }] },
  });
  plan = await preview(f, {
    operation: "tags_remove",
    resource: "datasources",
    id: WORKBOOK,
    tag: "A/B & C",
  });
  assert.equal((await apply(f, plan)).status, "applied");
  assert.ok(mutations(f)[1].url.endsWith("/tags/A%2FB%20%26%20C"));
});

test("data source metadata exposes only supported fields and converts booleans", async (t) => {
  const f = await writeFixture(t);
  const plan = await preview(f, {
    operation: "update",
    resource: "datasources",
    id: WORKBOOK,
    changes: { isCertified: true, certificationNote: "Reviewed" },
  });
  assert.equal((await apply(f, plan)).status, "applied");
  assert.deepEqual(JSON.parse(mutations(f)[0].options.body), {
    datasource: { isCertified: "true", certificationNote: "Reviewed" },
  });
  assert.equal(
    (
      await preview(f, {
        operation: "update",
        resource: "datasources",
        id: WORKBOOK,
        changes: { description: "Not supported" },
      })
    ).code,
    "invalid_input",
  );
});

for (const resource of ["workbooks", "datasources"])
  test(`${resource} refresh is an asynchronous job with full refresh request`, async (t) => {
    const f = await writeFixture(t, () => queued());
    const plan = await preview(f, { operation: "refresh", resource, id: WORKBOOK });
    const result = await apply(f, plan);
    assert.equal(result.status, "queued");
    assert.equal(result.job.id, JOB);
    assert.equal(mutations(f)[0].options.body, "<tsRequest/>");
    assert.ok(mutations(f)[0].url.endsWith("/refresh"));
  });

test("publish freezes reviewed bytes, escapes XML, and only overwrites an explicit existing target", async (t) => {
  const f = await writeFixture(t, () => queued());
  const payload = file();
  const plan = await preview(f, {
    operation: "publish",
    resource: "workbooks",
    name: 'New <report> & "Q"',
    projectId: SITE,
    file: payload,
  });
  assert.equal(plan.preview.overwrite, false);
  assert.ok(!JSON.stringify(plan).includes(payload.contentBase64));
  payload.contentBase64 = Buffer.from("changed").toString("base64");
  assert.equal((await apply(f, plan)).status, "queued");
  let call = mutations(f)[0];
  assert.ok(call.url.endsWith("/workbooks?overwrite=false&asJob=true"));
  const body = call.options.body.toString();
  assert.ok(body.includes('name="New &lt;report&gt; &amp; &quot;Q&quot;"'));
  assert.ok(body.includes('name="tableau_workbook"; filename="report.twb"'));
  assert.ok(body.includes('<workbook version="18.1">'));
  const overwrite = await preview(f, {
    operation: "publish",
    resource: "workbooks",
    id: WORKBOOK,
    file: file(),
  });
  assert.equal(overwrite.preview.overwrite, true);
  await apply(f, overwrite);
  call = mutations(f)[1];
  assert.ok(call.url.includes("overwrite=true"));
  assert.ok(call.options.body.toString().includes('name="Report &amp; forecast"'));
});

test("invalid and unbounded writes fail before any mutation", async (t) => {
  const f = await writeFixture(t);
  const inputs = [
    { operation: "update", resource: "views", id: WORKBOOK, changes: { name: "x" } },
    { operation: "update", resource: "workbooks", id: WORKBOOK, changes: {} },
    { operation: "update", resource: "workbooks", id: WORKBOOK, changes: { showTabs: "true" } },
    { operation: "refresh", resource: "workbooks", id: WORKBOOK, incremental: true },
    { operation: "publish", resource: "workbooks", id: WORKBOOK, name: "wrong", file: file() },
    ...[
      file("../bad.twb"),
      file("bad.twb", "<!DOCTYPE x><workbook/>"),
      file("bad.twb", "not xml"),
      file("bad.twbx", "x"),
      file("bad.twbx", "not zip"),
      file("bad.exe"),
      { filename: "bad.twb", contentBase64: "?" },
    ].map((payload) => ({
      operation: "publish",
      resource: "workbooks",
      name: "Copy",
      projectId: SITE,
      file: payload,
    })),
  ];
  for (const input of inputs)
    assert.equal((await preview(f, input)).code, "invalid_input", JSON.stringify(input));
  assert.equal(mutations(f).length, 0);
});

const connections = () =>
  Response.json({
    connections: { connection: [{ id: CONNECTION, type: "hyper", password: "secret" }] },
  });
const hyperInput = () => ({
  operation: "hyper_update",
  resource: "datasources",
  id: WORKBOOK,
  file: file("delta.hyper", "prepared Hyper fixture"),
  actions: [
    {
      action: "upsert",
      "source-table": "Delta",
      "target-table": "Extract",
      condition: { op: "eq", "target-col": "ID", "source-col": "ID" },
    },
  ],
});
test("Hyper upload precedes PATCH with a unique RequestID and exact action batch", async (t) => {
  const f = await writeFixture(t, (url) =>
    url.endsWith("/connections")
      ? connections()
      : url.includes("/fileUploads")
        ? Response.json({ fileUpload: { uploadSessionId: "13253:ABC-0:0" } })
        : Response.json({ "job-id": JOB }),
  );
  const input = hyperInput();
  const plan = await preview(f, input);
  assert.equal(plan.status, "preview");
  const result = await apply(f, plan);
  assert.equal(result.status, "queued");
  const calls = mutations(f);
  assert.deepEqual(
    calls.map((c) => c.options.method),
    ["POST", "PUT", "PATCH"],
  );
  assert.ok(calls[1].url.endsWith("/fileUploads/13253%3AABC-0%3A0?sequenceID=1"));
  assert.ok(
    calls[1].options.body.toString().includes('name="tableau_file"; filename="delta.hyper"'),
  );
  assert.ok(
    calls[2].url.endsWith(`/datasources/${WORKBOOK}/data?uploadSessionId=13253%3AABC-0%3A0`),
  );
  assert.equal(calls[2].options.headers.RequestID, result.operationId);
  assert.deepEqual(JSON.parse(calls[2].options.body), { actions: input.actions });
});

test("failed Hyper upload never issues a data update or claims a completed write", async (t) => {
  const f = await writeFixture(t, (url) =>
    url.endsWith("/connections") ? connections() : new Response("unavailable", { status: 500 }),
  );
  const plan = await preview(f, hyperInput());
  const result = await apply(f, plan);
  assert.equal(result.status, "upload_incomplete");
  assert.equal(result.retryable, false);
  assert.equal(mutations(f).length, 1);
});

test("Hyper conditions and connection types are checked, and a changed connection blocks commit", async (t) => {
  let type = "postgres";
  const f = await writeFixture(t, () =>
    Response.json({ connections: { connection: [{ id: CONNECTION, type }] } }),
  );
  assert.equal((await preview(f, hyperInput())).code, "unsupported_datasource");
  type = "hyper";
  for (const action of [
    { action: "delete", "target-table": "X", condition: true },
    {
      action: "update",
      "source-table": "X",
      "target-table": "X",
      condition: { op: "eq", "target-col": "ID", const: { type: "date", v: "x" } },
    },
    { action: "replace", "source-table": "X", "target-table": "X", condition: { op: "eq" } },
  ]) {
    const input = hyperInput();
    input.actions = [action];
    assert.equal((await preview(f, input)).code, "invalid_input");
  }
  const plan = await preview(f, hyperInput());
  type = "postgres";
  await assert.rejects(apply(f, plan), (e) => e.code === "conflict");
  assert.equal(mutations(f).length, 0);
});

test("download preserves binary bytes, omits extracts, and rejects oversized/empty files", async (t) => {
  let content = Buffer.from([0x50, 0x4b, 0xff, 0x00]);
  const f = await writeFixture(t, () => new Response(content));
  let result = await invoke(f.provider, "tableau.workbooks.download", { id: WORKBOOK });
  assert.equal(result.status, "ok");
  assert.equal(result.contentBase64, content.toString("base64"));
  assert.ok(result.filename.endsWith(".twbx"));
  assert.ok(f.calls.at(-1).url.endsWith("/content?includeExtract=False"));
  content = Buffer.alloc(350001);
  assert.equal(
    (await invoke(f.provider, "tableau.workbooks.download", { id: WORKBOOK })).code,
    "response_too_large",
  );
  content = Buffer.alloc(0);
  assert.equal(
    (await invoke(f.provider, "tableau.workbooks.download", { id: WORKBOOK })).code,
    "invalid_response",
  );
});

test("job status distinguishes queued, success, and failed completion; connections omit credentials", async (t) => {
  let job = { id: JOB, progress: "0" };
  const f = await writeFixture(t, (url) =>
    url.endsWith("/connections") ? connections() : Response.json({ job }),
  );
  let result = await invoke(f.provider, "tableau.jobs.get", { id: JOB });
  assert.equal(result.completed, false);
  assert.equal(result.successful, null);
  job = { ...job, completedAt: "2026-10-06T00:00:00Z", finishCode: "0" };
  assert.equal((await invoke(f.provider, "tableau.jobs.get", { id: JOB })).successful, true);
  job.finishCode = "1";
  assert.equal((await invoke(f.provider, "tableau.jobs.get", { id: JOB })).successful, false);
  result = await invoke(f.provider, "tableau.datasources.connections", { id: WORKBOOK });
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("tag removal rejects URL dot segments before a write can escape the tag endpoint", async (t) => {
  const f = await writeFixture(t);
  for (const tag of [".", ".."]) {
    const plan = await preview(f, {
      operation: "tags_remove",
      resource: "workbooks",
      id: WORKBOOK,
      tag,
    });
    assert.equal(plan.code, "invalid_input");
  }
  const plan = await preview(f, {
    operation: "tags_remove",
    resource: "workbooks",
    id: WORKBOOK,
    tag: "%2e%2e",
  });
  await apply(f, plan);
  assert.equal(
    new URL(mutations(f)[0].url).pathname,
    `/api/3.27/sites/${SITE}/workbooks/${WORKBOOK}/tags/%252e%252e`,
  );
  assert.equal(mutations(f).length, 1);
});

test("malformed callback URLs return 400 without terminating the host or consuming the flow", () => {
  const providerUrl = new URL("../dist/index.mjs", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import {createIntegrationProvider} from ${JSON.stringify(providerUrl)};
    import {request} from 'node:http';
    const provider=createIntegrationProvider({configuration:{},secrets:{get:async()=>null}});
    try {
      const signal=new AbortController().signal;
      const flow=await provider.connect(['read'],{signal,beginCommit:async()=>signal});
      const auth=new URL(flow.authorizationUrl);
      const callback=new URL(auth.searchParams.get('redirect_uri'));
      const status=await new Promise((resolve,reject)=>{
        const req=request({hostname:'127.0.0.1',port:callback.port,path:'//[',method:'GET',headers:{host:callback.host}},r=>{r.resume();resolve(r.statusCode)});
        req.on('error',reject);req.end();
      });
      callback.searchParams.set('state',auth.searchParams.get('state'));
      callback.searchParams.set('code','test-code');
      const legitimate=await fetch(callback);
      console.log(JSON.stringify({malformed:status,legitimate:legitimate.status}));
    } finally {await provider.close();}
  `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { malformed: 400, legitimate: 200 });
});
