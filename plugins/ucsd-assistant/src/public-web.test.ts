import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  agents: vi.fn(),
  destroyAgent: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({
  Agent: class {
    constructor(options: unknown) {
      network.agents(options);
    }
    destroy() {
      network.destroyAgent();
    }
  },
  request: network.request,
}));

import { checkPublicPageUrl, readPublicPage } from "./public-web.ts";

interface Reply {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: string | Buffer | Buffer[];
  holdOpen?: boolean;
}
const replies: Reply[] = [];
const streams: PassThrough[] = [];
const sourceUrl = "https://blink.ucsd.edu/finance/index.html";
const html =
  "<!doctype html><title>Campus policy</title><main><h1>Travel rules</h1><p>Read the current policy.</p></main>";
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  replies.length = 0;
  streams.length = 0;
  network.lookup.mockReset().mockResolvedValue([{ address: "132.239.1.2", family: 4 }]);
  network.request
    .mockReset()
    .mockImplementation(
      (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
        const reply = replies.shift();
        if (!reply) throw new Error("Unexpected network request");
        const stream = new PassThrough();
        const response = Object.assign(stream, {
          statusCode: reply.status ?? 200,
          headers: { "content-type": "text/html; charset=utf-8", ...reply.headers },
        }) as unknown as IncomingMessage;
        streams.push(stream);
        const req = Object.assign(new EventEmitter(), {
          end() {
            queueMicrotask(() => {
              callback(response);
              if (!reply.holdOpen) {
                for (const bytes of Array.isArray(reply.body) ? reply.body : [reply.body ?? html])
                  stream.write(bytes);
                stream.end();
              }
            });
          },
        });
        const cancel = () => {
          stream.destroy();
          req.emit("error", new Error("private transport abort details"));
        };
        options.signal?.addEventListener("abort", cancel, { once: true });
        stream.once("close", () => options.signal?.removeEventListener("abort", cancel));
        return req;
      },
    );
});

afterEach(() => {
  for (const stream of streams) stream.destroy();
  vi.useRealTimers();
});

describe("public page URL boundary", () => {
  it.each([
    "https://ucsd.edu/",
    "https://blink.ucsd.edu/finance/",
    "https://department.ucsd.edu:443/",
    "https://policy.ucop.edu/",
    "https://www.ucop.edu/",
    "https://ucnet.universityofcalifornia.edu/",
    "https://ucsdtritons.com/",
    "https://www.ucsdtritons.com/",
  ])("allows the official source %s", (url) => {
    expect(checkPublicPageUrl(url)).toBeInstanceOf(URL);
  });

  it.each([
    "http://blink.ucsd.edu/",
    "https://blink.ucsd.edu:8443/",
    "https://user:secret@blink.ucsd.edu/",
    "https://ucsd.edu.example.com/",
    "https://evilucsd.edu/",
    "https://policy.ucop.edu.example.com/",
    "https://example.com/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "file:///etc/passwd",
    "not a url",
    "https://blink.ucsd.edu./",
    "https://sso.ucsd.edu/",
    "https://blink.ucsd.edu/%6cogin/",
    "https://blink.ucsd.edu/saml/start",
    "https://blink.ucsd.edu/?access_token=secret",
    "https://blink.ucsd.edu/\\@example.com/",
    "https://tritongpt.ucsd.edu/",
    "https://tritongpt-stage.ucsd.edu/admin/",
    "https://tritongpt-dev.ucsd.edu/",
  ])("rejects unsafe, nonofficial or authenticated URLs: %s", (url) => {
    expect(() => checkPublicPageUrl(url)).toThrow();
  });

  it("clones URL inputs and strips fragments without mutating the caller", () => {
    const input = new URL(`${sourceUrl}#section`);
    expect(checkPublicPageUrl(input).href).toBe(sourceUrl);
    expect(input.hash).toBe("#section");
  });
});

