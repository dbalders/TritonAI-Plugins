import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  publicKnowledgeInputSchema,
  publicKnowledgeSearchEffect,
  searchPublicKnowledge,
  type PublicKnowledgeInput,
} from "./public-kb.js";

const ENDPOINT = "https://support.ucsd.edu/api/now/sp/search";
const signal = () => new AbortController().signal;
const article = (number = "KB0033306", fields: Record<string, unknown> = {}) => ({
  table: "kb_knowledge",
  type: "kb",
  number,
  short_description: "How to Calculate Per Diem for Travel in Concur",
  primary: "Fallback title",
  label: "Last fallback",
  text: "Overview of travel allowances.",
  published: "2026-10-19",
  publishedUTC: "2026-10-19",
  // Real public API anomaly: this field was identical for distinct articles.
  link: "/its?id=kb_article_view&sysparm_article=KB0030144",
  ...fields,
});
const response = (results: unknown[] = [article()], extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ result: { results, total_number_results: 0, ...extra } }), {
    status: 201,
    headers: { "Content-Type": "application/json;charset=UTF-8" },
  });

describe("anonymous public knowledge search", () => {
  const fetcher = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetcher.mockReset();
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("posts only the public search fields with no credentials or redirects", async () => {
    fetcher.mockResolvedValue(response());
    const result = await searchPublicKnowledge({ query: "  travel  " }, signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(new Headers(init?.headers)).toEqual(
      new Headers({ Accept: "application/json", "Content-Type": "application/json" }),
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "travel",
      count: 5,
      portal: "d0b13947db85485059f17e09af9619a6",
      include_facets: false,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result.query).toBe("travel");
    expect(publicKnowledgeSearchEffect).toBe("read");
  });

  it("uses the independently verified public IT portal ID and its article route", async () => {
    fetcher.mockResolvedValue(response([article("KB0020109")]));
    const result = await searchPublicKnowledge({ query: "vpn", portal: "its", limit: 3 }, signal());
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({
      query: "vpn",
      count: 3,
      portal: "7d109165db3f33802aee71dabf961984",
      include_facets: false,
    });
    expect(result.results[0].url).toBe(
      "https://support.ucsd.edu/its?id=kb_article_view&sysparm_article=KB0020109",
    );
  });

  it("constructs distinct canonical article URLs and counts results despite a zero total", async () => {
    fetcher.mockResolvedValue(response([article(), article("KB0032591"), article("KB0032823")]));
    const result = await searchPublicKnowledge({ query: "travel", limit: 3 }, signal());
    expect(result).toMatchObject({ receivedCount: 3, returnedCount: 3 });
    expect(result.results.map((item) => item.url)).toEqual(
      ["KB0033306", "KB0032591", "KB0032823"].map(
        (number) =>
          `https://support.ucsd.edu/services?id=kb_article_view&sysparm_article=${number}`,
      ),
    );
    expect(JSON.stringify(result)).not.toContain("KB0030144");
  });

  it("never trusts arbitrary links or derives article identifiers from them", async () => {
    fetcher.mockResolvedValue(
      response([
        article("KB0033306", { link: "https://attacker.example/steal" }),
        article("KB0032591", { link: "javascript:alert(1)" }),
        article("KB0032823", { link: "http://127.0.0.1/private" }),
        article("https://attacker.example/KB0033306", {
          link: "/services?id=kb_article_view&sysparm_article=KB0033306",
        }),
        article("KB0033306&sysparm_query=private"),
        article("KB123"),
        article("kb0033306"),
        article("KB00333060"),
        article("KB0033306\n"),
        article("", { number: undefined }),
      ]),
    );
    const result = await searchPublicKnowledge({ query: "travel", limit: 20 }, signal());
    expect(result.returnedCount).toBe(3);
    for (const item of result.results)
      expect(item.url).toMatch(
        /^https:\/\/support\.ucsd\.edu\/services\?id=kb_article_view&sysparm_article=KB[0-9]{7}$/u,
      );
    expect(JSON.stringify(result)).not.toMatch(/attacker|javascript|127\.0\.0\.1|sysparm_query/u);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("filters other tables and categories and deduplicates article numbers", async () => {
    fetcher.mockResolvedValue(
      response([
        article(),
        article("KB0033306", { short_description: "Duplicate" }),
        article("KB0032591", { table: "sc_cat_item" }),
        article("KB0032823", { type: "category" }),
        { table: "kb_category", label: "Travel category" },
        { type: "category", label: "Category without a table" },
        article("KB0020109"),
      ]),
    );
    const result = await searchPublicKnowledge({ query: "travel" }, signal());
    expect(result.receivedCount).toBe(7);
    expect(result.returnedCount).toBe(2);
    expect(result.results.map((item) => item.number)).toEqual(["KB0033306", "KB0020109"]);
  });

  it("enforces the caller limit even if the service ignores count", async () => {
    fetcher.mockResolvedValue(
      response(Array.from({ length: 25 }, (_, i) => article(`KB${String(i).padStart(7, "0")}`))),
    );
    const result = await searchPublicKnowledge({ query: "travel", limit: 2 }, signal());
    expect(result).toMatchObject({ receivedCount: 25, returnedCount: 2 });
    expect(result.results).toHaveLength(2);
  });

  it("caps results at 20 and makes a single request", async () => {
    fetcher.mockResolvedValue(
      response(Array.from({ length: 25 }, (_, i) => article(`KB${String(i).padStart(7, "0")}`))),
    );
    const result = await searchPublicKnowledge({ query: "travel", limit: 20 }, signal());
    expect(result.results).toHaveLength(20);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("decodes and strips HTML, bounds snippets, and labels them as unverified excerpts", async () => {
    fetcher.mockResolvedValue(
      response([
        article("KB0033306", {
          short_description: "<b>Travel &amp; Finance</b><script>hidden title</script>",
          text: `<p>Meal &amp; lodging <strong>allowances</strong>.</p><script>hidden script</script><style>hidden style</style><template>hidden template</template><img src='https://attacker.example'>${"x".repeat(1600)}`,
        }),
      ]),
    );
    const result = await searchPublicKnowledge({ query: "travel" }, signal());
    expect(result.results[0]).toMatchObject({
      title: "Travel & Finance",
      snippetKind: "search_snippet",
      snippetTruncated: true,
      requiresOriginalPageVerification: true,
    });
    expect(result.results[0].snippet).toHaveLength(1500);
    expect(result.results[0].snippet).toMatch(/^Meal & lodging allowances/u);
    expect(result.results[0].snippet).not.toMatch(/hidden|<|attacker/u);
  });

  it.each(["short_description", "text"])(
    "rejects a sub-MiB deeply nested HTML %s before truncation",
    async (field) => {
      const deep = `${"<div>".repeat(90_000)}Campus policy${"</div>".repeat(90_000)}`;
      expect(Buffer.byteLength(deep)).toBeLessThan(1024 * 1024);
      fetcher.mockResolvedValue(response([article("KB0033306", { [field]: deep })]));
      const started = performance.now();
      await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
        code: "public_kb_response_too_complex",
        retryable: false,
      });
      expect(performance.now() - started).toBeLessThan(2_000);
    },
  );

  it("cancels while parsing a knowledge excerpt after its response completes", async () => {
    fetcher.mockResolvedValue(
      response([article("KB0033306", { text: "Campus policy ".repeat(80_000) })]),
    );
    const controller = new AbortController();
    const pending = searchPublicKnowledge({ query: "travel" }, controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ code: "public_kb_cancelled" });
  });

  it("keeps the original elapsed deadline through knowledge HTML parsing", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    fetcher.mockResolvedValue(
      response([article("KB0033306", { text: "Campus policy ".repeat(80_000) })]),
    );
    const pending = searchPublicKnowledge({ query: "travel" }, signal());
    setImmediate(() => vi.advanceTimersByTime(20_000));
    await expect(pending).rejects.toMatchObject({ code: "public_kb_timeout", retryable: true });
  });

  it.each([
    [{ short_description: undefined }, "Fallback title"],
    [{ short_description: "<script>hidden</script>", primary: "" }, "Last fallback"],
    [{ short_description: "x".repeat(700) }, "x".repeat(512)],
  ])("uses bounded title fallbacks: %j", async (fields, title) => {
    fetcher.mockResolvedValue(response([article("KB0033306", fields)]));
    const result = await searchPublicKnowledge({ query: "travel" }, signal());
    expect(result.results[0].title).toBe(title);
  });

  it("preserves original source dates and provides public source provenance without freshness claims", async () => {
    const published = "2026-10-19 15:21:00";
    fetcher.mockResolvedValue(
      response([
        article("KB0033306", { published, publishedUTC: "2026-10-19" }),
        article("KB0032591", { published: undefined, publishedUTC: undefined }),
      ]),
    );
    const before = Date.now();
    const result = await searchPublicKnowledge({ query: "travel" }, signal());
    expect(Date.parse(result.retrievedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.retrievedAt)).toBeLessThanOrEqual(Date.now());
    expect(result.source).toBe("UC San Diego public ServiceNow knowledge search");
    expect(result.results[0]).toMatchObject({ published, publishedUTC: "2026-10-19" });
    expect(result.results[1]).toMatchObject({ published: null, publishedUTC: null });
    expect(result.provenance).toMatchObject({
      endpoint: ENDPOINT,
      method: "POST",
      effect: "read",
      access: "anonymous",
      portalUrl: "https://support.ucsd.edu/services",
      interface: "observed_public_portal_interface_not_published_api",
      resultKind: "search_snippets",
      requiresOriginalPageVerification: true,
    });
    expect(result.provenance.guidance).toMatch(/before citing/u);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result).not.toHaveProperty("freshness");
    expect(result).not.toHaveProperty("total_number_results");
  });

  it("returns successful empty results only for a valid empty search response", async () => {
    fetcher.mockResolvedValue(response([]));
    await expect(
      searchPublicKnowledge({ query: "no matching article" }, signal()),
    ).resolves.toMatchObject({ receivedCount: 0, returnedCount: 0, results: [] });
  });

  it.each([401, 403])(
    "reports HTTP %i as denied anonymous access, without retrying credentials",
    async (status) => {
      fetcher.mockResolvedValue(new Response("Denied", { status }));
      await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
        code: "public_kb_authorization_required",
        retryable: false,
        message: expect.stringContaining("No login or credentials"),
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects an authentication challenge even on a 200 response", async () => {
    fetcher.mockResolvedValue(
      new Response("{}", {
        headers: { "www-authenticate": "Bearer", "content-type": "application/json" },
      }),
    );
    await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
      code: "public_kb_authorization_required",
    });
  });

  it.each([
    null,
    [],
    "results",
    1,
    {},
    { result: null },
    { result: [] },
    { result: "results" },
    { result: {} },
    { result: { results: null } },
    { result: { results: {} } },
    { error: { message: "Unauthorized" }, result: { results: [] } },
    { result: { results: [], error: { message: "Failed" } } },
    { result: { results: [null] } },
    { result: { results: [[]] } },
    { result: { results: [{ label: "Changed shape" }] } },
    {
      result: {
        results: [
          article("KB0033306", {
            short_description: undefined,
            primary: undefined,
            label: undefined,
          }),
        ],
      },
    },
    { result: { results: [article("KB0033306", { text: { unexpected: "object" } })] } },
  ])("reports schema drift rather than empty results: %j", async (body) => {
    fetcher.mockResolvedValue(
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
    await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
      code: "public_kb_api_changed",
      retryable: false,
    });
  });

  it.each([
    ["<html>Sign in</html>", "text/html"],
    ["not JSON", "application/json"],
    ["{}", "text/plain"],
    [new Uint8Array([0xff]), "application/json"],
  ])(
    "rejects HTML, malformed JSON, wrong content types and invalid UTF-8: %s",
    async (body, contentType) => {
      fetcher.mockResolvedValue(new Response(body, { headers: { "content-type": contentType } }));
      await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
        code: "public_kb_api_changed",
      });
    },
  );

  it.each([
    [32, true],
    [33, false],
  ])("bounds response JSON at depth %i (accepted: %s)", async (depth, accepted) => {
    let nested: unknown = null;
    // response.result.extra starts at depth 2; the root object is depth 0.
    for (let i = 2; i < depth; i++) nested = { child: nested };
    fetcher.mockResolvedValue(response([], { extra: nested }));
    const pending = searchPublicKnowledge({ query: "travel" }, signal());
    if (accepted) await expect(pending).resolves.toMatchObject({ results: [] });
    else
      await expect(pending).rejects.toMatchObject({
        code: "public_kb_api_changed",
        retryable: false,
      });
  });

  it.each([
    [100_000, true],
    [100_001, false],
  ])("bounds all response JSON at %i nodes (accepted: %s)", async (nodes, accepted) => {
    // The envelope, result, results array, total and extra array account for five nodes.
    const body = response([], { extra: Array(nodes - 5).fill(null) });
    expect((await body.clone().arrayBuffer()).byteLength).toBeLessThan(2 * 1024 * 1024);
    fetcher.mockResolvedValue(body);
    const pending = searchPublicKnowledge({ query: "travel" }, signal());
    if (accepted) await expect(pending).resolves.toMatchObject({ results: [] });
    else
      await expect(pending).rejects.toMatchObject({
        code: "public_kb_api_changed",
        retryable: false,
      });
  });

  it.each([302, 307])("refuses a redirect response (HTTP %i)", async (status) => {
    fetcher.mockResolvedValue(
      new Response(null, { status, headers: { location: "https://login.ucsd.edu/" } }),
    );
    await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
      code: "public_kb_api_changed",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports transport/redirect refusal as failure rather than an empty search", async () => {
    fetcher.mockRejectedValue(new TypeError("fetch failed"));
    await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
      code: "public_kb_unavailable",
      message: expect.stringContaining("Redirects are refused"),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, true],
    [503, true],
    [404, false],
  ])("reports HTTP %i availability separately", async (status, retryable) => {
    fetcher.mockResolvedValue(new Response("Error", { status: status as number }));
    await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
      code: "public_kb_unavailable",
      retryable,
    });
  });

  it("rejects an oversized declared response before reading it, and cancels the body", async () => {
    const cancel = vi.fn();
    fetcher.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: {
          "content-type": "application/json",
          "content-length": String(2 * 1024 * 1024 + 1),
        },
      }),
    );
    await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
      code: "public_kb_response_too_large",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds a streamed response without content-length and cancels overflow", async () => {
    const cancel = vi.fn();
    let reads = 0;
    fetcher.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            reads++;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await expect(searchPublicKnowledge({ query: "travel" }, signal())).rejects.toMatchObject({
      code: "public_kb_response_too_large",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reads).toBeLessThanOrEqual(4);
  });

  it("does not dispatch a cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchPublicKnowledge({ query: "travel" }, controller.signal),
    ).rejects.toMatchObject({ code: "public_kb_cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels a stalled fetch and forwards abort to the transport", async () => {
    fetcher.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = searchPublicKnowledge({ query: "travel" }, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "public_kb_cancelled" });
    controller.abort();
    await assertion;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("cancels a stalled response body", async () => {
    const cancel = vi.fn();
    fetcher.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const controller = new AbortController();
    const pending = searchPublicKnowledge({ query: "travel" }, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "public_kb_cancelled" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["fetch", "body"])("enforces the 20-second deadline during stalled %s", async (phase) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    if (phase === "fetch") fetcher.mockImplementation(() => new Promise(() => undefined));
    else
      fetcher.mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "application/json" },
        }),
      );
    const pending = searchPublicKnowledge({ query: "travel" }, signal());
    const assertion = expect(pending).rejects.toMatchObject({
      code: "public_kb_timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    if (phase === "body") expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    undefined,
    null,
    true,
    "travel",
    [],
    Object.assign([], { query: "travel" }),
    Object.create({ query: "travel" }),
    Object.assign(Object.create({}), { query: "travel" }),
    {},
    { query: "" },
    { query: " \n\t" },
    { query: "\u00a0\u2003" },
    { query: "x".repeat(1001) },
    { query: "😀".repeat(1001) },
    { query: `${" ".repeat(1000)}x` },
    { query: 12 },
    { query: "travel", limit: undefined },
    { query: "travel", limit: null },
    { query: "travel", limit: "5" },
    { query: "travel", limit: true },
    { query: "travel", limit: NaN },
    { query: "travel", limit: Infinity },
    { query: "travel", limit: 0 },
    { query: "travel", limit: 21 },
    { query: "travel", limit: 1.5 },
    { query: "travel", portal: undefined },
    { query: "travel", portal: null },
    { query: "travel", portal: 1 },
    { query: "travel", portal: "other" },
    { query: "travel", url: "http://localhost" },
    { query: "travel", headers: { Authorization: "not allowed" } },
    { query: "travel", credentials: "include" },
    { query: "travel", cookies: "not allowed" },
    { query: "travel", extra: undefined },
    { query: "travel", constructor: "not allowed" },
    JSON.parse('{"query":"travel","__proto__":{"credentials":"include"}}'),
    { query: "travel", [Symbol("headers")]: "not allowed" },
  ])("rejects invalid or credential-bearing input before dispatch: %j", async (input) => {
    await expect(
      searchPublicKnowledge(input as PublicKnowledgeInput, signal()),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { query: "x", portal: "services", limit: 1 },
    { query: "x".repeat(1000), portal: "services", limit: 20 },
    { query: "😀".repeat(1000), portal: "its", limit: 20 },
    { query: "\u200b" },
    Object.assign(Object.create(null), { query: "travel" }),
  ])("accepts exact input boundaries and Unicode character lengths: %j", async (input) => {
    fetcher.mockResolvedValue(response([]));
    await expect(
      searchPublicKnowledge(input as PublicKnowledgeInput, signal()),
    ).resolves.toMatchObject({
      query: input.query,
      portal: input.portal ?? "services",
      results: [],
    });
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).count).toBe(input.limit ?? 5);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("exports the exact supported input contract", () => {
    expect(publicKnowledgeInputSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" },
        portal: { type: "string", enum: ["services", "its"], default: "services" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    });
  });
});
