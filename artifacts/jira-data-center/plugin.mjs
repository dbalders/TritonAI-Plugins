const PROVIDER_ID = "jira-data-center";
const CAPABILITY = "jira-data-center.read";
const SECRET_NAME = "personal-access-token";
const TENANT_ORIGIN = "https://its-pro.ucsd.edu";
const TOKEN_SETTINGS_URL = `${TENANT_ORIGIN}/secure/ViewPersonalAccessTokens.jspa`;
const API_ROOT = `${TENANT_ORIGIN}/rest/api/2`;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50_000;
const MAX_OBJECT_KEYS = 1_000;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_STRING_CHARS = 1_048_576;
const MAX_PENDING_FLOWS = 8;
const FLOW_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_PROJECT_RESULTS = 100;
const MAX_SEARCH_RESULTS = 50;
const MAX_COMMENT_RESULTS = 50;
const MAX_FIELD_RESULTS = 200;
const MAX_DESCRIPTION_CHARS = 100_000;
const MAX_COMMENT_BODY_CHARS = 100_000;
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const issueKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,49}-[1-9][0-9]{0,11}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SEARCH_FIELDS = Object.freeze([
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "project",
  "created",
  "updated",
  "resolution",
  "labels",
]);
const ISSUE_FIELDS = Object.freeze([
  ...SEARCH_FIELDS,
  "description",
  "components",
  "fixVersions",
  "versions",
  "duedate",
]);

function failure(code, message, retryable = false, details) {
  const value = { _tag: "PluginFailure", code, message, retryable };
  if (details !== undefined) value.details = details;
  return Object.freeze(value);
}

function unknownCommit(message) {
  return Object.freeze({
    _tag: "ExternalCommitOutcomeUnknown",
    code: "external_commit_outcome_unknown",
    message,
    retryable: false,
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => "value" in descriptor,
    )
  );
}

function ownKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw failure("invalid_input", `${label} must be a plain object.`);
  const keys = Object.keys(value);
  if (keys.some((key) => unsafeKeys.has(key) || !allowed.has(key))) {
    throw failure("invalid_input", `${label} contains an unsupported field.`);
  }
  return value;
}

function validateConfiguration(value) {
  const configuration = ownKeys(value, new Set(["tenantUrl"]), "Configuration");
  const tenantUrl = Object.hasOwn(configuration, "tenantUrl")
    ? configuration.tenantUrl
    : TENANT_ORIGIN;
  if (tenantUrl !== TENANT_ORIGIN) {
    throw failure(
      "invalid_configuration",
      `tenantUrl must be exactly ${TENANT_ORIGIN}.`,
    );
  }
  let parsed;
  try {
    parsed = new URL(tenantUrl);
  } catch {
    throw failure("invalid_configuration", "tenantUrl is not a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "its-pro.ucsd.edu" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== TENANT_ORIGIN
  ) {
    throw failure("invalid_configuration", "tenantUrl must be the exact UCSD Jira origin.");
  }
}

function validateOperationContext(
  context,
  { requiresCommit = false, invocation = false } = {},
) {
  if (!isPlainObject(context) || !(context.signal instanceof AbortSignal)) {
    throw failure("invalid_context", "The host operation context is invalid.");
  }
  if (requiresCommit && typeof context.beginCommit !== "function") {
    throw failure("invalid_context", "The host lifecycle context is invalid.");
  }
  if (invocation && typeof context.writeApproved !== "boolean") {
    throw failure("invalid_context", "The host invocation context is invalid.");
  }
  context.signal.throwIfAborted();
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateVisibleString(value, label, minimum, maximum) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim().length === 0 ||
    hasControlCharacters(value)
  ) {
    throw failure(
      "invalid_input",
      `${label} must be ${minimum}-${maximum} visible characters.`,
    );
  }
  return value;
}

function validateIssueKey(value) {
  if (typeof value !== "string" || !issueKeyPattern.test(value)) {
    throw failure("invalid_input", "issueKey must be a valid Jira issue key.");
  }
  return value.toUpperCase();
}

