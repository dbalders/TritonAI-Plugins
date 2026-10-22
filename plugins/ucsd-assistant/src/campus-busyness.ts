import { request, Agent } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { pluginFailure } from "@tritonai/plugin-sdk";

const SOURCE_URL = "https://waitz.io/live/ucsd-geisel";
const OFFICIAL_CLIENT_URL = "https://library.ucsd.edu/assets/availability/mobile/index.html";
const MAX_BYTES = 512 * 1024;
const MAX_SOURCE_LOCATIONS = 64;
const MAX_SUB_LOCATIONS = 32;
const TIMEOUT_MS = 10_000;

class CampusBusynessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampusBusynessError";
  }
}

export type CampusBusynessSpace = {
  readonly id: number;
  readonly name: string;
  readonly abbreviation: string | null;
  readonly isAvailable: boolean;
  readonly isOpen: boolean;
  readonly status: "open" | "closed" | "unavailable";
  readonly hourSummary: string;
  readonly busynessPercent: number | null;
  readonly occupancyFraction: number | null;
  readonly estimatedPeople: number | null;
  readonly capacity: number;
};

export type CampusBusyness = {
  readonly source: {
    readonly provider: string;
    readonly url: string;
    readonly officialClientUrl: string;
  };
  readonly retrievedAt: string;
  readonly httpDate: string | null;
  readonly sourceObservedAt: null;
  readonly bytesRead: number;
  readonly units: {
    readonly busynessPercent: string;
    readonly occupancyFraction: string;
    readonly estimatedPeople: string;
    readonly capacity: string;
  };
  readonly locations: (CampusBusynessSpace & {
    readonly subLocations: CampusBusynessSpace[];
  })[];
  readonly totalLocations: number;
  readonly matchingLocations: number;
  readonly returnedLocations: number;
  readonly truncated: boolean;
  readonly notes: readonly string[];
  readonly untrustedContent: true;
};

function parseInput(input: unknown): { location: string; limit: number } {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  ) {
    throw pluginFailure("invalid_input", "Input must be a plain object.");
  }
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).some(
      (key) => typeof key !== "string" || !["location", "limit"].includes(key),
    ) ||
    Object.values(fields).some((field) => !field.enumerable || !("value" in field))
  ) {
    throw pluginFailure("invalid_input", "Input contains an unsupported field.");
  }
  const location: unknown = fields.location?.value;
  if (
    fields.location &&
    (typeof location !== "string" ||
      !location.trim() ||
      location.length > 120 ||
      // eslint-disable-next-line no-control-regex -- Reject controls in caller text.
      /[\u0000-\u001f\u007f]/u.test(location))
  ) {
    throw pluginFailure("invalid_input", "location must contain 1–120 printable characters.");
  }
  const limit: unknown = fields.limit?.value;
  if (
    fields.limit &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20)
  ) {
    throw pluginFailure("invalid_input", "limit must be an integer from 1 to 20.");
  }
  return {
    location: typeof location === "string" ? location.trim().toLowerCase() : "",
    limit: typeof limit === "number" ? limit : 14,
  };
}

function schemaError(): never {
  throw new CampusBusynessError("The campus busyness source returned an unsupported data format.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) schemaError();
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex -- Source fields must be bounded plain text.
    /[\u0000-\u001f\u007f<>]/u.test(value)
  ) {
    schemaError();
  }
  return value.trim();
}

function number(value: unknown, max: number, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  ) {
    schemaError();
  }
  return value;
}

function space(value: unknown): CampusBusynessSpace {
  const row = record(value);
  if (typeof row.isAvailable !== "boolean" || typeof row.isOpen !== "boolean") schemaError();
  const hourSummary = text(row.hourSummary, 120);
  const busynessPercent = number(row.busyness, 100);
  const occupancyFraction = number(row.percentage, 1);
  const estimatedPeople = number(row.people, 1_000_000, true);
  return {
    id: number(row.id, 1_000_000_000, true),
    name: text(row.name, 200),
    abbreviation: row.abbreviation === undefined ? null : text(row.abbreviation, 24),
    isAvailable: row.isAvailable,
    isOpen: row.isOpen,
    status:
      !row.isOpen || hourSummary.toLowerCase() === "closed"
        ? "closed"
        : row.isAvailable
          ? "open"
          : "unavailable",
    hourSummary,
    // Unavailable zero placeholders must not become a claim of an empty space.
    busynessPercent: row.isAvailable ? busynessPercent : null,
    occupancyFraction: row.isAvailable ? occupancyFraction : null,
    estimatedPeople: row.isAvailable ? estimatedPeople : null,
    capacity: number(row.capacity, 1_000_000, true),
  };
}

function locations(value: unknown): CampusBusyness["locations"] {
  const data = record(value).data;
  if (!Array.isArray(data) || !data.length || data.length > MAX_SOURCE_LOCATIONS) schemaError();
  const ids = new Set<number>();
  return data.map((value: unknown) => {
    const row = record(value);
    const parent = space(row);
    if (ids.has(parent.id)) schemaError();
    ids.add(parent.id);
    const subLocs = row.subLocs;
    if (subLocs !== false && (!Array.isArray(subLocs) || subLocs.length > MAX_SUB_LOCATIONS)) {
      schemaError();
    }
    const subLocations = subLocs === false ? [] : (subLocs as unknown[]).map(space);
    // IDs are unique within a parent, not globally: floor IDs overlap location IDs.
    if (new Set(subLocations.map((sub) => sub.id)).size !== subLocations.length) schemaError();
    return { ...parent, subLocations };
  });
}

