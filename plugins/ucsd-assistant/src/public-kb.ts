import { pluginFailure, type JsonObject } from "@tritonai/plugin-sdk";
import type { DefaultTreeAdapterTypes } from "parse5";
import { HtmlLimitError, htmlBudget, parseBoundedHtml, type HtmlBudget } from "./bounded-html.js";

const ORIGIN = "https://support.ucsd.edu";
const ENDPOINT = `${ORIGIN}/api/now/sp/search`;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;
const TIMEOUT_MS = 20_000;
const PORTALS = Object.freeze({
  services: "d0b13947db85485059f17e09af9619a6",
  // Anonymous /its bootstrap: NOW.portal_id and NOW.portal_url_suffix, 2026-10-22.
  its: "7d109165db3f33802aee71dabf961984",
});

export interface PublicKnowledgeInput {
  readonly query: string;
  readonly portal?: "services" | "its";
  readonly limit?: number;
}

export const publicKnowledgeInputSchema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 1_000, pattern: "\\S" },
    portal: { type: "string", enum: ["services", "its"], default: "services" },
    limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/** POST is the portal's search transport; this operation performs no record mutation. */
export const publicKnowledgeSearchEffect = "read" as const;

export interface PublicKnowledgeArticle extends JsonObject {
  readonly number: string;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly snippetKind: "search_snippet";
  readonly snippetTruncated: boolean;
  readonly requiresOriginalPageVerification: true;
  readonly published: string | null;
  readonly publishedUTC: string | null;
}

export interface PublicKnowledgeResult extends JsonObject {
  readonly source: "UC San Diego public ServiceNow knowledge search";
  readonly query: string;
  readonly portal: "services" | "its";
  readonly retrievedAt: string;
  readonly receivedCount: number;
  readonly returnedCount: number;
  readonly results: readonly PublicKnowledgeArticle[];
  readonly provenance: JsonObject;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function validateInput(input: unknown): string | null {
  if (!isPlainRecord(input)) return "$ must be object";
  if (!Object.hasOwn(input, "query")) return "$.query is required";
  if (typeof input.query !== "string") return "$.query must be string";
  if (input.query.length === 0) return "$.query must have at least 1 characters";
  // JSON Schema string lengths count Unicode code points, including astral characters.
  if (Array.from(input.query).length > 1_000) return "$.query must have at most 1000 characters";
  if (!/\S/u.test(input.query)) return "$.query does not match the required pattern";
  if (Object.hasOwn(input, "portal")) {
    if (typeof input.portal !== "string") return "$.portal must be string";
    if (input.portal !== "services" && input.portal !== "its")
      return '$.portal must be one of "services", "its"';
  }
  if (Object.hasOwn(input, "limit")) {
    if (typeof input.limit !== "number" || !Number.isInteger(input.limit))
      return "$.limit must be integer";
    if (input.limit < 1) return "$.limit must be at least 1";
    if (input.limit > 20) return "$.limit must be at most 20";
  }
  for (const key of Reflect.ownKeys(input)) {
    if (key !== "query" && key !== "portal" && key !== "limit")
      return `$.${String(key)} is not allowed`;
  }
  return null;
}

/** Only called on parsed JSON: the root has depth zero and each value counts as a node. */
function assertResponseJsonBounds(value: unknown): void {
  let nodes = 0;
  function visit(current: unknown, depth: number): void {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw changed();
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) visit(child, depth + 1);
    }
  }
  visit(value, 0);
}

const EXCLUDED_HTML = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
  "svg",
  "math",
]);

async function textOnly(value: string, budget: HtmlBudget): Promise<string> {
  const nodes: DefaultTreeAdapterTypes.Node[] = [await parseBoundedHtml(value, budget, true)];
  const parts: string[] = [];
  while (nodes.length) {
    budget.step();
    const node = nodes.pop()!;
    if (node.nodeName === "#text") {
      parts.push((node as DefaultTreeAdapterTypes.TextNode).value);
    } else if (!("tagName" in node && EXCLUDED_HTML.has(node.tagName)) && "childNodes" in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) nodes.push(node.childNodes[i]);
    }
  }
  return parts.join(" ").replace(/\s+/gu, " ").trim();
}

function changed() {
  return pluginFailure(
    "public_kb_api_changed",
    "The public ServiceNow portal search interface changed or returned an invalid response. " +
      "It is an observed portal interface, not a published API. Update the plugin; do not try credentials.",
  );
}

function cancelled(external: AbortSignal) {
  return external.aborted
    ? pluginFailure("public_kb_cancelled", "Public knowledge search was cancelled.")
    : pluginFailure(
        "public_kb_timeout",
        "Public knowledge search exceeded its 20-second deadline.",
        { retryable: true },
      );
}

