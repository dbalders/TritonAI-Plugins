import * as NodeCrypto from "node:crypto";

import { IntegrationProviderPublicError } from "../host-contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const lenientDecoder = new TextDecoder("utf-8");

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

export function boundedString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function randomBase64Url(bytes: number): string {
  return NodeCrypto.randomBytes(bytes).toString("base64url");
}

export function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

export async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  label: string,
  isComplete?: (bytes: Uint8Array) => boolean,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error(`${label} exceeded the allowed size.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeded the allowed size.`);
      }
      chunks.push(value);
      // A server may keep an event stream open after it has answered; stop once the answer is in.
      if (isComplete && isComplete(concatenate(chunks, total))) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return concatenate(chunks, total);
}

function concatenate(chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Whether an event stream received so far already holds the complete response for `id`. */
export function eventStreamHasResponse(bytes: Uint8Array, id: string): boolean {
  const text = lenientDecoder.decode(bytes).replace(/\r\n?/gu, "\n");
  const boundary = text.lastIndexOf("\n\n");
  if (boundary === -1) return false;
  for (const block of text.slice(0, boundary).split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.id === id && typeof message.method !== "string") return true;
    } catch {
      // Not this block.
    }
  }
  return false;
}

export function parseJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error(`${label} contained invalid text.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} contained invalid JSON.`);
  }
  return asRecord(value, label);
}

/**
 * Extracts the JSON-RPC response with the expected id from a Streamable HTTP POST response. An
 * event stream may carry progress or log notifications before the response; those are ignored.
 * A server-initiated request (sampling, elicitation, roots) is refused because the provider
 * cannot answer it.
 */
export function parseMcpPayload(
  response: Response,
  bytes: Uint8Array,
  id: string,
  label: string,
): Record<string, unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) return parseJson(bytes, label);
  if (!contentType.includes("text/event-stream")) {
    throw new Error(`${label} had an invalid content type.`);
  }
  let text: string;
  let cut = false;
  try {
    text = decoder.decode(bytes);
  } catch {
    // A read stopped once the answer arrived can end inside a multi-byte character of a later,
    // incomplete event. Only that trailing event may be malformed.
    text = lenientDecoder.decode(bytes);
    cut = true;
  }
  text = text.replace(/\r\n?/gu, "\n");
  const parts = text.split("\n\n");
  const trailing = text.endsWith("\n\n") ? null : (parts.pop() ?? null);
  let matched = scanEvents(parts, id, label);
  // An event is complete only at a blank line, but some servers close the stream without one.
  if (!matched && trailing !== null && !cut) matched = scanEvents([trailing], id, label);
  if (!matched) throw new Error(`${label} omitted its response.`);
  return matched;
}

function scanEvents(
  blocks: ReadonlyArray<string>,
  id: string,
  label: string,
): Record<string, unknown> | null {
  let matched: Record<string, unknown> | null = null;
  for (const block of blocks) {
    const dataLines: string[] = [];
    let eventType = "message";
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      // Per the SSE format, a line without a colon is a field with an empty value, and unknown
      // fields (id, retry, or future ones) are ignored.
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
      if (field === "event") eventType = value.trim();
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) continue;
    if (eventType !== "message") throw new Error(`${label} used an unsupported event type.`);
    const message = parseJson(encoder.encode(dataLines.join("\n")), label);
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        throw new IntegrationProviderPublicError(
          "The service asked for an interactive MCP response that TritonAI Harness does not support.",
        );
      }
      continue;
    }
    if (message.id !== id) throw new Error(`${label} contained a mismatched response.`);
    if (matched) throw new Error(`${label} contained duplicate responses.`);
    matched = message;
  }
  return matched;
}

export function assertJsonBounds(value: unknown, serviceName: string): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new IntegrationProviderPublicError(
      `${serviceName} tool input must be bounded JSON data.`,
    );
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_INPUT_BYTES) {
    throw new IntegrationProviderPublicError(
      `${serviceName} tool input exceeds the two-megabyte limit.`,
    );
  }
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new IntegrationProviderPublicError(
        `${serviceName} tool input is too deeply nested or complex.`,
      );
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      throw new IntegrationProviderPublicError(
        `${serviceName} tool input must not contain cycles.`,
      );
    }
    seen.add(current.value);
    if (
      !Array.isArray(current.value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(current.value))
    ) {
      throw new IntegrationProviderPublicError(
        `${serviceName} tool input must contain only JSON objects.`,
      );
    }
    for (const child of Object.values(current.value)) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}