describe("one bounded public original page", () => {
  it("extracts titles, headings and meaningful links while excluding hidden and executable content", async () => {
    replies.push({
      body: `<!doctype html><html><head><title>Travel &amp; policy</title>
      <script>head-secret</script><style>style-secret</style><base href="https://example.com/"></head>
      <body><nav>nav-secret</nav><header><h1>Travel guidance</h1></header><main>
      <p>Book <strong>approved</strong> travel &amp; retain receipts.</p>
      <a href="../policy.html">Campus <strong>policy</strong></a>
      <a href="https://policy.ucop.edu/doc">UC policy</a>
      <a href="https://example.com/">External link</a><a href="javascript:alert(1)">Script link</a>
      <a href="/login">Sign-in link</a><a href="#local">Local anchor</a>
      <p hidden>hidden-secret</p><p aria-hidden="true">aria-secret</p>
      <p style="display: none !important">display-secret</p><p style="visibility:hidden">visibility-secret</p>
      <p class="visually-hidden">class-secret</p><div inert>inert-secret</div>
      <div role="navigation">role-secret</div><script>body-secret</script><noscript>noscript-secret</noscript>
      <iframe>frame-secret</iframe><template>template-secret</template></main><footer>footer-secret</footer></body></html>`,
    });
    const result = await readPublicPage(sourceUrl, signal());
    expect(result).toMatchObject({
      url: sourceUrl,
      requestedUrl: sourceUrl,
      title: "Travel & policy",
      links: [
        { title: "Campus policy", url: "https://blink.ucsd.edu/policy.html" },
        { title: "UC policy", url: "https://policy.ucop.edu/doc" },
      ],
      contentType: "text/html",
      redirectCount: 0,
      truncated: false,
      untrustedContent: true,
    });
    expect(result.text).toContain("Travel guidance");
    expect(result.text).toContain("Book approved travel & retain receipts.");
    expect(result.text).not.toContain("-secret");
    expect(result.text).not.toContain("Travel & policy"); // Head title is separate from body evidence.
    expect(Number.isNaN(Date.parse(result.retrievedAt))).toBe(false);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(network.request).toHaveBeenCalledTimes(1); // No links or scripts were fetched.
  });

  it("dials the checked IP with the official TLS identity and fixed, credential-free GET headers", async () => {
    replies.push({});
    await readPublicPage(sourceUrl, signal());
    expect(network.lookup).toHaveBeenCalledWith("blink.ucsd.edu", { all: true, verbatim: true });
    const options = network.request.mock.calls[0]![0] as RequestOptions;
    expect(options).toMatchObject({
      hostname: "132.239.1.2",
      family: 4,
      port: 443,
      servername: "blink.ucsd.edu",
      rejectUnauthorized: true,
      method: "GET",
      path: "/finance/index.html",
      headers: { Host: "blink.ucsd.edu", "Accept-Encoding": "identity" },
    });
    const headerNames = Object.keys(options.headers ?? {}).map((key) => key.toLowerCase());
    expect(headerNames).not.toContain("cookie");
    expect(headerNames).not.toContain("authorization");
    expect(network.agents).toHaveBeenCalledWith({ keepAlive: false, proxyEnv: {} });
    expect(network.destroyAgent).toHaveBeenCalledTimes(1);
  });

  it("revalidates each allowed redirect, pins its own DNS answer and ignores Set-Cookie", async () => {
    replies.push(
      {
        status: 302,
        headers: { location: "https://policy.ucop.edu/doc", "set-cookie": ["session=secret"] },
      },
      { body: "<h1>University policy</h1>Public evidence" },
    );
    network.lookup
      .mockResolvedValueOnce([{ address: "132.239.1.2", family: 4 }])
      .mockResolvedValueOnce([{ address: "2607:f720:1000:100::1", family: 6 }]);
    const page = await readPublicPage(sourceUrl, signal());
    expect(page).toMatchObject({
      url: "https://policy.ucop.edu/doc",
      requestedUrl: sourceUrl,
      redirectCount: 1,
    });
    expect(network.lookup.mock.calls.map((call) => call[0])).toEqual([
      "blink.ucsd.edu",
      "policy.ucop.edu",
    ]);
    expect(network.request.mock.calls[1]![0]).toMatchObject({
      hostname: "2607:f720:1000:100::1",
      family: 6,
      servername: "policy.ucop.edu",
    });
    expect(JSON.stringify(network.request.mock.calls)).not.toContain("session=secret");
  });

  it.each([
    "https://example.com/",
    "http://blink.ucsd.edu/",
    "https://127.0.0.1/",
    "https://sso.ucsd.edu/",
    "https://user:secret@blink.ucsd.edu/",
  ])("rejects a redirect outside the public boundary: %s", async (location) => {
    replies.push({ status: 302, headers: { location } });
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(
      /redirected to a disallowed/u,
    );
    expect(network.lookup).toHaveBeenCalledTimes(1);
    expect(network.request).toHaveBeenCalledTimes(1);
  });

  it("refuses private DNS on a same-host redirect instead of trusting the earlier answer", async () => {
    replies.push({ status: 301, headers: { location: "/next" } });
    network.lookup
      .mockResolvedValueOnce([{ address: "132.239.1.2", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(/public network addresses/u);
    expect(network.request).toHaveBeenCalledTimes(1);
  });

  it("allows four redirects and refuses a fifth", async () => {
    for (let i = 0; i < 4; i += 1)
      replies.push({ status: 302, headers: { location: `/step${i}` } });
    replies.push({});
    expect(await readPublicPage(sourceUrl, signal())).toMatchObject({ redirectCount: 4 });
    expect(network.request).toHaveBeenCalledTimes(5);
    network.request.mockClear();
    for (let i = 0; i < 5; i += 1)
      replies.push({ status: 302, headers: { location: `/step${i}` } });
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(/four-redirect limit/u);
    expect(network.request).toHaveBeenCalledTimes(5);
  });

  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.254",
    "127.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.0.0.9",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::a00:1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "3fff::1",
  ])("rejects a special-purpose or reserved DNS answer: %s", async (address) => {
    network.lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(/public network addresses/u);
    expect(network.request).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private DNS answers, empty answers and malformed address records", async () => {
    for (const records of [
      [
        { address: "132.239.1.2", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      [],
      [{ address: "not-an-address", family: 4 }],
      [{ address: "132.239.1.2", family: 6 }],
    ]) {
      network.lookup.mockResolvedValue(records);
      await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(
        /public network addresses/u,
      );
    }
    expect(network.request).not.toHaveBeenCalled();
  });

  it("returns bounded text and deduplicated links with explicit truncation fields", async () => {
    replies.push({
      body: `<h1>Long policy</h1><p>${"x".repeat(30_000)}</p>${Array.from({ length: 45 }, (_, i) => `<a href="/policy${i}">Policy ${i}</a><a href="/policy${i}">Duplicate</a>`).join("")}`,
    });
    const page = await readPublicPage(sourceUrl, signal());
    expect(page.text).toHaveLength(20_000);
    expect(page.links).toHaveLength(40);
    expect(page).toMatchObject({ truncated: true, textTruncated: true, linksTruncated: true });
  });

  it("rejects a sub-MiB deeply nested page promptly, before output truncation", async () => {
    const body = `<main>${"<div>".repeat(90_000)}Campus policy${"</div>".repeat(90_000)}</main>`;
    expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024);
    replies.push({ body });
    const started = performance.now();
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(/HTML.*limit/u);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("retains a shallow MiB-sized page within the parsing budget", async () => {
    replies.push({ body: `<main>${`<p>${"Campus policy ".repeat(80)}</p>`.repeat(1_000)}</main>` });
    const started = performance.now();
    await expect(readPublicPage(sourceUrl, signal())).resolves.toMatchObject({
      textTruncated: true,
      text: expect.stringContaining("Campus policy"),
    });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("honors caller cancellation during HTML parsing after the response completes", async () => {
    replies.push({ body: `<p>${"Campus policy ".repeat(80_000)}</p>` });
    const controller = new AbortController();
    const pending = readPublicPage(sourceUrl, controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toThrow("Public page read cancelled.");
    expect(network.destroyAgent).toHaveBeenCalledTimes(1);
  });

  it("checks elapsed time during parsing even before the deadline timer can fire", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    replies.push({ body: `<p>${"Campus policy ".repeat(80_000)}</p>` });
    const pending = readPublicPage(sourceUrl, signal());
    setImmediate(() => vi.advanceTimersByTime(20_000));
    await expect(pending).rejects.toThrow("Public page read timed out after 20 seconds.");
  });

  it.each(["text/plain; charset=utf-8", "text/plain; charset=windows-1252"])(
    "accepts plain text: %s",
    async (contentType) => {
      replies.push({
        headers: { "content-type": contentType },
        body: "Campus policy\n\nOriginal public text.",
      });
      expect(await readPublicPage(sourceUrl, signal())).toMatchObject({
        contentType: "text/plain",
        text: "Campus policy\n\nOriginal public text.",
        links: [],
      });
    },
  );

  it.each(["application/pdf", "image/png", "application/json", "application/octet-stream", ""])(
    "refuses non-page content type: %s",
    async (contentType) => {
      replies.push({ headers: { "content-type": contentType } });
      await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(
        /not an HTML or plain-text page/u,
      );
      expect(streams[0]?.destroyed).toBe(true);
    },
  );

  it.each(["gzip", "br", "deflate", "gzip, br"])(
    "rejects compressed responses rather than risking inflated content: %s",
    async (encoding) => {
      replies.push({ headers: { "content-encoding": encoding } });
      await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(/Compressed responses/u);
    },
  );

  it("checks declared bytes before reading and streamed bytes without Content-Length", async () => {
    replies.push({ headers: { "content-length": String(2 * 1024 * 1024 + 1) }, holdOpen: true });
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(/2 MiB/u);
    replies.push({
      headers: { "content-type": "text/plain" },
      body: [Buffer.alloc(1024 * 1024, "x"), Buffer.alloc(1024 * 1024 + 1, "x")],
    });
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(/2 MiB/u);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
  });

  it.each([
    "<title>UC San Diego Sign In</title><p>Please continue</p>",
    "<title>Just a moment...</title><p>Checking your browser</p>",
    "<form><input type='password'></form><p>University portal</p>",
    "<meta http-equiv='refresh' content='0;url=/login'><p>Redirecting</p>",
    "<div>Verify that you are human</div>",
    "<script>document.write('JS-only content')</script>",
  ])("refuses sign-in, browser gates and empty JS pages", async (body) => {
    replies.push({ body });
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(/interstitial/u);
  });

  it.each(["Loading...", "Loading…", "Please wait.", "Please enable JavaScript to continue."])(
    "rejects an application shell rather than reporting article content: %s",
    async (text) => {
      replies.push({
        body: `<title>UCSD Knowledge Article</title><div>${text}</div><script>app()</script>`,
      });
      await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(
        /application loading shell/u,
      );
    },
  );

  it("retains real short content that mentions loading", async () => {
    replies.push({
      body: "<title>Loading zones</title><main>Loading zones require a permit.</main>",
    });
    await expect(readPublicPage(sourceUrl, signal())).resolves.toMatchObject({
      text: "Loading zones require a permit.",
    });
  });

  it("rejects binary/PDF bytes mislabeled as text and invalid encodings", async () => {
    for (const body of ["%PDF-1.7 fake PDF", "binary\u0000data", Buffer.from([0xff])]) {
      replies.push({ headers: { "content-type": "text/plain" }, body });
      await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(/binary|encoding/u);
    }
  });

  it("cancels before lookup and while DNS is pending without starting a connection", async () => {
    const first = new AbortController();
    first.abort(new Error("secret abort reason"));
    await expect(readPublicPage(sourceUrl, first.signal)).rejects.toThrow(
      "Public page read cancelled.",
    );
    expect(network.lookup).not.toHaveBeenCalled();
    let finishLookup!: (value: { address: string; family: number }[]) => void;
    network.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve;
        }),
    );
    const second = new AbortController();
    const pending = readPublicPage(sourceUrl, second.signal);
    second.abort();
    await expect(pending).rejects.toThrow(/cancelled/u);
    finishLookup([{ address: "132.239.1.2", family: 4 }]);
    await Promise.resolve();
    expect(network.request).not.toHaveBeenCalled();
  });

  it("cancels an in-flight response and tears down its private agent", async () => {
    replies.push({ holdOpen: true });
    const controller = new AbortController();
    const pending = readPublicPage(sourceUrl, controller.signal);
    await vi.waitFor(() => expect(network.request).toHaveBeenCalledTimes(1));
    controller.abort(new Error("private details"));
    await expect(pending).rejects.toThrow("Public page read cancelled.");
    expect(network.destroyAgent).toHaveBeenCalledTimes(1);
    expect(streams[0]?.destroyed).toBe(true);
  });

  it("enforces one 20-second deadline including DNS lookup", async () => {
    vi.useFakeTimers();
    network.lookup.mockImplementation(() => new Promise(() => undefined));
    const pending = readPublicPage(sourceUrl, signal());
    const assertion = expect(pending).rejects.toThrow(
      "Public page read timed out after 20 seconds.",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(network.request).not.toHaveBeenCalled();
  });

  it("keeps the original deadline while reading a response after slow DNS", async () => {
    vi.useFakeTimers();
    replies.push({ holdOpen: true });
    network.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ address: "132.239.1.2", family: 4 }]), 12_000);
        }),
    );
    const pending = readPublicPage(sourceUrl, signal());
    const assertion = expect(pending).rejects.toThrow(/timed out after 20 seconds/u);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(network.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
    expect(network.destroyAgent).toHaveBeenCalledTimes(1);
    expect(streams[0]?.destroyed).toBe(true);
  });

  it("sanitizes DNS and transport failures instead of echoing upstream details", async () => {
    network.lookup.mockRejectedValueOnce(new Error("secret dns details"));
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(
      "Unable to read the public source.",
    );
    network.request.mockImplementationOnce(() => {
      throw new Error("secret transport details");
    });
    await expect(readPublicPage(sourceUrl, signal())).rejects.toThrow(
      "Unable to read the public source.",
    );
    expect(network.destroyAgent).toHaveBeenCalledTimes(1);
  });
});
