import assert from "node:assert/strict";
import { once } from "node:events";
import * as Http from "node:http";
import test from "node:test";

import { createIntegrationProvider } from "../artifacts/jira-data-center/plugin.mjs";

const READ = "jira-data-center.read";
const WRITE = "jira-data-center.write";
const brokerOrigin = "https://broker.example";
const jiraOrigin = "https://its-pro.ucsd.edu";

for (const scope of ["READ", "WRITE"]) {
  test(
    `packaged Jira search works over HTTP with ${scope} OAuth scope`,
    { timeout: 15_000 },
    async (t) => {
      const requests = [];
      const server = Http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const url = new URL(request.url, "http://localhost");
        requests.push({ method: request.method, url, body });
        const reply = (status, value) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (url.pathname === "/v1/token" && request.method === "POST") {
          reply(200, {
            access_token: `fixture-${scope}`,
            refresh_token: "fixture-rotated",
            expires_in: 3600,
            scope,
          });
          return;
        }
        if (request.headers.authorization !== `Bearer fixture-${scope}`) {
          reply(401, {});
        } else if (scope === "READ" && request.method !== "GET") {
          // Jira's OAuth READ grant refuses POST /search even though search is a read operation.
          reply(403, { errorMessages: ["READ scope does not permit this HTTP method"] });
        } else if (url.pathname === "/rest/api/2/myself" && request.method === "GET") {
          reply(200, { key: "fixture-user", name: "fixture-user", displayName: "Fixture User" });
        } else if (url.pathname === "/rest/api/2/search") {
          reply(200, {
            startAt: 7,
            maxResults: 2,
            total: 10,
            issues: [
              {
                id: "10001",
                key: "ITS-1",
                fields: { summary: "Fixture issue", description: "Must not be projected" },
              },
            ],
          });
        } else {
          reply(404, {});
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const loopback = `http://127.0.0.1:${server.address().port}`;
      const fetch = globalThis.fetch;
      let provider;
      t.after(async () => {
        globalThis.fetch = fetch;
        await provider?.close();
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await closed;
      });
      // Route only the provider's fixed origins to a real local HTTP server, preserving Node fetch.
      globalThis.fetch = async (input, init) => {
        const url = new URL(input);
        assert.ok([brokerOrigin, jiraOrigin].includes(url.origin));
        const response = await fetch(new URL(url.pathname + url.search, loopback), init);
        // Keep the logical destination visible to the provider's fixed-origin response check.
        Object.defineProperty(response, "url", { value: url.href });
        return response;
      };
      const capabilities = scope === "READ" ? [READ] : [READ, WRITE];
      const credentials = new Map([
        [
          "oauth-credential",
          JSON.stringify({
            version: 2,
            refreshToken: "fixture-refresh",
            scope,
            capabilities,
            account: { key: "fixture-user", name: "fixture-user", displayName: "Fixture User" },
            updatedAt: "2026-10-14T00:00:00.000Z",
          }),
        ],
      ]);
      provider = createIntegrationProvider({
        configuration: { brokerUrl: brokerOrigin, oauthClientId: "fixture-client" },
        secrets: {
          get: async (name) => credentials.get(name) ?? null,
          set: async (name, value) => credentials.set(name, value),
          remove: async (name) => credentials.delete(name),
        },
      });
      const signal = AbortSignal.timeout(10_000);
      const context = { signal, beginCommit: async () => signal, writeApproved: false };
      await provider.prepare(context);
      const exchange = requests.find(({ url }) => url.pathname === "/v1/token");
      assert.equal(exchange.method, "POST");
      assert.deepEqual(JSON.parse(exchange.body), {
        grant_type: "refresh_token",
        refresh_token: "fixture-refresh",
      });
      assert.deepEqual((await provider.status(context)).grantedCapabilities, capabilities);
      assert.equal(JSON.parse(credentials.get("oauth-credential")).refreshToken, "fixture-rotated");
      assert.equal((await provider.invoke("jira.me.get", {}, context)).user.key, "fixture-user");

      const jql = 'project = ITS AND summary ~ "printer & toner"';
      const result = await provider.invoke(
        "jira.issues.search",
        { jql, startAt: 7, maxResults: 2 },
        context,
      );
      assert.equal(result.returned, 1);
      assert.equal(result.hasMore, true);
      assert.equal(result.issues[0].key, "ITS-1");
      assert.equal(result.issues[0].url, `${jiraOrigin}/browse/ITS-1`);
      assert.equal(result.issues[0].description, undefined);
      const search = requests.find(({ url }) => url.pathname === "/rest/api/2/search");
      assert.equal(search.method, "GET");
      assert.equal(search.body, "");
      assert.equal(search.url.searchParams.get("jql"), jql);
      assert.equal(search.url.searchParams.get("startAt"), "7");
      assert.equal(search.url.searchParams.get("maxResults"), "2");
      assert.equal(
        search.url.searchParams.get("fields"),
        "summary,status,issuetype,priority,assignee,reporter,project,created,updated,resolution,labels",
      );
      if (scope === "READ") {
        const before = requests.length;
        await assert.rejects(
          provider.invoke(
            "jira.changes.prepare_add_comment",
            { issueKey: "ITS-1", body: "Forbidden with READ scope" },
            context,
          ),
          (error) => error.code === "capability_required",
        );
        assert.equal(requests.length, before, "write capability rejection must not send HTTP");
      }
      assert.ok(
        requests
          .filter(({ url }) => url.pathname !== "/v1/token")
          .every(({ method }) => method === "GET"),
      );
    },
  );
}
