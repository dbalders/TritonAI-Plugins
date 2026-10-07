import * as NodeCrypto from "node:crypto";

import { IntegrationProviderPublicError } from "../host-contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

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
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error(`${label} contained invalid event-stream text.`);
  }
  text = text.replace(/\r\n?/gu, "\n");
  let matched: Record<string, unknown> | null = null;
  for (const block of text.split("\n\n")) {
    const dataLines: string[] = [];
    let eventType = "message";
    let meaningful = false;
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      meaningful = true;
      // Per the SSE format, a line without a colon is a field with an empty value, and unknown
      // fields (id, retry, or future ones) are ignored.
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
      if (field === "event") eventType = value.trim();
      else if (field === "data") dataLines.push(value);
    }
    if (!meaningful || dataLines.length === 0) continue;
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
  if (!matched) throw new Error(`${label} omitted its response.`);
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
