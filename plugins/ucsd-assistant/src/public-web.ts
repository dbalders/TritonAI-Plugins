import { lookup } from "node:dns/promises";
import { Agent, request } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { defaultTreeAdapter, type DefaultTreeAdapterTypes } from "parse5";
import { HtmlLimitError, htmlBudget, parseBoundedHtml, type HtmlBudget } from "./bounded-html.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 20_000;
const MAX_LINKS = 40;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 20_000;

// Deliberately not caller-configurable. Add only independently verified official source hosts.
const OFFICIAL_HOSTS = Object.freeze([
  "policy.ucop.edu",
  "www.ucop.edu",
  "ucnet.universityofcalifornia.edu",
  "ucsdtritons.com",
  "www.ucsdtritons.com",
  "secure4.compliancebridge.com",
]);
const AUTH_PATH =
  /(?:^|\/)(?:login|log-in|signin|sign-in|sso|saml|oauth2?|authorize|shibboleth|cas)(?:\/|[.;]|$)/iu;
const AUTH_HOST = /(?:^|\.)(?:login|signin|sso|shib|shibboleth|adfs|auth)(?:\.|$)/iu;
const AUTH_QUERY =
  /^(?:access_token|id_token|refresh_token|token|api[_-]?key|authorization|password|passwd|credential|sessionid|samlrequest|samlresponse|ticket)$/iu;

class PublicPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicPageError";
  }
}

/** Syntactic/host policy only; readPublicPage also validates DNS before every connection. */
export function checkPublicPageUrl(value: string | URL): URL {
  let url: URL;
  try {
    const raw = typeof value === "string" ? value : value.href;
    // eslint-disable-next-line no-control-regex -- Reject URL controls before URL normalization.
    if (raw.length > 8_192 || /[\u0000-\u0020\u007f\\]/u.test(raw)) throw new Error();
    url = new URL(raw);
  } catch {
    throw new PublicPageError("Provide a valid public HTTPS page URL.");
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
    throw new PublicPageError("Public pages must use HTTPS on port 443.");
  }
  if (url.username || url.password) {
    throw new PublicPageError("URLs containing credentials are not allowed.");
  }
  const host = url.hostname;
  if (["tritongpt.ucsd.edu", "tritongpt-stage.ucsd.edu", "tritongpt-dev.ucsd.edu"].includes(host)) {
    throw new PublicPageError(
      "Use an original public source page; this reader does not connect to Onyx.",
    );
  }
  if (
    !(host === "ucsd.edu" || host.endsWith(".ucsd.edu") || OFFICIAL_HOSTS.includes(host)) ||
    isIP(host) !== 0
  ) {
    throw new PublicPageError("This host is not an allowed official public campus source.");
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new PublicPageError("The page URL has an invalid path.");
  }
  if (
    host === "secure4.compliancebridge.com" &&
    (!path.startsWith("/ucsd/public/") || /\\|(?:^|\/)\.{1,2}(?:\/|$)|%/u.test(path))
  ) {
    throw new PublicPageError("Only the UCSD public policy directory is supported on this host.");
  }
  if (
    AUTH_HOST.test(host) ||
    AUTH_PATH.test(path) ||
    [...url.searchParams.keys()].some((key) => AUTH_QUERY.test(key))
  ) {
    throw new PublicPageError("Sign-in and authenticated page URLs are not supported.");
  }
  url.hash = "";
  return url;
}

function publicAddress(address: string, family: number): boolean {
  if (isIP(address) !== family) return false;
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    // Special-purpose, private, loopback, link-local, documentation, multicast and reserved.
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        ((b === 0 && (c === 0 || c === 2)) ||
          (b === 31 && c === 196) ||
          (b === 52 && c === 193) ||
          (b === 88 && c === 99) ||
          b === 168 ||
          (b === 175 && c === 48))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || /[%.]/u.test(address)) return false;
  const [left = "", right] = address.toLowerCase().split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const words = (
    right === undefined
      ? start
      : [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end]
  ).map((part) => Number.parseInt(part, 16));
  const [a = 0, b = 0, c = 0] = words;
  // Only ordinary global unicast. Excludes mapped IPv4, NAT64, ULA, local scopes,
  // Teredo/other IETF special assignments, 6to4 and both documentation prefixes.
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    !(a === 0x2001 && (b < 0x0200 || b === 0x0db8)) &&
    a !== 0x2002 &&
    !(a === 0x3fff && b < 0x1000) &&
    !(a === 0x2620 && b === 0x004f && c === 0x8000)
  );
}