function validateInteger(value, label, minimum, maximum, fallback) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw failure("invalid_input", `${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return selected;
}

function validateInput(toolName, value) {
  switch (toolName) {
    case "jira.me.get": {
      ownKeys(value, new Set(), "Input");
      return {};
    }
    case "jira.projects.list": {
      const input = ownKeys(value, new Set(["limit"]), "Input");
      return {
        limit: validateInteger(input.limit, "limit", 1, MAX_PROJECT_RESULTS, 50),
      };
    }
    case "jira.issues.search": {
      const input = ownKeys(value, new Set(["jql", "startAt", "maxResults"]), "Input");
      return {
        jql: validateVisibleString(input.jql, "jql", 1, 2_000),
        startAt: validateInteger(input.startAt, "startAt", 0, 10_000, 0),
        maxResults: validateInteger(
          input.maxResults,
          "maxResults",
          1,
          MAX_SEARCH_RESULTS,
          25,
        ),
      };
    }
    case "jira.issues.get": {
      const input = ownKeys(value, new Set(["issueKey"]), "Input");
      return { issueKey: validateIssueKey(input.issueKey) };
    }
    case "jira.comments.list": {
      const input = ownKeys(
        value,
        new Set(["issueKey", "startAt", "maxResults"]),
        "Input",
      );
      return {
        issueKey: validateIssueKey(input.issueKey),
        startAt: validateInteger(input.startAt, "startAt", 0, 10_000, 0),
        maxResults: validateInteger(
          input.maxResults,
          "maxResults",
          1,
          MAX_COMMENT_RESULTS,
          25,
        ),
      };
    }
    case "jira.fields.list": {
      const input = ownKeys(value, new Set(["query", "limit"]), "Input");
      const output = {
        limit: validateInteger(input.limit, "limit", 1, MAX_FIELD_RESULTS, 100),
      };
      if (Object.hasOwn(input, "query")) {
        output.query = validateVisibleString(input.query, "query", 1, 128);
      }
      return output;
    }
    default:
      throw failure("tool_not_found", "The requested tool is not provided by this plugin.");
  }
}

function validateJsonTree(root) {
  const budget = { nodes: 0 };
  const stack = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    budget.nodes += 1;
    if (budget.nodes > MAX_JSON_NODES) {
      throw failure("invalid_response", "Jira returned too many JSON values.");
    }
    if (depth > MAX_JSON_DEPTH) {
      throw failure("invalid_response", "Jira returned JSON that is too deeply nested.");
    }
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw failure("invalid_response", "Jira returned a non-finite number.");
      }
      continue;
    }
    if (typeof value === "string") {
      if (value.length > MAX_STRING_CHARS) {
        throw failure("invalid_response", "Jira returned an oversized string.");
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) {
        throw failure("invalid_response", "Jira returned an oversized array.");
      }
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (!isPlainObject(value)) {
      throw failure("invalid_response", "Jira returned a non-JSON value.");
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_OBJECT_KEYS) {
      throw failure("invalid_response", "Jira returned an oversized object.");
    }
    for (const [key, item] of entries) {
      if (unsafeKeys.has(key) || key.length === 0 || key.length > 256) {
        throw failure("invalid_response", "Jira returned an unsafe object member.");
      }
      stack.push({ value: item, depth: depth + 1 });
    }
  }
  return root;
}

async function boundedBody(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw failure("response_too_large", "Jira response exceeded the byte limit.");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw failure("response_too_large", "Jira response exceeded the byte limit.");
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

function retryAfter(response) {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  if (/^\d+$/u.test(raw)) return Math.min(Number(raw), 3_600);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(Math.ceil((timestamp - Date.now()) / 1_000), 0), 3_600);
}

function timeoutSignal(parent) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(failure("request_timeout", "UCSD Jira request timed out.", true)),
    REQUEST_TIMEOUT_MS,
  );
  timeout.unref?.();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

async function jiraRequest(
  fetchImplementation,
  apiToken,
  path,
  { method = "GET", query, body, signal, authenticationProbe = false } = {},
) {
  signal.throwIfAborted();
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("..")) {
    throw failure("invalid_request", "The Jira REST path is invalid.");
  }
  const url = new URL(`${API_ROOT}${path}`);
  if (query !== undefined) {
    if (!isPlainObject(query)) throw failure("invalid_request", "The Jira query is invalid.");
    for (const [key, value] of Object.entries(query)) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key) || typeof value !== "string") {
        throw failure("invalid_request", "The Jira query is invalid.");
      }
      url.searchParams.set(key, value);
    }
  }
  const headers = { accept: "application/json", authorization: `Bearer ${apiToken}` };
  let encodedBody;
  if (body !== undefined) {
    encodedBody = JSON.stringify(body);
    if (encoder.encode(encodedBody).byteLength > MAX_REQUEST_BYTES) {
      throw failure("request_too_large", "Jira request exceeded the byte limit.");
    }
    headers["content-type"] = "application/json";
  }
  const composed = timeoutSignal(signal);
  try {
    let response;
    try {
      response = await fetchImplementation(url, {
        method,
        headers,
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
        redirect: "error",
        signal: composed.signal,
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      if (composed.signal.aborted) {
        throw failure("request_timeout", "UCSD Jira request timed out.", true);
      }
      throw failure(
        "network_error",
        "The UCSD Jira request failed before a response was received.",
        true,
      );
    }
    if (!(response instanceof Response)) {
      throw failure("invalid_response", "Jira returned an invalid HTTP response.");
    }
    if (response.url && response.url !== url.href) {
      throw failure("redirect_rejected", "Jira response origin or endpoint changed unexpectedly.");
    }
    if (response.status === 401 || (authenticationProbe && response.status === 403)) {
      throw failure("authentication_failed", "The UCSD Jira personal access token was rejected.");
    }
    if (response.status === 403) {
      throw failure("permission_denied", "The connected Jira user is not permitted to perform this read.");
    }
    if (response.status === 404) {
      throw failure(
        "not_found",
        "Jira did not find the requested resource, or the connected user cannot view it.",
      );
    }
    if (response.status === 429) {
      const seconds = retryAfter(response);
      throw failure(
        "rate_limited",
        "UCSD Jira rate limited the request; no automatic retry was attempted.",
        true,
        seconds === undefined ? {} : { retryAfterSeconds: seconds },
      );
    }
    if (!response.ok) {
      throw failure(
        "http_error",
        `UCSD Jira returned HTTP ${response.status}.`,
        response.status >= 500,
        { status: response.status },
      );
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw failure("invalid_response", "Jira returned an unexpected response content type.");
    }
    let parsed;
    try {
      parsed = JSON.parse(decoder.decode(await boundedBody(response)));
    } catch (error) {
      if (error?._tag === "PluginFailure") throw error;
      if (signal.aborted) throw signal.reason;
      if (composed.signal.aborted) {
        throw failure("request_timeout", "UCSD Jira request timed out.", true);
      }
      throw failure("invalid_response", "Jira returned malformed UTF-8 JSON.");
    }
    return validateJsonTree(parsed);
  } finally {
    composed.cleanup();
  }
}

function validateApiToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 8_192 ||
    /\s/u.test(value) ||
    hasControlCharacters(value)
  ) {
    throw failure("invalid_api_key", "The personal access token format is invalid.");
  }
  return value;
}

function parseSecret(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 12_000) return undefined;
  try {
    const parsed = JSON.parse(value);
    ownKeys(parsed, new Set(["version", "apiToken", "capabilities"]), "Stored credential");
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.capabilities) ||
      parsed.capabilities.length !== 1 ||
      parsed.capabilities[0] !== CAPABILITY
    ) {
      return undefined;
    }
    return {
      version: 1,
      apiToken: validateApiToken(parsed.apiToken),
      capabilities: [CAPABILITY],
    };
  } catch {
    return undefined;
  }
}

async function readSecret(secrets) {
  try {
    return await secrets.get(SECRET_NAME);
  } catch {
    throw failure("secret_store_error", "The package-scoped credential store could not be read.");
  }
}

async function readCredential(secrets) {
  const value = await readSecret(secrets);
  const credential = parseSecret(value);
  if (credential === undefined) {
    throw failure("credential_corrupt", "The stored Jira credential is invalid.");
  }
  return credential;
}

function exactCapabilities(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== CAPABILITY) {
    throw failure(
      "invalid_capabilities",
      "The connection must request only jira-data-center.read.",
    );
  }
  return [CAPABILITY];
}

function requiredString(value, label, maximum = 10_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw failure("invalid_response", `Jira returned an invalid ${label}.`);
  }
  return value;
}

function optionalString(value, label, maximum = 10_000) {
  if (value === null || value === undefined) return null;
  return requiredString(value, label, maximum);
}

function optionalText(value, label, maximum) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maximum) {
    throw failure("invalid_response", `Jira returned an invalid ${label}.`);
  }
  return value;
}

function projectNamed(value, label) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw failure("invalid_response", `Jira returned an invalid ${label}.`);
  return {
    id: optionalString(value.id, `${label} id`, 128),
    name: optionalString(value.name, `${label} name`, 512),
  };
}

function projectUser(value, label = "user") {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw failure("invalid_response", `Jira returned an invalid ${label}.`);
  const name = optionalString(value.name, `${label} name`, 512);
  const key = optionalString(value.key, `${label} key`, 512);
  const displayName = optionalString(value.displayName, `${label} display name`, 512);
  if (name === null && key === null && displayName === null) {
    throw failure("invalid_response", `Jira returned an invalid ${label}.`);
  }
  return {
    name,
    key,
    displayName,
    active: typeof value.active === "boolean" ? value.active : null,
  };
}

function projectCurrentUser(value) {
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned an invalid user profile.");
  return {
    ...projectUser(value, "user profile"),
    emailAddress: optionalString(value.emailAddress, "user email address", 1_024),
    timeZone: optionalString(value.timeZone, "user time zone", 128),
    locale: optionalString(value.locale, "user locale", 128),
  };
}

function projectProject(value) {
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned an invalid project.");
  return {
    id: requiredString(value.id, "project id", 128),
    key: requiredString(value.key, "project key", 128),
    name: requiredString(value.name, "project name", 512),
    projectTypeKey: optionalString(value.projectTypeKey, "project type", 128),
    archived: typeof value.archived === "boolean" ? value.archived : null,
    lead: projectUser(value.lead, "project lead"),
    category:
      value.projectCategory === undefined
        ? projectNamed(value.category, "project category")
        : projectNamed(value.projectCategory, "project category"),
  };
}

function projectStringArray(value, label, maximum = 100) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw failure("invalid_response", `Jira returned invalid ${label}.`);
  if (value.length > maximum) throw failure("invalid_response", `Jira returned too many ${label}.`);
  return value.map((item) => requiredString(item, label, 1_024));
}

function projectIssue(value, { includeDetails = false } = {}) {
  if (
    !isPlainObject(value) ||
    !isPlainObject(value.fields) ||
    typeof value.id !== "string" ||
    typeof value.key !== "string"
  ) {
    throw failure("invalid_response", "Jira returned an invalid issue.");
  }
  const fields = value.fields;
  const output = {
    id: requiredString(value.id, "issue id", 128),
    key: requiredString(value.key, "issue key", 128),
    summary: requiredString(fields.summary, "issue summary", 32_768),
    status: projectNamed(fields.status, "issue status"),
    issueType: projectNamed(fields.issuetype, "issue type"),
    priority: projectNamed(fields.priority, "issue priority"),
    assignee: projectUser(fields.assignee, "issue assignee"),
    reporter: projectUser(fields.reporter, "issue reporter"),
    project: projectNamed(fields.project, "issue project"),
    resolution: projectNamed(fields.resolution, "issue resolution"),
    created: optionalString(fields.created, "issue created date", 128),
    updated: optionalString(fields.updated, "issue updated date", 128),
    labels: projectStringArray(fields.labels, "issue labels"),
  };
  if (!includeDetails) return output;
  const description = optionalText(
    fields.description,
    "issue description",
    MAX_STRING_CHARS,
  );
  output.description = description?.slice(0, MAX_DESCRIPTION_CHARS) ?? null;
  output.descriptionTruncated =
    description !== null && description.length > MAX_DESCRIPTION_CHARS;
  output.dueDate = optionalString(fields.duedate, "issue due date", 128);
  for (const [outputKey, sourceKey] of [
    ["components", "components"],
    ["fixVersions", "fixVersions"],
    ["affectedVersions", "versions"],
  ]) {
    const values = fields[sourceKey] ?? [];
    if (!Array.isArray(values) || values.length > 100) {
      throw failure("invalid_response", `Jira returned invalid issue ${outputKey}.`);
    }
    output[outputKey] = values.map((item) => projectNamed(item, `issue ${outputKey}`));
  }
  return output;
}

function projectComment(value) {
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned an invalid comment.");
  const body = optionalText(value.body, "comment body", MAX_STRING_CHARS);
  return {
    id: requiredString(value.id, "comment id", 128),
    author: projectUser(value.author, "comment author"),
    updateAuthor: projectUser(value.updateAuthor, "comment update author"),
    body: body?.slice(0, MAX_COMMENT_BODY_CHARS) ?? null,
    bodyTruncated: body !== null && body.length > MAX_COMMENT_BODY_CHARS,
    created: optionalString(value.created, "comment created date", 128),
    updated: optionalString(value.updated, "comment updated date", 128),
    visibility:
      value.visibility === null || value.visibility === undefined
        ? null
        : projectVisibility(value.visibility),
  };
}

function projectVisibility(value) {
  if (!isPlainObject(value)) {
    throw failure("invalid_response", "Jira returned invalid comment visibility.");
  }
  return {
    type: optionalString(value.type, "comment visibility type", 128),
    value: optionalString(value.value, "comment visibility value", 512),
  };
}

function projectField(value) {
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned an invalid field.");
  let schema = null;
  if (value.schema !== null && value.schema !== undefined) {
    if (!isPlainObject(value.schema)) {
      throw failure("invalid_response", "Jira returned an invalid field schema.");
    }
    schema = {
      type: optionalString(value.schema.type, "field schema type", 128),
      items: optionalString(value.schema.items, "field schema items", 128),
      system: optionalString(value.schema.system, "field schema system", 256),
      custom: optionalString(value.schema.custom, "field schema custom type", 512),
      customId:
        Number.isSafeInteger(value.schema.customId) && value.schema.customId >= 0
          ? value.schema.customId
          : null,
    };
  }
  return {
    id: requiredString(value.id, "field id", 256),
    name: requiredString(value.name, "field name", 512),
    custom: typeof value.custom === "boolean" ? value.custom : null,
    orderable: typeof value.orderable === "boolean" ? value.orderable : null,
    navigable: typeof value.navigable === "boolean" ? value.navigable : null,
    searchable: typeof value.searchable === "boolean" ? value.searchable : null,
    schema,
  };
}

function createFlow(flows, capabilities) {
  const now = Date.now();
  for (const [id, flow] of flows) {
    if (flow.expiresAt < now) flows.delete(id);
  }
  while (flows.size >= MAX_PENDING_FLOWS) {
    flows.delete(flows.keys().next().value);
  }
  const flowId = crypto.randomUUID();
  flows.set(flowId, { expiresAt: now + FLOW_LIFETIME_MS, capabilities });
  return flowId;
}

export function createIntegrationProvider(context) {
  const factory = ownKeys(context, new Set(["secrets", "configuration"]), "Factory context");
  if (
    !isPlainObject(factory.secrets) ||
    !["get", "set", "remove"].every((name) => typeof factory.secrets[name] === "function")
  ) {
    throw failure("invalid_context", "The package-scoped secret store is invalid.");
  }
  validateConfiguration(factory.configuration);
  const fetchImplementation = globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw failure("invalid_runtime", "The Node fetch API is unavailable.");
  }
  const flows = new Map();
  let closed = false;

  function ensureOpen() {
    if (closed) throw failure("provider_closed", "The Jira provider is closed.");
  }

  async function request(apiToken, path, options) {
    return jiraRequest(fetchImplementation, apiToken, path, options);
  }

  async function verifyConnection(apiToken, signal) {
    const user = await request(apiToken, "/myself", { signal, authenticationProbe: true });
    projectCurrentUser(user);
  }

  return {
    id: PROVIDER_ID,
    async status(operationContext) {
      ensureOpen();
      validateOperationContext(operationContext);
      let credential;
      try {
        credential = await readCredential(factory.secrets);
      } catch (error) {
        if (error?.code === "credential_corrupt" || error?.code === "secret_store_error") {
          return {
            state: "error",
            accountLabel: null,
            grantedCapabilities: [],
            message: error.message,
          };
        }
        throw error;
      }
      if (credential === null) {
        return {
          state: "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message: null,
        };
      }
      try {
        const user = projectCurrentUser(
          await request(credential.apiToken, "/myself", {
            signal: operationContext.signal,
            authenticationProbe: true,
          }),
        );
        return {
          state: "connected",
          accountLabel: user.displayName ?? user.name ?? "UC San Diego Jira",
          grantedCapabilities: credential.capabilities,
          message: null,
        };
      } catch (error) {
        if (error?.code === "authentication_failed") {
          return {
            state: "not_connected",
            accountLabel: "UC San Diego Jira",
            grantedCapabilities: [],
            message: "The stored UCSD Jira personal access token was rejected.",
          };
        }
        throw error;
      }
    },
    async connect(capabilities, lifecycleContext, submission) {
      ensureOpen();
      validateOperationContext(lifecycleContext, { requiresCommit: true });
      const granted = exactCapabilities(capabilities);
      if (submission === undefined) {
        const flowId = createFlow(flows, granted);
        return {
          kind: "api_key",
          flowId,
          label: "UCSD Jira personal access token",
          placeholder: null,
          message: "Create a personal access token in UC San Diego Jira, then paste it below. Jira applies your existing permissions, and TritonAI stores the token only in this plugin's package-scoped secret store.",
          setupUrl: TOKEN_SETTINGS_URL,
          setupInstructions: [
            "Open token settings and sign in with your UC San Diego account if prompted.",
            "Select Create token, give it a recognizable name, choose an expiration, and copy the token before closing the dialog.",
            "Return here, paste the token below, and select Connect. TritonAI validates it against UCSD Jira before saving it.",
          ],
        };
      }
      const submitted = ownKeys(
        submission,
        new Set(["kind", "flowId", "value"]),
        "Connection submission",
      );
      if (submitted.kind !== "api_key" || typeof submitted.flowId !== "string") {
        throw failure("invalid_submission", "The API-key connection submission is invalid.");
      }
      const flow = flows.get(submitted.flowId);
      flows.delete(submitted.flowId);
      if (!flow || flow.expiresAt < Date.now()) {
        throw failure("flow_expired", "The connection flow expired.");
      }
      const apiToken = validateApiToken(submitted.value);
      await verifyConnection(apiToken, lifecycleContext.signal);
      lifecycleContext.signal.throwIfAborted();
      const commitSignal = await lifecycleContext.beginCommit();
      if (!(commitSignal instanceof AbortSignal)) {
        throw failure("invalid_context", "The host commit signal is invalid.");
      }
      commitSignal.throwIfAborted();
      const serialized = JSON.stringify({
        version: 1,
        apiToken,
        capabilities: flow.capabilities,
      });
      try {
        await factory.secrets.set(SECRET_NAME, serialized);
      } catch {
        let recovered;
        try {
          recovered = await factory.secrets.get(SECRET_NAME);
        } catch {
          throw unknownCommit("The credential-store commit could not be confirmed.");
        }
        if (recovered !== serialized) {
          throw failure("secret_store_error", "The personal access token could not be stored.");
        }
      }
      return {
        kind: "connected",
        flowId: submitted.flowId,
        message: "Connected to UC San Diego Jira with read-only tools.",
      };
    },
    async disconnect(lifecycleContext) {
      ensureOpen();
      validateOperationContext(lifecycleContext, { requiresCommit: true });
      const storedCredential = await readSecret(factory.secrets);
      if (storedCredential === null) return;
      lifecycleContext.signal.throwIfAborted();
      const commitSignal = await lifecycleContext.beginCommit();
      if (!(commitSignal instanceof AbortSignal)) {
        throw failure("invalid_context", "The host commit signal is invalid.");
      }
      commitSignal.throwIfAborted();
      try {
        await factory.secrets.remove(SECRET_NAME);
      } catch {
        let recovered;
        try {
          recovered = await factory.secrets.get(SECRET_NAME);
        } catch {
          throw unknownCommit("Credential removal could not be confirmed.");
        }
        if (recovered !== null) {
          throw failure("secret_store_error", "The personal access token could not be removed.");
        }
      }
    },
    async invoke(toolName, input, invocationContext) {
      ensureOpen();
      validateOperationContext(invocationContext, { invocation: true });
      const parsed = validateInput(toolName, input);
      const credential = await readCredential(factory.secrets);
      if (credential === null) {
        throw failure("not_connected", "Connect the UC San Diego Jira plugin first.");
      }
      switch (toolName) {
        case "jira.me.get": {
          const user = projectCurrentUser(
            await request(credential.apiToken, "/myself", { signal: invocationContext.signal }),
          );
          return { user };
        }
        case "jira.projects.list": {
          const value = await request(credential.apiToken, "/project", {
            signal: invocationContext.signal,
          });
          if (!Array.isArray(value)) {
            throw failure("invalid_response", "Jira returned an invalid project list.");
          }
          const available = value.map(projectProject);
          const projects = available.slice(0, parsed.limit);
          return {
            projects,
            returned: projects.length,
            totalVisible: available.length,
            truncated: available.length > projects.length,
          };
        }
        case "jira.issues.search": {
          const value = await request(credential.apiToken, "/search", {
            method: "POST",
            body: {
              jql: parsed.jql,
              startAt: parsed.startAt,
              maxResults: parsed.maxResults,
              fields: SEARCH_FIELDS,
            },
            signal: invocationContext.signal,
          });
          if (
            !isPlainObject(value) ||
            !Array.isArray(value.issues) ||
            !Number.isSafeInteger(value.startAt) ||
            !Number.isSafeInteger(value.maxResults) ||
            !Number.isSafeInteger(value.total)
          ) {
            throw failure("invalid_response", "Jira returned an invalid issue search page.");
          }
          if (value.issues.length > parsed.maxResults) {
            throw failure("invalid_response", "Jira returned too many issue search results.");
          }
          const issues = value.issues.map((issue) => projectIssue(issue));
          return {
            issues,
            startAt: value.startAt,
            maxResults: value.maxResults,
            total: value.total,
            returned: issues.length,
            hasMore: value.startAt + issues.length < value.total,
          };
        }
        case "jira.issues.get": {
          const value = await request(
            credential.apiToken,
            `/issue/${encodeURIComponent(parsed.issueKey)}`,
            {
              query: { fields: ISSUE_FIELDS.join(",") },
              signal: invocationContext.signal,
            },
          );
          return { issue: projectIssue(value, { includeDetails: true }) };
        }
        case "jira.comments.list": {
          const value = await request(
            credential.apiToken,
            `/issue/${encodeURIComponent(parsed.issueKey)}/comment`,
            {
              query: {
                startAt: String(parsed.startAt),
                maxResults: String(parsed.maxResults),
              },
              signal: invocationContext.signal,
            },
          );
          if (
            !isPlainObject(value) ||
            !Array.isArray(value.comments) ||
            !Number.isSafeInteger(value.startAt) ||
            !Number.isSafeInteger(value.maxResults) ||
            !Number.isSafeInteger(value.total)
          ) {
            throw failure("invalid_response", "Jira returned an invalid comment page.");
          }
          if (value.comments.length > parsed.maxResults) {
            throw failure("invalid_response", "Jira returned too many comments.");
          }
          const comments = value.comments.map(projectComment);
          return {
            issueKey: parsed.issueKey,
            comments,
            startAt: value.startAt,
            maxResults: value.maxResults,
            total: value.total,
            returned: comments.length,
            hasMore: value.startAt + comments.length < value.total,
          };
        }
        case "jira.fields.list": {
          const value = await request(credential.apiToken, "/field", {
            signal: invocationContext.signal,
          });
          if (!Array.isArray(value)) {
            throw failure("invalid_response", "Jira returned an invalid field list.");
          }
          const fields = value.map(projectField);
          const filtered =
            parsed.query === undefined
              ? fields
              : fields.filter((field) => {
                  const query = parsed.query.toLocaleLowerCase("en-US");
                  return (
                    field.id.toLocaleLowerCase("en-US").includes(query) ||
                    field.name.toLocaleLowerCase("en-US").includes(query)
                  );
                });
          const selected = filtered.slice(0, parsed.limit);
          return {
            fields: selected,
            returned: selected.length,
            totalMatched: filtered.length,
            truncated: filtered.length > selected.length,
          };
        }
        default:
          throw failure("tool_not_found", "The requested tool is not provided by this plugin.");
      }
    },
    async close() {
      if (closed) return;
      flows.clear();
      closed = true;
    },
  };
}