function cancelled(signal: AbortSignal): CampusBusynessError {
  return new CampusBusynessError(
    signal.reason instanceof CampusBusynessError
      ? signal.reason.message
      : "Campus busyness request cancelled.",
  );
}

async function readResponse(response: IncomingMessage, signal: AbortSignal) {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    throw new CampusBusynessError(
      "The campus busyness source returned a redirect; redirects are not allowed.",
    );
  }
  if (status === 401 || status === 403 || response.headers["www-authenticate"] !== undefined) {
    throw new CampusBusynessError(
      "The campus busyness source requires sign-in or denies anonymous access.",
    );
  }
  if (status < 200 || status >= 300) {
    throw new CampusBusynessError(`The campus busyness source returned HTTP ${status}.`);
  }
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    throw new CampusBusynessError(
      "The campus busyness source returned unsupported content encoding.",
    );
  }
  const contentType = response.headers["content-type"] ?? "";
  const charset = /;\s*charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1];
  if (
    contentType.split(";", 1)[0]!.trim().toLowerCase() !== "application/json" ||
    (charset !== undefined && !/^utf-?8$/iu.test(charset))
  ) {
    throw new CampusBusynessError("The campus busyness source did not return UTF-8 JSON.");
  }
  const length = response.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) {
    throw new CampusBusynessError(
      "The campus busyness response exceeds the 512 KiB download limit.",
    );
  }
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of response) {
    if (signal.aborted) throw cancelled(signal);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytesRead += bytes.length;
    if (bytesRead > MAX_BYTES) {
      throw new CampusBusynessError(
        "The campus busyness response exceeds the 512 KiB download limit.",
      );
    }
    chunks.push(bytes);
  }
  if (signal.aborted) throw cancelled(signal);
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytesRead)),
    );
  } catch {
    throw new CampusBusynessError("The campus busyness source returned invalid JSON.");
  }
  const date = response.headers.date;
  const httpDate =
    date &&
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(date) &&
    Number.isFinite(Date.parse(date))
      ? date
      : null;
  return { payload, bytesRead, httpDate };
}

async function fetchBusyness(signal: AbortSignal) {
  // A private, non-reusing agent bypasses environment proxies. No cookie jar/auth/session.
  const agent = new Agent({ keepAlive: false, proxyEnv: {} });
  let req: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<Awaited<ReturnType<typeof readResponse>>>((resolve, reject) => {
      cancel = () => {
        req?.destroy();
        response?.destroy();
        reject(cancelled(signal));
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
      req = request(
        SOURCE_URL,
        {
          method: "GET",
          agent,
          signal,
          rejectUnauthorized: true,
          maxHeaderSize: 16 * 1024,
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "identity",
            "User-Agent": "TritonAI-UCSD-Assistant/1.0 (anonymous campus busyness)",
            Connection: "close",
          },
        },
        (incoming) => {
          response = incoming;
          void readResponse(incoming, signal).then(resolve, reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
    response?.destroy();
    req?.destroy();
    agent.destroy();
  }
}

/** One anonymous fixed-source request; filters are local and never become URL parameters. */
export async function getCampusBusyness(
  input: unknown,
  externalSignal: AbortSignal,
): Promise<CampusBusyness> {
  const filter = parseInput(input);
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new CampusBusynessError("Campus busyness request timed out after 10 seconds."),
      ),
    TIMEOUT_MS,
  );
  timer.unref();
  const signal = AbortSignal.any([externalSignal, deadline.signal]);
  try {
    if (signal.aborted) throw cancelled(signal);
    const result = await fetchBusyness(signal);
    const all = locations(result.payload);
    if (signal.aborted) throw cancelled(signal);
    const matching = all.filter((row) => row.name.toLowerCase().includes(filter.location));
    const selected = matching.slice(0, filter.limit);
    return {
      source: {
        provider: "Occuspace / Waitz",
        url: SOURCE_URL,
        officialClientUrl: OFFICIAL_CLIENT_URL,
      },
      retrievedAt: new Date().toISOString(),
      httpDate: result.httpDate,
      sourceObservedAt: null,
      bytesRead: result.bytesRead,
      units: {
        busynessPercent: "percent (0–100)",
        occupancyFraction: "fraction (0–1)",
        estimatedPeople: "estimated people",
        capacity: "people",
      },
      locations: selected,
      totalLocations: all.length,
      matchingLocations: matching.length,
      returnedLocations: selected.length,
      truncated: selected.length < matching.length,
      notes: [
        "Provider estimates cover returned locations, not every campus space or reservable seats.",
        "Source observation time is unknown. retrievedAt is retrieval completion; httpDate is the server HTTP Date, not a measurement timestamp.",
        "Unavailable estimates are null. Closed spaces can retain nonzero provider estimates; they are not open or empty.",
        "Sub-location IDs are scoped to their parent location. Provider HTML and presentation fields are omitted.",
      ],
      untrustedContent: true,
    };
  } catch (error) {
    if (signal.aborted) throw cancelled(signal);
    if (error instanceof CampusBusynessError) throw error;
    throw new CampusBusynessError("Unable to retrieve anonymous campus busyness. Try again later.");
  } finally {
    clearTimeout(timer);
  }
}