function aborted(signal: AbortSignal): PublicPageError {
  return new PublicPageError(
    signal.reason instanceof PublicPageError
      ? signal.reason.message
      : "Public page read cancelled.",
  );
}

/** DNS lookup itself cannot be cancelled, but a late answer must never start a request. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted(signal));
    if (signal.aborted) {
      reject(aborted(signal));
      // Observe a rejected operation even if cancellation already won the race.
      void operation.catch(() => undefined);
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

interface PageResponse {
  readonly status: number;
  readonly location?: string;
  readonly contentType?: string;
  readonly bytes?: Buffer;
}

async function readResponse(response: IncomingMessage, signal: AbortSignal): Promise<PageResponse> {
  const status = response.statusCode ?? 0;
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    throw new PublicPageError(
      "Compressed responses are not supported; the source must honor identity encoding.",
    );
  }
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = response.headers.location;
    if (!location)
      throw new PublicPageError("The source returned a redirect without a destination.");
    return { status, location };
  }
  if (status === 401 || status === 403 || response.headers["www-authenticate"]) {
    throw new PublicPageError("The source requires sign-in or denies public access.");
  }
  if (status < 200 || status >= 300) {
    throw new PublicPageError(`The public source returned HTTP ${status}.`);
  }
  const contentType = response.headers["content-type"] ?? "";
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (!["text/html", "application/xhtml+xml", "text/plain"].includes(mediaType)) {
    throw new PublicPageError(
      "This source is not an HTML or plain-text page; PDF and other downloads are not supported.",
    );
  }
  const length = response.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) {
    throw new PublicPageError("The public page exceeds the 2 MiB download limit.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    if (signal.aborted) throw aborted(signal);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_BYTES)
      throw new PublicPageError("The public page exceeds the 2 MiB download limit.");
    chunks.push(bytes);
  }
  return { status, contentType, bytes: Buffer.concat(chunks, size) };
}

async function fetchPage(url: URL, signal: AbortSignal): Promise<PageResponse> {
  const addresses = await withAbort(lookup(url.hostname, { all: true, verbatim: true }), signal);
  if (signal.aborted) throw aborted(signal);
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => !publicAddress(address, family))
  ) {
    throw new PublicPageError(
      "The source does not resolve exclusively to public network addresses.",
    );
  }
  const address = addresses[0]!;
  // Dial the checked literal address, retaining the original TLS identity and HTTP Host.
  // A private agent disables environment proxies, connection reuse and a second DNS lookup.
  const agent = new Agent({ keepAlive: false, proxyEnv: {} });
  try {
    return await withAbort(
      new Promise<PageResponse>((resolve, reject) => {
        const req = request(
          {
            protocol: "https:",
            hostname: address.address,
            family: address.family,
            port: 443,
            servername: url.hostname,
            rejectUnauthorized: true,
            method: "GET",
            path: url.pathname + url.search,
            agent,
            signal,
            maxHeaderSize: 16 * 1024,
            headers: {
              Host: url.hostname,
              Accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
              "Accept-Encoding": "identity",
              "User-Agent": "TritonAI-UCSD-Assistant/1.0 (public-page reader)",
              Connection: "close",
            },
          },
          (response) => {
            void readResponse(response, signal)
              .then(resolve, reject)
              .finally(() => response.destroy());
          },
        );
        req.on("error", reject);
        req.end();
      }),
      signal,
    );
  } finally {
    agent.destroy();
  }
}

type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;
const OMIT = new Set([
  "head",
  "script",
  "style",
  "nav",
  "footer",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "form",
  "input",
  "button",
  "select",
  "textarea",
]);
const BLOCK = new Set([
  "address",
  "article",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
const INTERSTITIAL_TITLE =
  /^(?:(?:uc san diego|ucsd|university of california)[\s:|–—-]+)?(?:sign[ -]?in|log[ -]?in|single sign[ -]?on|sso)(?:\s*[|:–—-]\s*(?:uc san diego|ucsd|university of california))?[.!…]*$|\b(?:access denied|authentication required|just a moment|attention required|checking your browser|verify (?:you are|you're) human)\b/iu;
const INTERSTITIAL_TEXT =
  /(?:verify (?:that )?you are (?:a )?human|enable javascript and cookies|checking your browser)|^(?:please )?(?:sign[ -]?in|log[ -]?in) to continue[.!…]*$/iu;
const attr = (node: HtmlElement, name: string) =>
  node.attrs.find((item) => item.name === name)?.value;
const normalize = (text: string) =>
  text
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

function omitted(node: HtmlElement): boolean {
  return (
    OMIT.has(node.tagName) ||
    attr(node, "hidden") !== undefined ||
    attr(node, "inert") !== undefined ||
    attr(node, "aria-hidden")?.toLowerCase() === "true" ||
    /^(?:navigation|contentinfo)$/iu.test(attr(node, "role") ?? "") ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))(?:\s*!important)?\s*(?:;|$)/iu.test(
      attr(node, "style") ?? "",
    ) ||
    /(?:^|\s)(?:hidden|d-none|sr-only|visually-hidden)(?:\s|$)/u.test(attr(node, "class") ?? "")
  );
}

function nodeText(root: HtmlNode, budget: HtmlBudget): string {
  const pieces: string[] = [];
  const stack = [root];
  while (stack.length) {
    budget.step();
    const node = stack.pop()!;
    if (defaultTreeAdapter.isTextNode(node)) pieces.push(node.value);
    else if ("childNodes" in node && (!defaultTreeAdapter.isElementNode(node) || !omitted(node))) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index]!);
      }
    }
  }
  return normalize(pieces.join(""));
}

async function extractHtml(source: string, url: URL, budget: HtmlBudget) {
  const document = await parseBoundedHtml(source, budget);
  let title = "";
  let firstHeading = "";
  const pieces: string[] = [];
  const links: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  let linksTruncated = false;
  let documentBase = url;
  let foundBase = false;
  // Inspect the parsed document for sign-in/refresh gates, including inside omitted forms/head.
  const inspect: HtmlNode[] = [document];
  while (inspect.length) {
    budget.step();
    const node = inspect.pop()!;
    if (defaultTreeAdapter.isElementNode(node)) {
      if (node.tagName === "title" && !title) title = nodeText(node, budget).slice(0, 500);
      const baseHref = node.tagName === "base" ? attr(node, "href") : undefined;
      if (
        !foundBase &&
        node.namespaceURI === "http://www.w3.org/1999/xhtml" &&
        baseHref !== undefined
      ) {
        foundBase = true;
        // HTML uses the first base[href], even if it is invalid. Resolve against
        // the final response URL; invalid, data: and javascript: bases fall back.
        try {
          const candidate = new URL(baseHref, url);
          if (candidate.protocol !== "data:" && candidate.protocol !== "javascript:")
            documentBase = candidate;
        } catch {
          budget.check();
        }
      }
      if (
        (node.tagName === "input" && attr(node, "type")?.toLowerCase() === "password") ||
        (node.tagName === "meta" && attr(node, "http-equiv")?.toLowerCase() === "refresh")
      ) {
        throw new PublicPageError(
          "The source is a sign-in or redirect interstitial, not a readable public page.",
        );
      }
    }
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        inspect.push(node.childNodes[index]!);
      }
    }
  }
  const stack: { node: HtmlNode; end?: boolean }[] = [{ node: document }];
  while (stack.length) {
    budget.step();
    const { node, end } = stack.pop()!;
    if (end) {
      pieces.push("\n");
      continue;
    }
    if (defaultTreeAdapter.isTextNode(node)) {
      pieces.push(node.value.replace(/\s+/gu, " "));
      continue;
    }
    if (defaultTreeAdapter.isElementNode(node)) {
      if (omitted(node)) continue;
      if (node.tagName === "h1" && !firstHeading)
        firstHeading = nodeText(node, budget).slice(0, 500);
      if (BLOCK.has(node.tagName)) {
        pieces.push("\n");
        stack.push({ node, end: true });
      }
      const href = node.tagName === "a" ? attr(node, "href") : undefined;
      if (href && !href.startsWith("#")) {
        try {
          // Keep a disallowed base for resolution: ignoring it could invent an
          // official destination. Only each resolved destination is eligible.
          const target = checkPublicPageUrl(new URL(href, documentBase)).href;
          const label =
            nodeText(node, budget) || attr(node, "aria-label") || attr(node, "title") || "";
          if (label && !seen.has(target)) {
            seen.add(target);
            if (links.length < MAX_LINKS) links.push({ title: label.slice(0, 200), url: target });
            else linksTruncated = true;
          }
        } catch (error) {
          budget.check();
          if (error instanceof HtmlLimitError) throw error;
          // Omit non-public links. Neither links nor <base> cause any network request.
        }
      }
    }
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node.childNodes[index]! });
      }
    }
  }
  return {
    title: title || firstHeading || url.hostname,
    text: normalize(pieces.join("")),
    links,
    linksTruncated,
  };
}

export type PublicPage = {
  readonly url: string;
  readonly requestedUrl: string;
  readonly title: string;
  readonly text: string;
  readonly links: { title: string; url: string }[];
  readonly retrievedAt: string;
  readonly contentType: string;
  readonly bytesRead: number;
  readonly redirectCount: number;
  readonly truncated: boolean;
  readonly textTruncated: boolean;
  readonly linksTruncated: boolean;
  readonly untrustedContent: true;
};

/** Read one original public page. No cookies, credentials, indexing, scripts or linked fetches. */
export async function readPublicPage(
  value: string,
  externalSignal: AbortSignal,
): Promise<PublicPage> {
  const initial = checkPublicPageUrl(value);
  const expiresAt = performance.now() + TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new PublicPageError("Public page read timed out after 20 seconds.")),
    TIMEOUT_MS,
  );
  timer.unref();
  const signal = AbortSignal.any([externalSignal, deadline.signal]);
  const budget = htmlBudget(() => {
    if (signal.aborted) throw aborted(signal);
    if (performance.now() >= expiresAt)
      throw new PublicPageError("Public page read timed out after 20 seconds.");
  });
  try {
    let url = initial;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (signal.aborted) throw aborted(signal);
      const response = await fetchPage(url, signal);
      if (response.location !== undefined) {
        if (redirects === MAX_REDIRECTS)
          throw new PublicPageError("The source exceeded the four-redirect limit.");
        try {
          url = checkPublicPageUrl(new URL(response.location, url));
        } catch {
          throw new PublicPageError("The source redirected to a disallowed or authenticated page.");
        }
        continue;
      }
      const bytes = response.bytes!;
      const contentType = response.contentType!;
      const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
      const charset = /;\s*charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1] ?? "utf-8";
      let source: string;
      try {
        source = new TextDecoder(charset, { fatal: true }).decode(bytes);
      } catch {
        throw new PublicPageError("The source uses an unsupported or invalid text encoding.");
      }
      // eslint-disable-next-line no-control-regex -- Refuse binary bytes mislabeled as a text page.
      if (/^\s*%PDF-/u.test(source) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source)) {
        throw new PublicPageError(
          "The source contains a download or binary data instead of a readable page.",
        );
      }
      const page =
        mediaType === "text/plain"
          ? { title: url.hostname, text: normalize(source), links: [], linksTruncated: false }
          : await extractHtml(source, url, budget);
      budget.check();
      if (
        /^(?:loading[.!…]*|please wait[.!…]*|(?:please )?enable javascript(?: to (?:continue|view (?:this (?:page|site)|the content)))?[.!…]*)$/iu.test(
          page.text,
        )
      ) {
        throw new PublicPageError(
          "The source returned an application loading shell. Use a browser to read the original page.",
        );
      }
      if (
        !page.text ||
        INTERSTITIAL_TITLE.test(page.title) ||
        (page.text.length < 1_500 && INTERSTITIAL_TEXT.test(page.text))
      ) {
        throw new PublicPageError(
          "The source is empty, requires sign-in, or presents a browser interstitial.",
        );
      }
      const textTruncated = page.text.length > MAX_TEXT;
      return {
        url: url.href,
        requestedUrl: initial.href,
        title: page.title,
        text: page.text.slice(0, MAX_TEXT),
        links: page.links,
        retrievedAt: new Date().toISOString(),
        contentType: mediaType,
        bytesRead: bytes.length,
        redirectCount: redirects,
        truncated: textTruncated || page.linksTruncated,
        textTruncated,
        linksTruncated: page.linksTruncated,
        untrustedContent: true,
      };
    }
    throw new PublicPageError("The source exceeded the four-redirect limit.");
  } catch (error) {
    if (signal.aborted) throw aborted(signal);
    if (error instanceof HtmlLimitError) throw new PublicPageError(error.message);
    if (error instanceof PublicPageError) throw error;
    throw new PublicPageError(
      "Unable to read the public source. Check the URL or try again later.",
    );
  } finally {
    clearTimeout(timer);
  }
}