/** Also bounds stalled response bodies and transports which fail to reject on abort. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      void promise.catch(() => undefined);
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function responseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const tooLarge = () =>
    pluginFailure(
      "public_kb_response_too_large",
      "Public knowledge search exceeded the 2 MiB response limit.",
    );
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    if (/^\d+$/u.test(length)) throw tooLarge();
    throw changed();
  }
  const reader = response.body?.getReader();
  if (!reader) throw changed();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw tooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function parseResults(bytes: Uint8Array): unknown[] {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertResponseJsonBounds(decoded);
    if (!isPlainRecord(decoded) || !isPlainRecord(decoded.result)) throw changed();
    const envelope = decoded;
    const result = decoded.result;
    if (
      envelope.error !== undefined ||
      result.error !== undefined ||
      !Array.isArray(result.results)
    )
      throw changed();
    // The observed API reports total_number_results: 0 even with valid results.
    return result.results;
  } catch {
    throw changed();
  }
}

function originalDate(value: unknown): string | null {
  // Preserve the source's date verbatim, with no inferred timezone or freshness claim.
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

/** Anonymous, bounded public search only. Original article access/content is not verified here. */
export async function searchPublicKnowledge(
  input: PublicKnowledgeInput,
  signal: AbortSignal,
): Promise<PublicKnowledgeResult> {
  if (signal.aborted) throw cancelled(signal);
  const invalid = validateInput(input);
  if (invalid) throw pluginFailure("invalid_input", invalid);
  const query = input.query.trim();
  const portal = input.portal ?? "services";
  const limit = input.limit ?? 5;
  const expiresAt = performance.now() + TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
  const operation = AbortSignal.any([signal, deadline.signal]);
  const budget = htmlBudget(() => {
    if (operation.aborted || performance.now() >= expiresAt) throw cancelled(signal);
  });
  try {
    const pending = fetch(ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ query, count: limit, portal: PORTALS[portal], include_facets: false }),
      credentials: "omit",
      redirect: "error",
      signal: operation,
    });
    // Dispose a late response even if a transport did not honor the abort signal.
    void pending.then(
      (response) => {
        if (operation.aborted) void response.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    const response = await withAbort(pending, operation);
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.headers.has("www-authenticate")
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw pluginFailure(
        "public_kb_authorization_required",
        "The public knowledge portal denied anonymous access. No login or credentials will be attempted.",
      );
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => undefined);
      throw changed();
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw pluginFailure(
        "public_kb_unavailable",
        `Public knowledge search returned HTTP ${response.status}.`,
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw changed();
    }
    const records = parseResults(await responseBytes(response, operation));
    budget.check();
    const results: PublicKnowledgeArticle[] = [];
    const seen = new Set<string>();
    for (const value of records) {
      budget.step();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw changed();
      const record = value as Record<string, unknown>;
      if (record.table !== "kb_knowledge") {
        if (
          typeof record.table === "string" ||
          (typeof record.type === "string" && record.type !== "kb")
        )
          continue;
        throw changed();
      }
      if (record.type !== undefined && record.type !== "kb") continue;
      const number = record.number;
      if (typeof number !== "string" || !/^KB[0-9]{7}$/u.test(number) || seen.has(number)) continue;
      let title = "";
      for (const key of ["short_description", "primary", "label"]) {
        if (typeof record[key] === "string")
          title = (await textOnly(record[key], budget)).slice(0, 512);
        if (title) break;
      }
      if (!title || (record.text !== undefined && typeof record.text !== "string")) throw changed();
      seen.add(number);
      if (results.length >= limit) continue;
      const snippet = await textOnly(typeof record.text === "string" ? record.text : "", budget);
      results.push({
        number,
        title,
        // Never use record.link: the live API returned one wrong link for distinct KB articles.
        url: `${ORIGIN}/${portal}?id=kb_article_view&sysparm_article=${number}`,
        snippet: snippet.slice(0, 1_500),
        snippetKind: "search_snippet",
        snippetTruncated: snippet.length > 1_500,
        requiresOriginalPageVerification: true,
        published: originalDate(record.published),
        publishedUTC: originalDate(record.publishedUTC),
      });
    }
    budget.check();
    return {
      source: "UC San Diego public ServiceNow knowledge search",
      query,
      portal,
      retrievedAt: new Date().toISOString(),
      receivedCount: records.length,
      returnedCount: results.length,
      results,
      provenance: {
        endpoint: ENDPOINT,
        method: "POST",
        effect: publicKnowledgeSearchEffect,
        access: "anonymous",
        portalUrl: `${ORIGIN}/${portal}`,
        interface: "observed_public_portal_interface_not_published_api",
        resultKind: "search_snippets",
        requiresOriginalPageVerification: true,
        guidance:
          "Retrieve each original public article and confirm its title and content before citing. Search snippets do not verify article access or freshness. retrievedAt records only this search retrieval time.",
      },
    };
  } catch (error) {
    if (operation.aborted) throw cancelled(signal);
    if (error instanceof HtmlLimitError)
      throw pluginFailure("public_kb_response_too_complex", error.message);
    if (error && typeof error === "object" && "_tag" in error && error._tag === "PluginFailure")
      throw error;
    throw pluginFailure(
      "public_kb_unavailable",
      "Anonymous public knowledge search failed. Redirects are refused and credentials are never attempted.",
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}
