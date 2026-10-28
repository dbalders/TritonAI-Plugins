const PROVIDER_ID = "kuali-build";
const READ_CAPABILITY = "kuali-build.read";
const WRITE_CAPABILITY = "kuali-build.write";
const ADMIN_CAPABILITY = "kuali-build.admin";
const LEGACY_DOCUMENT_WRITE_CAPABILITY = "kuali-build.documents.write";
const LEGACY_WORKFLOW_WRITE_CAPABILITY = "kuali-build.workflows.write";
const CAPABILITIES = Object.freeze([READ_CAPABILITY, WRITE_CAPABILITY, ADMIN_CAPABILITY]);
const CAPABILITY_SET = new Set(CAPABILITIES);
const LEGACY_CAPABILITY_SET = new Set([
  READ_CAPABILITY,
  LEGACY_DOCUMENT_WRITE_CAPABILITY,
  LEGACY_WORKFLOW_WRITE_CAPABILITY,
]);
const SECRET_NAME = "api-key";
const TENANT_ORIGIN = "https://ucsd.kualibuild.com";
const API_KEY_SETTINGS_URL = `${TENANT_ORIGIN}/build/space/favorites/account/api-keys`;
const GRAPHQL_URL = `${TENANT_ORIGIN}/app/api/v0/graphql`;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50_000;
const MAX_OBJECT_KEYS = 1_000;
const MAX_ARRAY_ITEMS = 5_000;
const MAX_STRING_CHARS = 1_048_576;
const MAX_PENDING_FLOWS = 8;
const MAX_APP_RESULTS = 100;
const MAX_SCHEMA_FIELDS = 500;
const MAX_USER_RESULTS = 50;
const MAX_WRITE_FIELDS = 100;
const MAX_WRITE_DEPTH = 16;
const MAX_WRITE_NODES = 5_000;
const MAX_WRITE_ARRAY_ITEMS = 500;
const MAX_WRITE_OBJECT_KEYS = 200;
const MAX_WRITE_STRING_CHARS = 32_768;
const FLOW_LIFETIME_MS = 10 * 60 * 1_000;
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const objectIdPattern = /^[0-9a-f]{24}$/iu;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const queries = Object.freeze({
  appsList: `query KualiBuildApps { apps { id name } }`,
  appGet: `query KualiBuildApp($id: ID) { app(id: $id) { id name } }`,
  formSchema: `query KualiBuildFormSchema($id: ID) { app(id: $id) { id name formVersion { schema { formKey label } } } }`,
  documentsList: `query KualiBuildDocuments($appId: ID!, $skip: Int!, $limit: Int!, $sort: [String!], $query: String, $fields: Operator) { app(id: $appId) { id name documentConnection(args: { skip: $skip limit: $limit sort: $sort query: $query fields: $fields } keyBy: ID) { totalCount edges { node { id } } pageInfo { hasNextPage hasPreviousPage skip limit } } } }`,
  documentGet: `query KualiBuildDocument($id: ID!) { document(id: $id) { id data meta } }`,
  documentVersion: `query KualiBuildDocumentVersion($id: ID!) { document(id: $id) { id meta } }`,
  usersLookup: `query KualiBuildUsers($query: String, $limit: Int!) { usersConnection(args: { query: $query, limit: $limit }) { edges { node { id displayName email username firstName lastName schoolId } } } }`,
  workflowStatus: `query KualiBuildWorkflowStatus($id: ID!) { document(id: $id) { id meta } }`,
  actionGet: `query KualiBuildDraftAction($actionId: String!) { action(actionId: $actionId) { id appId document { id } } }`,
  documentUpdate: `mutation KualiBuildDocumentUpdate($id: ID!, $data: JSON!) { updateDocument(args: { id: $id, data: $data }) { id } }`,
  draftInitialize: `mutation KualiBuildDraftInitialize($appId: ID!) { initializeWorkflow(args: { id: $appId }) { actionId } }`,
  documentSubmit: `mutation KualiBuildDocumentSubmit($documentId: ID!, $data: JSON, $actionId: ID!, $status: String) { submitDocument(id: $documentId, data: $data, actionId: $actionId, status: $status) }`,
});

function failure(code, message, retryable = false, details) {
  const value = { _tag: "PluginFailure", code, message, retryable };
  if (details !== undefined) value.details = details;
  return Object.freeze(value);
}

function externalCommitOutcomeUnknown(operation, details = {}) {
  return Object.freeze({
    _tag: "ExternalCommitOutcomeUnknown",
    code: "external_commit_outcome_unknown",
    message: `The ${operation} request may have committed in UCSD Kuali Build. Inspect the document or workflow before deciding whether to try another action.`,
    retryable: false,
    details: { operation, ...details },
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
    parsed.hostname !== "ucsd.kualibuild.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== TENANT_ORIGIN
  ) {
    throw failure("invalid_configuration", "tenantUrl must be the exact UCSD Kuali origin.");
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

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !objectIdPattern.test(value)) {
    throw failure("invalid_input", `${label} must be a 24-character hexadecimal ID.`);
  }
  return value.toLowerCase();
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasForbiddenWriteControl(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if ((code <= 0x1f && ![0x09, 0x0a, 0x0d].includes(code)) || code === 0x7f) return true;
  }
  return false;
}

function validateSearch(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim().length === 0 ||
    hasControlCharacters(value)
  ) {
    throw failure("invalid_input", "query must be 1-256 visible characters.");
  }
  return value;
}

function validateUpdatedAt(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw failure(
      "invalid_input",
      "expectedUpdatedAt must exactly match the document meta.updatedAt value from a recent read.",
    );
  }
  return value;
}

function validateWriteData(value, confirmNullValues) {
  if (!isPlainObject(value)) {
    throw failure("invalid_input", "data must be a plain object of Kuali form fields.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_WRITE_FIELDS) {
    throw failure("invalid_input", `data may contain at most ${MAX_WRITE_FIELDS} form fields.`);
  }
  const normalized = {};
  let sawNull = false;
  let nodes = 0;
  const stack = [];
  for (const [sourceKey, item] of entries) {
    if (
      unsafeKeys.has(sourceKey) ||
      !/^(?:data\.)?[A-Za-z0-9_-]{1,128}$/u.test(sourceKey)
    ) {
      throw failure(
        "invalid_input",
        "Every data key must be a bounded Kuali formKey, optionally prefixed with data..",
      );
    }
    const key = sourceKey.startsWith("data.") ? sourceKey.slice(5) : sourceKey;
    if (Object.hasOwn(normalized, key)) {
      throw failure("invalid_input", `data contains the duplicate normalized formKey ${key}.`);
    }
    normalized[key] = item;
    stack.push({ value: item, depth: 1 });
  }
  while (stack.length > 0) {
    const { value: item, depth } = stack.pop();
    nodes += 1;
    if (nodes > MAX_WRITE_NODES) {
      throw failure("invalid_input", "data contains too many JSON values.");
    }
    if (depth > MAX_WRITE_DEPTH) {
      throw failure("invalid_input", "data is too deeply nested.");
    }
    if (item === null) {
      sawNull = true;
      continue;
    }
    if (typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw failure("invalid_input", "data contains a non-finite number.");
      continue;
    }
    if (typeof item === "string") {
      if (item.length > MAX_WRITE_STRING_CHARS || hasForbiddenWriteControl(item)) {
        throw failure(
          "invalid_input",
          `data strings must contain at most ${MAX_WRITE_STRING_CHARS} characters and no control characters.`,
        );
      }
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length > MAX_WRITE_ARRAY_ITEMS) {
        throw failure("invalid_input", "data contains an oversized array.");
      }
      for (const child of item) stack.push({ value: child, depth: depth + 1 });
      continue;
    }
    if (!isPlainObject(item)) {
      throw failure("invalid_input", "data must contain only plain JSON values.");
    }
    const children = Object.entries(item);
    if (children.length > MAX_WRITE_OBJECT_KEYS) {
      throw failure("invalid_input", "data contains an oversized nested object.");
    }
    for (const [key, child] of children) {
      if (unsafeKeys.has(key) || key.length === 0 || key.length > 128 || hasControlCharacters(key)) {
        throw failure("invalid_input", "data contains an unsafe nested object key.");
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  if (sawNull && confirmNullValues !== true) {
    throw failure(
      "null_confirmation_required",
      "data contains null. Set confirmNullValues to true only if clearing those Kuali values is intended.",
    );
  }
  return normalized;
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
    case "kuali-build.apps.list": {
      const input = ownKeys(value, new Set(["limit"]), "Input");
      return { limit: validateInteger(input.limit, "limit", 1, MAX_APP_RESULTS, MAX_APP_RESULTS) };
    }
    case "kuali-build.apps.get":
    case "kuali-build.forms.schema": {
      const input = ownKeys(value, new Set(["appId"]), "Input");
      return { appId: validateIdentifier(input.appId, "appId") };
    }
    case "kuali-build.documents.get":
    case "kuali-build.workflows.status": {
      const input = ownKeys(value, new Set(["documentId"]), "Input");
      return { documentId: validateIdentifier(input.documentId, "documentId") };
    }
    case "kuali-build.documents.drafts.resolve": {
      const input = ownKeys(value, new Set(["actionId"]), "Input");
      return { actionId: validateIdentifier(input.actionId, "actionId") };
    }
    case "kuali-build.documents.update": {
      const input = ownKeys(
        value,
        new Set([
          "documentId",
          "data",
          "expectedUpdatedAt",
          "confirmUpdate",
          "confirmNullValues",
        ]),
        "Input",
      );
      if (input.confirmUpdate !== true) {
        throw failure(
          "confirmation_required",
          "confirmUpdate must be true to overwrite the supplied document fields.",
        );
      }
      const data = validateWriteData(input.data, input.confirmNullValues);
      if (Object.keys(data).length === 0) {
        throw failure("invalid_input", "data must contain at least one form field to update.");
      }
      return {
        documentId: validateIdentifier(input.documentId, "documentId"),
        data,
        expectedUpdatedAt: validateUpdatedAt(input.expectedUpdatedAt),
      };
    }
    case "kuali-build.documents.drafts.initialize": {
      const input = ownKeys(value, new Set(["appId", "confirmCreateDraft"]), "Input");
      if (input.confirmCreateDraft !== true) {
        throw failure(
          "confirmation_required",
          "confirmCreateDraft must be true because this creates an empty Kuali draft immediately.",
        );
      }
      return { appId: validateIdentifier(input.appId, "appId") };
    }
    case "kuali-build.documents.submit": {
      const input = ownKeys(
        value,
        new Set([
          "documentId",
          "actionId",
          "data",
          "confirmSubmit",
          "confirmNullValues",
        ]),
        "Input",
      );
      if (input.confirmSubmit !== true) {
        throw failure(
          "confirmation_required",
          "confirmSubmit must be true because submission starts the configured workflow.",
        );
      }
      return {
        documentId: validateIdentifier(input.documentId, "documentId"),
        actionId: validateIdentifier(input.actionId, "actionId"),
        data: validateWriteData(input.data, input.confirmNullValues),
      };
    }
    case "kuali-build.users.lookup": {
      const input = ownKeys(value, new Set(["query"]), "Input");
      return { query: validateSearch(input.query) };
    }
    case "kuali-build.documents.list": {
      const input = ownKeys(
        value,
        new Set(["appId", "skip", "limit", "query", "workflowStatus", "updatedAfter"]),
        "Input",
      );
      const output = {
        appId: validateIdentifier(input.appId, "appId"),
        skip: validateInteger(input.skip, "skip", 0, 10_000, 0),
        limit: validateInteger(input.limit, "limit", 1, 50, 25),
      };
      if (Object.hasOwn(input, "query")) output.query = validateSearch(input.query);
      if (Object.hasOwn(input, "workflowStatus")) {
        if (!["Draft", "In Progress", "Complete", "Denied", "Withdrawn"].includes(input.workflowStatus)) {
          throw failure("invalid_input", "workflowStatus is not supported.");
        }
        output.workflowStatus = input.workflowStatus;
      }
      if (Object.hasOwn(input, "updatedAfter")) {
        output.updatedAfter = validateInteger(
          input.updatedAfter,
          "updatedAfter",
          0,
          8_640_000_000_000_000,
        );
      }
      return output;
    }
    case "kuali-build.graphql.schema":
    case "kuali-build.graphql.query":
    case "kuali-build.graphql.mutate":
    case "kuali-build.graphql.admin":
      return validateGenericInput(toolName, value);
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
    if (budget.nodes > MAX_JSON_NODES) throw failure("invalid_response", "Kuali returned too many JSON values.");
    if (depth > MAX_JSON_DEPTH) throw failure("invalid_response", "Kuali returned JSON that is too deeply nested.");
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw failure("invalid_response", "Kuali returned a non-finite number.");
      continue;
    }
    if (typeof value === "string") {
      if (value.length > MAX_STRING_CHARS) throw failure("invalid_response", "Kuali returned an oversized string.");
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) throw failure("invalid_response", "Kuali returned an oversized array.");
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (!isPlainObject(value)) throw failure("invalid_response", "Kuali returned a non-JSON value.");
    const entries = Object.entries(value);
    if (entries.length > MAX_OBJECT_KEYS) throw failure("invalid_response", "Kuali returned an oversized object.");
    for (const [key, item] of entries) {
      if (unsafeKeys.has(key) || key.length === 0 || key.length > 256) {
        throw failure("invalid_response", "Kuali returned an unsafe object member.");
      }
      stack.push({ value: item, depth: depth + 1 });
    }
  }
  return root;
}

async function boundedBody(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw failure("response_too_large", "Kuali response exceeded the byte limit.");
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
        throw failure("response_too_large", "Kuali response exceeded the byte limit.");
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

function graphqlFailure(errors, partialDataDiscarded) {
  const codes = [];
  const paths = [];
  if (Array.isArray(errors)) {
    for (const item of errors.slice(0, 10)) {
      if (!isPlainObject(item)) continue;
      const code = isPlainObject(item.extensions) ? item.extensions.code : undefined;
      if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)) codes.push(code);
      if (
        Array.isArray(item.path) &&
        item.path.length <= 16 &&
        item.path.every((part) =>
          (typeof part === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(part)) ||
          (Number.isSafeInteger(part) && part >= 0),
        )
      ) {
        paths.push(item.path.join("."));
      }
    }
  }
  if (
    codes.some((code) =>
      ["AUTHENTICATION_ERROR", "FORBIDDEN", "UNAUTHENTICATED", "UNAUTHORIZED"].includes(code),
    )
  ) {
    return failure("authentication_failed", "The UCSD Kuali Build API key was rejected.");
  }
  return failure("graphql_error", "Kuali Build rejected the GraphQL operation.", false, {
    codes: [...new Set(codes)],
    paths: [...new Set(paths)],
    partialDataDiscarded,
  });
}

function timeoutSignal(parent) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(failure("request_timeout", "Kuali Build request timed out.", true)), REQUEST_TIMEOUT_MS);
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

async function graphql(fetchImplementation, apiKey, query, variables, signal) {
  signal.throwIfAborted();
  const body = JSON.stringify({ query, variables });
  if (encoder.encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw failure("request_too_large", "Kuali request exceeded the byte limit.");
  }
  const composed = timeoutSignal(signal);
  try {
    let response;
    try {
      response = await fetchImplementation(GRAPHQL_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body,
      redirect: "error",
      signal: composed.signal,
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      if (composed.signal.aborted) throw failure("request_timeout", "Kuali Build request timed out.", true);
      throw failure("network_error", "The UCSD Kuali Build request failed before a response was received.", true);
    }
  if (!(response instanceof Response)) throw failure("invalid_response", "Kuali returned an invalid HTTP response.");
  if (response.url && response.url !== GRAPHQL_URL) {
    throw failure("redirect_rejected", "Kuali response origin or endpoint changed unexpectedly.");
  }
  if (response.status === 401 || response.status === 403) {
    throw failure("authentication_failed", "The UCSD Kuali Build API key was rejected.");
  }
  if (response.status === 429) {
    const seconds = retryAfter(response);
    throw failure(
      "rate_limited",
      "UCSD Kuali Build rate limited the request; no automatic retry was attempted.",
      true,
      seconds === undefined ? {} : { retryAfterSeconds: seconds },
    );
  }
  if (!response.ok) {
    throw failure(
      "http_error",
      `UCSD Kuali Build returned HTTP ${response.status}.`,
      response.status >= 500,
      { status: response.status },
    );
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/graphql-response+json") {
    throw failure("invalid_response", "Kuali returned an unexpected response content type.");
  }
  let parsed;
    try {
      parsed = JSON.parse(decoder.decode(await boundedBody(response)));
    } catch (error) {
      if (error?._tag === "PluginFailure") throw error;
      if (signal.aborted) throw signal.reason;
      if (composed.signal.aborted) throw failure("request_timeout", "Kuali Build request timed out.", true);
      throw failure("invalid_response", "Kuali returned malformed UTF-8 JSON.");
    }
  validateJsonTree(parsed);
  if (!isPlainObject(parsed)) throw failure("invalid_response", "Kuali returned an invalid GraphQL envelope.");
  if (Object.hasOwn(parsed, "errors") && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw graphqlFailure(
      parsed.errors,
      isPlainObject(parsed.data) && Object.values(parsed.data).some((value) => value !== null),
    );
  }
  if (!Object.hasOwn(parsed, "data") || !isPlainObject(parsed.data)) {
    throw failure("invalid_response", "Kuali returned a GraphQL response without data.");
  }
    return parsed.data;
  } finally {
    composed.cleanup();
  }
}

function validateRequestSize(query, variables) {
  const body = JSON.stringify({ query, variables });
  if (encoder.encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw failure("request_too_large", "Kuali request exceeded the byte limit.");
  }
}

function validateApiKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 8_192 ||
    /\s/u.test(value) ||
    hasControlCharacters(value)
  ) {
    throw failure("invalid_api_key", "The API key format is invalid.");
  }
  return value;
}

function parseSecret(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 12_000) return undefined;
  try {
    const parsed = JSON.parse(value);
    ownKeys(parsed, new Set(["version", "apiKey", "capabilities"]), "Stored credential");
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.capabilities) ||
      parsed.capabilities.length < 1 ||
      parsed.capabilities.length > LEGACY_CAPABILITY_SET.size ||
      parsed.capabilities[0] !== READ_CAPABILITY ||
      new Set(parsed.capabilities).size !== parsed.capabilities.length
    ) return undefined;
    const isCurrent = parsed.capabilities.every((capability) => CAPABILITY_SET.has(capability));
    const isLegacy = parsed.capabilities.every((capability) => LEGACY_CAPABILITY_SET.has(capability));
    if (!isCurrent && !isLegacy) return undefined;
    const hadBothLegacyWriteCapabilities =
      parsed.capabilities.includes(LEGACY_DOCUMENT_WRITE_CAPABILITY) &&
      parsed.capabilities.includes(LEGACY_WORKFLOW_WRITE_CAPABILITY);
    const capabilities = isCurrent
      ? CAPABILITIES.filter((capability) => parsed.capabilities.includes(capability))
      : hadBothLegacyWriteCapabilities
        ? [READ_CAPABILITY, WRITE_CAPABILITY]
        : [READ_CAPABILITY];
    return {
      version: 1,
      apiKey: validateApiKey(parsed.apiKey),
      capabilities,
      needsMigration: !isCurrent,
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
  if (credential === undefined) throw failure("credential_corrupt", "The stored Kuali credential is invalid.");
  return credential;
}

function exactCapabilities(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CAPABILITIES.length ||
    value[0] !== READ_CAPABILITY ||
    new Set(value).size !== value.length ||
    value.some((capability) => !CAPABILITY_SET.has(capability))
  ) {
    throw failure(
      "invalid_capabilities",
      "The connection must request kuali-build.read first and may additionally request kuali-build.write and kuali-build.admin.",
    );
  }
  return CAPABILITIES.filter((capability) => value.includes(capability));
}

function extract(data, key) {
  if (!Object.hasOwn(data, key)) throw failure("invalid_response", `Kuali response omitted ${key}.`);
  return data[key];
}

function projectApp(value) {
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    throw failure("invalid_response", "Kuali returned an invalid app.");
  }
  return { id: value.id, name: value.name };
}

function projectApps(value) {
  if (!Array.isArray(value)) throw failure("invalid_response", "Kuali returned an invalid app list.");
  return value.map(projectApp);
}

function projectDocument(value) {
  if (!isPlainObject(value) || typeof value.id !== "string") {
    throw failure("invalid_response", "Kuali returned an invalid document.");
  }
  return { id: value.id, data: value.data ?? null, meta: value.meta ?? null };
}

function projectDocumentSummary(value) {
  if (!isPlainObject(value) || typeof value.id !== "string" || !objectIdPattern.test(value.id)) {
    throw failure("invalid_response", "Kuali returned an invalid document summary.");
  }
  return { id: value.id.toLowerCase() };
}

function projectPageInfo(value) {
  if (
    !isPlainObject(value) ||
    typeof value.hasNextPage !== "boolean" ||
    typeof value.hasPreviousPage !== "boolean" ||
    !Number.isSafeInteger(value.skip) ||
    !Number.isSafeInteger(value.limit)
  ) {
    throw failure("invalid_response", "Kuali returned invalid document pagination.");
  }
  return {
    hasNextPage: value.hasNextPage,
    hasPreviousPage: value.hasPreviousPage,
    skip: value.skip,
    limit: value.limit,
  };
}

function projectUser(value) {
  if (!isPlainObject(value) || typeof value.id !== "string") {
    throw failure("invalid_response", "Kuali returned an invalid user.");
  }
  const output = { id: value.id };
  for (const key of [
    "displayName",
    "email",
    "username",
    "firstName",
    "lastName",
    "schoolId",
  ]) {
    output[key] = typeof value[key] === "string" ? value[key] : null;
  }
  return output;
}

function projectDraftAction(value) {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    !objectIdPattern.test(value.id) ||
    typeof value.appId !== "string" ||
    !objectIdPattern.test(value.appId) ||
    !isPlainObject(value.document) ||
    typeof value.document.id !== "string" ||
    !objectIdPattern.test(value.document.id)
  ) {
    throw failure("invalid_response", "Kuali returned an invalid draft action.");
  }
  return {
    actionId: value.id.toLowerCase(),
    appId: value.appId.toLowerCase(),
    documentId: value.document.id.toLowerCase(),
  };
}

function requireCapability(credential, capability) {
  if (!credential.capabilities.includes(capability)) {
    throw failure(
      "capability_not_granted",
      `Reconnect the plugin with ${capability} enabled before using this tool.`,
    );
  }
}

function validateWriteInvocation(context) {
  if (context.writeApproved !== true) {
    throw failure(
      "write_not_approved",
      "The host must approve this Kuali Build write before it can run.",
    );
  }
  if (typeof context.beginCommit !== "function") {
    throw failure("invalid_context", "The host write context is missing beginCommit.");
  }
}

function isAmbiguousWriteFailure(error, commitSignal) {
  if (commitSignal.aborted) return true;
  if (error?._tag === "ExternalCommitOutcomeUnknown") return true;
  if (error?._tag !== "PluginFailure") return true;
  if (
    [
      "network_error",
      "request_timeout",
      "response_too_large",
      "invalid_response",
      "redirect_rejected",
    ].includes(error.code)
  ) {
    return true;
  }
  if (error.code === "http_error" && Number(error.details?.status) >= 500) return true;
  return error.code === "graphql_error" && error.details?.partialDataDiscarded === true;
}

function connectionMessage(capabilities) {
  if (capabilities.includes(ADMIN_CAPABILITY)) {
    return capabilities.includes(WRITE_CAPABILITY)
      ? "Connected to UC San Diego Kuali Build with write and admin tools enabled."
      : "Connected to UC San Diego Kuali Build with admin tools enabled.";
  }
  return capabilities.includes(WRITE_CAPABILITY)
    ? "Connected to UC San Diego Kuali Build with write tools enabled."
    : "Connected to UC San Diego Kuali Build with read-only tools.";
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

// ---------------------------------------------------------------------------
// General GraphQL access.
//
// The generic tools let the assistant send any single GraphQL operation the connected user's key
// is allowed to run. Every request is parsed here first so it can be sorted into a permission
// tier before anything reaches Kuali:
//   - queries need kuali-build.read;
//   - a mutation whose one root field is on the reviewed allowlist needs kuali-build.write;
//   - every other mutation, including fields Kuali adds later, needs kuali-build.admin.
// Mutations are never retried. Kuali's server still enforces the user's own Kuali permissions.

const GRAPHQL_MAX_DOCUMENT_CHARS = 32_768;
const GRAPHQL_MAX_TOKENS = 8_000;
const GRAPHQL_MAX_DEPTH = 24;
const GRAPHQL_MAX_SELECTIONS = 1_000;
const GRAPHQL_MAX_ERROR_MESSAGES = 5;
const GRAPHQL_MAX_ERROR_MESSAGE_CHARS = 500;
const SCHEMA_MAX_TYPE_NAMES = 2_000;
const SCHEMA_MAX_FIELDS = 1_000;
const SCHEMA_DESCRIPTION_CHARS = 300;
const SCHEMA_CACHE_MS = 60 * 60 * 1_000;
const graphqlNamePattern = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/u;

// Routine document work. Keep this list short and reviewed; anything absent needs Admin.
const WRITE_MUTATION_FIELDS = Object.freeze(new Set([
  "updateDocument",
  "initializeWorkflow",
  "submitDocument",
]));

// Backstop: names that suggest deletion, access control, credentials, or configuration are always
// Admin, even if someone later adds them to the Write allowlist by mistake.
const ADMIN_NAME_PATTERN =
  /delete|remove|archive|purge|destroy|revoke|permission|role|group|policy|apikey|token|secret|password|credential|integration|webhook|setting|config|publish|transfer|bypass|skip|reassign|import|user|space|tenant|admin/iu;

const REDACTED_RESPONSE_KEYS = /^(?:api[_-]?key|apikeys?|secret|client[_-]?secret|password|token|access[_-]?token|refresh[_-]?token|private[_-]?key)$/iu;

function classifyMutationField(name) {
  if (WRITE_MUTATION_FIELDS.has(name) && !ADMIN_NAME_PATTERN.test(name)) return "write";
  return "admin";
}

const GRAPHQL_PUNCTUATORS = new Set(["!", "$", "&", "(", ")", ":", "=", "@", "[", "]", "{", "|", "}"]);

function graphqlSyntaxError(message) {
  return failure("graphql_syntax_error", `The GraphQL document could not be read: ${message}`);
}

function tokenizeGraphql(source) {
  const tokens = [];
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const length = source.length;
  const push = (kind, value) => {
    tokens.push({ kind, value });
    if (tokens.length > GRAPHQL_MAX_TOKENS) {
      throw failure("graphql_too_complex", "The GraphQL document has too many tokens.");
    }
  };
  while (index < length) {
    const character = source[index];
    if (character === " " || character === "\t" || character === "\n" || character === "\r" || character === ",") {
      index += 1;
      continue;
    }
    if (character === "#") {
      while (index < length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      continue;
    }
    if (character === ".") {
      if (source.startsWith("...", index)) {
        push("punct", "...");
        index += 3;
        continue;
      }
      throw graphqlSyntaxError("unexpected '.'.");
    }
    if (GRAPHQL_PUNCTUATORS.has(character)) {
      push("punct", character);
      index += 1;
      continue;
    }
    if (/[_A-Za-z]/u.test(character)) {
      const start = index;
      while (index < length && /[_0-9A-Za-z]/u.test(source[index])) index += 1;
      push("name", source.slice(start, index));
      continue;
    }
    if (character === "-" || /[0-9]/u.test(character)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(index, index + 64));
      if (!match) throw graphqlSyntaxError("invalid number.");
      push("number", match[0]);
      index += match[0].length;
      if (index < length && /[_A-Za-z.]/u.test(source[index])) throw graphqlSyntaxError("invalid number.");
      continue;
    }
    if (character === '"') {
      if (source.startsWith('"""', index)) {
        let cursor = index + 3;
        let close = -1;
        while (cursor < length) {
          if (source.startsWith('\\"""', cursor)) {
            cursor += 4;
            continue;
          }
          if (source.startsWith('"""', cursor)) {
            close = cursor;
            break;
          }
          cursor += 1;
        }
        if (close === -1) throw graphqlSyntaxError("unterminated block string.");
        push("string", source.slice(index + 3, close));
        index = close + 3;
        continue;
      }
      let cursor = index + 1;
      let value = "";
      let closed = false;
      while (cursor < length) {
        const next = source[cursor];
        if (next === "\n" || next === "\r") break;
        if (next === '"') {
          closed = true;
          break;
        }
        if (next === "\\") {
          const escaped = source[cursor + 1];
          if (escaped === "u") {
            const hex = source.slice(cursor + 2, cursor + 6);
            if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) throw graphqlSyntaxError("invalid unicode escape.");
            value += String.fromCharCode(Number.parseInt(hex, 16));
            cursor += 6;
            continue;
          }
          const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[escaped];
          if (simple === undefined) throw graphqlSyntaxError("invalid string escape.");
          value += simple;
          cursor += 2;
          continue;
        }
        value += next;
        cursor += 1;
      }
      if (!closed) throw graphqlSyntaxError("unterminated string.");
      push("string", value);
      index = cursor + 1;
      continue;
    }
    throw graphqlSyntaxError(`unexpected character U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}.`);
  }
  push("eof", "");
  return tokens;
}

function parseGraphqlDocument(source) {
  const tokens = tokenizeGraphql(source);
  let position = 0;
  let selections = 0;
  const peek = () => tokens[position];
  const advance = () => tokens[position++];
  const isPunct = (value) => peek().kind === "punct" && peek().value === value;
  const isName = (value) => peek().kind === "name" && (value === undefined || peek().value === value);
  const expectPunct = (value) => {
    if (!isPunct(value)) throw graphqlSyntaxError(`expected '${value}'.`);
    advance();
  };
  const expectName = () => {
    if (!isName()) throw graphqlSyntaxError("expected a name.");
    return advance().value;
  };
  const checkDepth = (depth) => {
    if (depth > GRAPHQL_MAX_DEPTH) {
      throw failure("graphql_too_complex", "The GraphQL document is nested too deeply.");
    }
  };

  function parseValue(depth, constant) {
    checkDepth(depth);
    const token = peek();
    if (token.kind === "punct" && token.value === "$") {
      if (constant) throw graphqlSyntaxError("variables are not allowed here.");
      advance();
      return { kind: "variable", name: expectName() };
    }
    if (token.kind === "punct" && token.value === "[") {
      advance();
      const values = [];
      while (!isPunct("]")) {
        if (peek().kind === "eof") throw graphqlSyntaxError("unterminated list.");
        values.push(parseValue(depth + 1, constant));
      }
      advance();
      return { kind: "list", values };
    }
    if (token.kind === "punct" && token.value === "{") {
      advance();
      const fields = [];
      while (!isPunct("}")) {
        if (peek().kind === "eof") throw graphqlSyntaxError("unterminated object.");
        const name = expectName();
        expectPunct(":");
        fields.push({ name, value: parseValue(depth + 1, constant) });
      }
      advance();
      return { kind: "object", fields };
    }
    if (token.kind === "number" || token.kind === "string" || token.kind === "name") {
      advance();
      return { kind: token.kind, value: token.value };
    }
    throw graphqlSyntaxError("expected a value.");
  }

  function parseArguments(depth) {
    const args = [];
    if (!isPunct("(")) return args;
    advance();
    while (!isPunct(")")) {
      if (peek().kind === "eof") throw graphqlSyntaxError("unterminated arguments.");
      const name = expectName();
      expectPunct(":");
      args.push({ name, value: parseValue(depth + 1, false) });
    }
    advance();
    if (args.length === 0) throw graphqlSyntaxError("empty argument list.");
    return args;
  }

  function parseDirectives(depth) {
    const directives = [];
    while (isPunct("@")) {
      advance();
      const name = expectName();
      directives.push({ name, arguments: parseArguments(depth) });
    }
    return directives;
  }

  function parseType(depth) {
    checkDepth(depth);
    if (isPunct("[")) {
      advance();
      parseType(depth + 1);
      expectPunct("]");
    } else {
      expectName();
    }
    if (isPunct("!")) advance();
  }

  function parseSelectionSet(depth) {
    checkDepth(depth);
    expectPunct("{");
    const items = [];
    while (!isPunct("}")) {
      if (peek().kind === "eof") throw graphqlSyntaxError("unterminated selection set.");
      selections += 1;
      if (selections > GRAPHQL_MAX_SELECTIONS) {
        throw failure("graphql_too_complex", "The GraphQL document selects too many fields.");
      }
      if (isPunct("...")) {
        advance();
        if (isName() && peek().value !== "on") {
          const name = advance().value;
          items.push({ kind: "spread", name, directives: parseDirectives(depth) });
          continue;
        }
        let typeCondition = null;
        if (isName("on")) {
          advance();
          typeCondition = expectName();
        }
        const directives = parseDirectives(depth);
        items.push({ kind: "inline", typeCondition, directives, selectionSet: parseSelectionSet(depth + 1) });
        continue;
      }
      let name = expectName();
      let alias = null;
      if (isPunct(":")) {
        advance();
        alias = name;
        name = expectName();
      }
      const args = parseArguments(depth);
      const directives = parseDirectives(depth);
      const selectionSet = isPunct("{") ? parseSelectionSet(depth + 1) : null;
      items.push({ kind: "field", name, alias, arguments: args, directives, selectionSet });
    }
    advance();
    if (items.length === 0) throw graphqlSyntaxError("empty selection set.");
    return items;
  }

  const operations = [];
  const fragments = new Map();
  while (peek().kind !== "eof") {
    if (isPunct("{")) {
      operations.push({ operation: "query", name: null, directives: [], selectionSet: parseSelectionSet(1) });
      continue;
    }
    if (!isName()) throw graphqlSyntaxError("expected an operation or fragment.");
    const keyword = peek().value;
    if (keyword === "query" || keyword === "mutation" || keyword === "subscription") {
      advance();
      const name = isName() ? advance().value : null;
      if (isPunct("(")) {
        advance();
        while (!isPunct(")")) {
          if (peek().kind === "eof") throw graphqlSyntaxError("unterminated variable definitions.");
          expectPunct("$");
          expectName();
          expectPunct(":");
          parseType(1);
          if (isPunct("=")) {
            advance();
            parseValue(1, true);
          }
          parseDirectives(1);
        }
        advance();
      }
      const directives = parseDirectives(1);
      operations.push({ operation: keyword, name, directives, selectionSet: parseSelectionSet(1) });
      continue;
    }
    if (keyword === "fragment") {
      advance();
      const name = expectName();
      if (name === "on") throw graphqlSyntaxError("a fragment cannot be named 'on'.");
      if (!isName("on")) throw graphqlSyntaxError("expected 'on' after the fragment name.");
      advance();
      expectName();
      const directives = parseDirectives(1);
      if (fragments.has(name)) throw graphqlSyntaxError(`duplicate fragment ${name}.`);
      fragments.set(name, { name, directives, selectionSet: parseSelectionSet(1) });
      continue;
    }
    throw failure(
      "graphql_unsupported",
      "Only query, mutation, and fragment definitions are supported; schema definitions are not.",
    );
  }
  return { operations, fragments };
}

function collectDirectiveNames(items, fragments, output, seen) {
  for (const item of items) {
    for (const directive of item.directives) output.add(directive.name);
    if (item.kind === "spread") {
      if (seen.has(item.name)) continue;
      const fragment = fragments.get(item.name);
      if (fragment === undefined) throw graphqlSyntaxError(`unknown fragment ${item.name}.`);
      seen.add(item.name);
      for (const directive of fragment.directives) output.add(directive.name);
      collectDirectiveNames(fragment.selectionSet, fragments, output, seen);
    } else if (item.selectionSet) {
      collectDirectiveNames(item.selectionSet, fragments, output, seen);
    }
  }
}

function collectRootFields(items, fragments, output, path) {
  for (const item of items) {
    if (item.kind === "field") {
      output.push(item);
    } else if (item.kind === "inline") {
      collectRootFields(item.selectionSet, fragments, output, path);
    } else {
      if (path.includes(item.name)) throw graphqlSyntaxError(`fragment ${item.name} spreads itself.`);
      const fragment = fragments.get(item.name);
      if (fragment === undefined) throw graphqlSyntaxError(`unknown fragment ${item.name}.`);
      collectRootFields(fragment.selectionSet, fragments, output, [...path, item.name]);
    }
  }
}

function analyzeGraphqlRequest(document, operationName) {
  if (typeof document !== "string" || document.trim().length === 0) {
    throw failure("invalid_input", "document must be a non-empty GraphQL string.");
  }
  if (document.length > GRAPHQL_MAX_DOCUMENT_CHARS) {
    throw failure("invalid_input", `document may contain at most ${GRAPHQL_MAX_DOCUMENT_CHARS} characters.`);
  }
  const { operations, fragments } = parseGraphqlDocument(document);
  if (operations.length !== 1) {
    throw failure(
      "graphql_unsupported",
      "Send exactly one query or mutation per call. Split multiple operations into separate calls.",
    );
  }
  const [operation] = operations;
  if (operationName !== undefined && operation.name !== operationName) {
    throw failure("invalid_input", "operationName does not match the operation in the document.");
  }
  if (operation.operation === "subscription") {
    throw failure("graphql_unsupported", "Subscriptions are not supported.");
  }
  const directiveNames = new Set(operation.directives.map((directive) => directive.name));
  collectDirectiveNames(operation.selectionSet, fragments, directiveNames, new Set());
  if (directiveNames.has("defer") || directiveNames.has("stream")) {
    throw failure("graphql_unsupported", "@defer and @stream are not supported.");
  }
  const rootFields = [];
  collectRootFields(operation.selectionSet, fragments, rootFields, []);
  const fieldNames = [...new Set(rootFields.map((field) => field.name))];
  if (operation.operation === "query") {
    return { operation: "query", operationName: operation.name, rootFields: fieldNames, tier: "read" };
  }
  const meaningful = rootFields.filter((field) => field.name !== "__typename");
  if (meaningful.length !== 1) {
    throw failure(
      "graphql_unsupported",
      "A mutation must select exactly one root field so its outcome can be checked. Send one change per call.",
    );
  }
  const [field] = meaningful;
  return {
    operation: "mutation",
    operationName: operation.name,
    rootFields: [field.name],
    tier: classifyMutationField(field.name),
  };
}

function validateGraphqlVariables(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw failure("invalid_input", "variables must be a plain JSON object.");
  for (const key of Object.keys(value)) {
    if (!graphqlNamePattern.test(key)) {
      throw failure("invalid_input", "variables contains an invalid variable name.");
    }
  }
  try {
    validateJsonTree(value);
  } catch {
    throw failure("invalid_input", "variables must be bounded, plain JSON values.");
  }
  return value;
}

function sanitizeMessage(value) {
  if (typeof value !== "string") return null;
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0);
    output += code <= 0x1f || code === 0x7f ? " " : character;
    if (output.length >= GRAPHQL_MAX_ERROR_MESSAGE_CHARS) break;
  }
  return output.trim();
}

function graphqlErrorDetails(errors) {
  const messages = [];
  if (Array.isArray(errors)) {
    for (const item of errors.slice(0, GRAPHQL_MAX_ERROR_MESSAGES)) {
      if (!isPlainObject(item)) continue;
      const message = sanitizeMessage(item.message);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function redactResponse(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactResponse(item, depth + 1));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] =
      REDACTED_RESPONSE_KEYS.test(key) && (typeof item === "string" || Array.isArray(item))
        ? "[redacted by TritonAI]"
        : redactResponse(item, depth + 1);
  }
  return output;
}

// Sends one generic GraphQL request. Unlike the fixed tools, GraphQL error messages are returned
// (sanitized and bounded) so the assistant can correct its query. They are server text, not
// instructions.
async function rawGraphql(fetchImplementation, apiKey, document, variables, operationName, signal) {
  signal.throwIfAborted();
  const payload = { query: document, variables };
  if (operationName) payload.operationName = operationName;
  const body = JSON.stringify(payload);
  if (encoder.encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw failure("request_too_large", "Kuali request exceeded the byte limit.");
  }
  const composed = timeoutSignal(signal);
  try {
    let response;
    try {
      response = await fetchImplementation(GRAPHQL_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
        signal: composed.signal,
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      if (composed.signal.aborted) throw failure("request_timeout", "Kuali Build request timed out.", true);
      throw failure("network_error", "The UCSD Kuali Build request failed before a response was received.", true);
    }
    if (!(response instanceof Response)) throw failure("invalid_response", "Kuali returned an invalid HTTP response.");
    if (response.url && response.url !== GRAPHQL_URL) {
      throw failure("redirect_rejected", "Kuali response origin or endpoint changed unexpectedly.");
    }
    if (response.status === 401 || response.status === 403) {
      throw failure("authentication_failed", "The UCSD Kuali Build API key was rejected.");
    }
    if (response.status === 429) {
      const seconds = retryAfter(response);
      throw failure(
        "rate_limited",
        "UCSD Kuali Build rate limited the request; no automatic retry was attempted.",
        true,
        seconds === undefined ? {} : { retryAfterSeconds: seconds },
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const isJson = contentType === "application/json" || contentType === "application/graphql-response+json";
    if (!response.ok && !(response.status === 400 && isJson)) {
      throw failure(
        "http_error",
        `UCSD Kuali Build returned HTTP ${response.status}.`,
        response.status >= 500,
        { status: response.status },
      );
    }
    if (!isJson) throw failure("invalid_response", "Kuali returned an unexpected response content type.");
    let parsed;
    try {
      parsed = JSON.parse(decoder.decode(await boundedBody(response)));
    } catch (error) {
      if (error?._tag === "PluginFailure") throw error;
      if (signal.aborted) throw signal.reason;
      if (composed.signal.aborted) throw failure("request_timeout", "Kuali Build request timed out.", true);
      throw failure("invalid_response", "Kuali returned malformed UTF-8 JSON.");
    }
    validateJsonTree(parsed);
    if (!isPlainObject(parsed)) throw failure("invalid_response", "Kuali returned an invalid GraphQL envelope.");
    const hasErrors = Array.isArray(parsed.errors) && parsed.errors.length > 0;
    const hasData = Object.hasOwn(parsed, "data") && parsed.data !== null;
    if (hasData && !isPlainObject(parsed.data)) {
      throw failure("invalid_response", "Kuali returned an invalid GraphQL data value.");
    }
    if (hasErrors) {
      const authFailure = graphqlFailure(parsed.errors, false);
      if (authFailure.code === "authentication_failed") throw authFailure;
    }
    if (!hasErrors && !hasData) {
      throw failure("invalid_response", "Kuali returned a GraphQL response without data.");
    }
    return {
      data: hasData ? parsed.data : null,
      errors: hasErrors ? graphqlErrorDetails(parsed.errors) : [],
      executed: hasData,
    };
  } finally {
    composed.cleanup();
  }
}

const introspectionQueries = Object.freeze({
  roots: `query KualiBuildSchemaRoots { __schema { queryType { name } mutationType { name } types { name kind } } }`,
  type: `query KualiBuildSchemaType($name: String!) { __type(name: $name) { name kind description fields(includeDeprecated: true) { name description isDeprecated args { name type { ...TypeRef } } type { ...TypeRef } } inputFields { name description type { ...TypeRef } } enumValues(includeDeprecated: true) { name description isDeprecated } possibleTypes { name } } } fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`,
});

function typeRefLabel(value, depth = 0) {
  if (!isPlainObject(value) || depth > 8) return "?";
  if (value.kind === "NON_NULL") return `${typeRefLabel(value.ofType, depth + 1)}!`;
  if (value.kind === "LIST") return `[${typeRefLabel(value.ofType, depth + 1)}]`;
  return typeof value.name === "string" ? value.name : "?";
}

function shortDescription(value) {
  const text = sanitizeMessage(value);
  if (!text) return null;
  return text.length > SCHEMA_DESCRIPTION_CHARS ? `${text.slice(0, SCHEMA_DESCRIPTION_CHARS)}…` : text;
}

function projectSchemaType(value, mutationTypeName) {
  if (!isPlainObject(value) || typeof value.name !== "string") {
    throw failure("invalid_response", "Kuali returned an invalid schema type.");
  }
  const isMutationRoot = value.name === mutationTypeName;
  const project = (field) => {
    if (!isPlainObject(field) || typeof field.name !== "string") {
      throw failure("invalid_response", "Kuali returned an invalid schema field.");
    }
    const output = {
      name: field.name,
      type: typeRefLabel(field.type),
      description: shortDescription(field.description),
    };
    if (Array.isArray(field.args)) {
      output.args = field.args.slice(0, 50).map((arg) => ({
        name: typeof arg?.name === "string" ? arg.name : "?",
        type: typeRefLabel(arg?.type),
      }));
    }
    if (field.isDeprecated === true) output.deprecated = true;
    if (isMutationRoot) output.permission = classifyMutationField(field.name);
    return output;
  };
  const fields = Array.isArray(value.fields) ? value.fields : [];
  const inputFields = Array.isArray(value.inputFields) ? value.inputFields : [];
  const enumValues = Array.isArray(value.enumValues) ? value.enumValues : [];
  return {
    name: value.name,
    kind: typeof value.kind === "string" ? value.kind : null,
    description: shortDescription(value.description),
    fields: fields.slice(0, SCHEMA_MAX_FIELDS).map(project),
    inputFields: inputFields.slice(0, SCHEMA_MAX_FIELDS).map(project),
    enumValues: enumValues.slice(0, SCHEMA_MAX_FIELDS).map((item) => ({
      name: typeof item?.name === "string" ? item.name : "?",
      description: shortDescription(item?.description),
    })),
    possibleTypes: Array.isArray(value.possibleTypes)
      ? value.possibleTypes.slice(0, SCHEMA_MAX_FIELDS).map((item) => item?.name).filter((name) => typeof name === "string")
      : [],
    truncated:
      fields.length > SCHEMA_MAX_FIELDS ||
      inputFields.length > SCHEMA_MAX_FIELDS ||
      enumValues.length > SCHEMA_MAX_FIELDS,
  };
}

function validateGenericInput(toolName, value) {
  if (toolName === "kuali-build.graphql.schema") {
    const input = ownKeys(value, new Set(["typeName", "search"]), "Input");
    const output = {};
    if (Object.hasOwn(input, "typeName")) {
      if (typeof input.typeName !== "string" || !graphqlNamePattern.test(input.typeName)) {
        throw failure("invalid_input", "typeName must be a GraphQL type name.");
      }
      output.typeName = input.typeName;
    }
    if (Object.hasOwn(input, "search")) output.search = validateSearch(input.search);
    return output;
  }
  const isMutation = toolName !== "kuali-build.graphql.query";
  const allowed = new Set(["document", "variables", "operationName"]);
  if (isMutation) allowed.add("confirmMutation");
  const input = ownKeys(value, allowed, "Input");
  if (isMutation && input.confirmMutation !== true) {
    throw failure(
      "confirmation_required",
      "confirmMutation must be true after the exact change has been shown to the user.",
    );
  }
  let operationName;
  if (Object.hasOwn(input, "operationName")) {
    if (typeof input.operationName !== "string" || !graphqlNamePattern.test(input.operationName)) {
      throw failure("invalid_input", "operationName must be a GraphQL name.");
    }
    operationName = input.operationName;
  }
  const analysis = analyzeGraphqlRequest(input.document, operationName);
  const variables = validateGraphqlVariables(input.variables);
  if (toolName === "kuali-build.graphql.query" && analysis.operation !== "query") {
    throw failure(
      "wrong_tool",
      "This tool runs queries only. Use kuali-build.graphql.mutate or kuali-build.graphql.admin for changes.",
    );
  }
  if (toolName === "kuali-build.graphql.mutate") {
    if (analysis.operation !== "mutation") {
      throw failure("wrong_tool", "This tool runs mutations only. Use kuali-build.graphql.query for reads.");
    }
    if (analysis.tier !== "write") {
      throw failure(
        "admin_required",
        `${analysis.rootFields[0]} is not on the reviewed Write list. Use kuali-build.graphql.admin, which requires the Admin & delete permission.`,
        false,
        { rootField: analysis.rootFields[0] },
      );
    }
  }
  if (toolName === "kuali-build.graphql.admin" && analysis.operation !== "mutation") {
    throw failure("wrong_tool", "This tool runs mutations only. Use kuali-build.graphql.query for reads.");
  }
  return { document: input.document, variables, operationName, analysis };
}

export function createIntegrationProvider(context) {
  const factory = ownKeys(context, new Set(["secrets", "configuration"]), "Factory context");
  if (!isPlainObject(factory.secrets) || !["get", "set", "remove"].every((name) => typeof factory.secrets[name] === "function")) {
    throw failure("invalid_context", "The package-scoped secret store is invalid.");
  }
  validateConfiguration(factory.configuration);
  const fetchImplementation = globalThis.fetch;
  if (typeof fetchImplementation !== "function") throw failure("invalid_runtime", "The Node fetch API is unavailable.");
  const flows = new Map();
  let closed = false;

  function ensureOpen() {
    if (closed) throw failure("provider_closed", "The Kuali Build provider is closed.");
  }

  async function execute(apiKey, operation, variables, signal) {
    return graphql(fetchImplementation, apiKey, queries[operation], variables, signal);
  }

  let schemaCache = null;

  async function introspect(apiKey, operation, variables, signal) {
    const result = await rawGraphql(
      fetchImplementation,
      apiKey,
      introspectionQueries[operation],
      variables,
      undefined,
      signal,
    );
    if (result.errors.length > 0 || result.data === null) {
      throw failure("graphql_error", "Kuali Build rejected the schema request.", false, {
        messages: result.errors,
      });
    }
    return result.data;
  }

  async function schemaRoots(apiKey, signal) {
    if (schemaCache !== null && schemaCache.apiKey === apiKey && schemaCache.expiresAt > Date.now()) {
      return schemaCache;
    }
    const data = await introspect(apiKey, "roots", {}, signal);
    const schema = extract(data, "__schema");
    if (!isPlainObject(schema) || !Array.isArray(schema.types)) {
      throw failure("invalid_response", "Kuali returned an invalid schema.");
    }
    const queryTypeName = isPlainObject(schema.queryType) && typeof schema.queryType.name === "string"
      ? schema.queryType.name
      : null;
    const mutationTypeName = isPlainObject(schema.mutationType) && typeof schema.mutationType.name === "string"
      ? schema.mutationType.name
      : null;
    const types = schema.types
      .filter((type) => isPlainObject(type) && typeof type.name === "string" && !type.name.startsWith("__"))
      .map((type) => ({ name: type.name, kind: typeof type.kind === "string" ? type.kind : null }));
    schemaCache = { apiKey, expiresAt: Date.now() + SCHEMA_CACHE_MS, queryTypeName, mutationTypeName, types };
    return schemaCache;
  }

  async function schemaType(apiKey, name, mutationTypeName, signal) {
    const value = extract(await introspect(apiKey, "type", { name }, signal), "__type");
    return value === null ? null : projectSchemaType(value, mutationTypeName);
  }

  async function executeGenericMutation(apiKey, parsed, invocationContext) {
    validateWriteInvocation(invocationContext);
    invocationContext.signal.throwIfAborted();
    const rootField = parsed.analysis.rootFields[0];
    const outcomeDetails = { rootField, operationName: parsed.operationName ?? null };
    const commitSignal = await invocationContext.beginCommit();
    if (!(commitSignal instanceof AbortSignal)) {
      throw failure("invalid_context", "The host commit signal is invalid.");
    }
    commitSignal.throwIfAborted();
    let result;
    try {
      result = await rawGraphql(
        fetchImplementation,
        apiKey,
        parsed.document,
        parsed.variables,
        parsed.operationName,
        commitSignal,
      );
    } catch (error) {
      if (isAmbiguousWriteFailure(error, commitSignal)) {
        throw externalCommitOutcomeUnknown(rootField, outcomeDetails);
      }
      throw error;
    }
    if (result.errors.length > 0) {
      if (!result.executed) {
        throw failure(
          "graphql_error",
          "Kuali Build rejected the mutation before running it. Nothing was changed.",
          false,
          { ...outcomeDetails, messages: result.errors, executed: false },
        );
      }
      throw externalCommitOutcomeUnknown(rootField, { ...outcomeDetails, messages: result.errors });
    }
    return {
      data: redactResponse(result.data),
      rootField,
      permission: parsed.analysis.tier,
      committed: true,
    };
  }

  async function executeMutation(
    apiKey,
    operation,
    variables,
    invocationContext,
    outcomeDetails,
    project,
  ) {
    validateWriteInvocation(invocationContext);
    validateRequestSize(queries[operation], variables);
    invocationContext.signal.throwIfAborted();
    const commitSignal = await invocationContext.beginCommit();
    if (!(commitSignal instanceof AbortSignal)) {
      throw failure("invalid_context", "The host commit signal is invalid.");
    }
    commitSignal.throwIfAborted();
    try {
      const data = await execute(apiKey, operation, variables, commitSignal);
      return project(data);
    } catch (error) {
      if (isAmbiguousWriteFailure(error, commitSignal)) {
        throw externalCommitOutcomeUnknown(operation, outcomeDetails);
      }
      throw error;
    }
  }

  async function verifyConnection(apiKey, signal) {
    const data = await execute(apiKey, "appsList", {}, signal);
    projectApps(extract(data, "apps"));
  }

  async function persistCredential(apiKey, capabilities, lifecycleContext) {
    lifecycleContext.signal.throwIfAborted();
    const commitSignal = await lifecycleContext.beginCommit();
    if (!(commitSignal instanceof AbortSignal)) {
      throw failure("invalid_context", "The host commit signal is invalid.");
    }
    commitSignal.throwIfAborted();
    const serialized = JSON.stringify({ version: 1, apiKey, capabilities });
    try {
      await factory.secrets.set(SECRET_NAME, serialized);
    } catch {
      let recovered;
      try {
        recovered = await factory.secrets.get(SECRET_NAME);
      } catch {
        throw failure("secret_store_error", "The credential-store commit could not be confirmed.");
      }
      if (recovered !== serialized) {
        throw failure("secret_store_error", "The API key could not be stored.");
      }
    }
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
          return { state: "error", accountLabel: null, grantedCapabilities: [], message: error.message };
        }
        throw error;
      }
      if (credential === null) {
        return { state: "not_connected", accountLabel: null, grantedCapabilities: [], message: null };
      }
      try {
        await verifyConnection(credential.apiKey, operationContext.signal);
        return {
          state: "connected",
          accountLabel: "UC San Diego Kuali Build",
          grantedCapabilities: credential.capabilities,
          message: null,
        };
      } catch (error) {
        if (error?.code === "authentication_failed") {
          return {
            state: "not_connected",
            accountLabel: "UC San Diego Kuali Build",
            grantedCapabilities: [],
            message: "The stored UCSD Kuali Build API key was rejected.",
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
        const stored = parseSecret(await readSecret(factory.secrets));
        if (stored !== null && stored !== undefined) {
          await verifyConnection(stored.apiKey, lifecycleContext.signal);
          if (
            stored.needsMigration ||
            stored.capabilities.length !== granted.length ||
            stored.capabilities.some((capability, index) => capability !== granted[index])
          ) {
            await persistCredential(stored.apiKey, granted, lifecycleContext);
          }
          return {
            kind: "connected",
            flowId: crypto.randomUUID(),
            message: connectionMessage(granted),
          };
        }
        const flowId = createFlow(flows, granted);
        return {
          kind: "api_key",
          flowId,
          label: "UCSD Kuali Build API key",
          placeholder: null,
          message: "Create a user-scoped API key in UC San Diego Kuali Build, then paste it below. The key uses your existing Kuali permissions and is stored only in the package-scoped secret store.",
          setupUrl: API_KEY_SETTINGS_URL,
          setupInstructions: [
            "Open API key settings and sign in with your UC San Diego account if prompted.",
            "Create a new API key and copy the full key when Kuali displays it.",
            "Return here, paste the key below, and select Connect. TritonAI validates it against the UCSD tenant before saving it.",
          ],
        };
      }
      const submitted = ownKeys(submission, new Set(["kind", "flowId", "value"]), "Connection submission");
      if (submitted.kind !== "api_key" || typeof submitted.flowId !== "string") {
        throw failure("invalid_submission", "The API-key connection submission is invalid.");
      }
      const flow = flows.get(submitted.flowId);
      flows.delete(submitted.flowId);
      if (!flow || flow.expiresAt < Date.now()) throw failure("flow_expired", "The connection flow expired.");
      const apiKey = validateApiKey(submitted.value);
      await verifyConnection(apiKey, lifecycleContext.signal);
      await persistCredential(apiKey, flow.capabilities, lifecycleContext);
      return {
        kind: "connected",
        flowId: submitted.flowId,
        message: connectionMessage(flow.capabilities),
      };
    },
    async disconnect(lifecycleContext) {
      ensureOpen();
      validateOperationContext(lifecycleContext, { requiresCommit: true });
      const storedCredential = await readSecret(factory.secrets);
      if (storedCredential === null) return;
      lifecycleContext.signal.throwIfAborted();
      const commitSignal = await lifecycleContext.beginCommit();
      if (!(commitSignal instanceof AbortSignal)) throw failure("invalid_context", "The host commit signal is invalid.");
      commitSignal.throwIfAborted();
      try {
        await factory.secrets.remove(SECRET_NAME);
      } catch {
        let recovered;
        try {
          recovered = await factory.secrets.get(SECRET_NAME);
        } catch {
          throw failure("secret_store_error", "Credential removal could not be confirmed.");
        }
        if (recovered !== null) throw failure("secret_store_error", "The API key could not be removed.");
      }
    },
    async invoke(toolName, input, invocationContext) {
      ensureOpen();
      validateOperationContext(invocationContext, { invocation: true });
      const parsed = validateInput(toolName, input);
      const credential = await readCredential(factory.secrets);
      if (credential === null) throw failure("not_connected", "Connect the UCSD Kuali Build plugin first.");
      switch (toolName) {
        case "kuali-build.apps.list": {
          const data = await execute(credential.apiKey, "appsList", {}, invocationContext.signal);
          const available = projectApps(extract(data, "apps"));
          const apps = available.slice(0, parsed.limit);
          return {
            apps,
            returned: apps.length,
            truncated: available.length > apps.length,
          };
        }
        case "kuali-build.apps.get": {
          const data = await execute(
            credential.apiKey,
            "appGet",
            { id: parsed.appId },
            invocationContext.signal,
          );
          const app = extract(data, "app");
          return { app: app === null ? null : projectApp(app) };
        }
        case "kuali-build.forms.schema": {
          const app = extract(await execute(credential.apiKey, "formSchema", { id: parsed.appId }, invocationContext.signal), "app");
          if (app === null) return { app: null };
          if (!isPlainObject(app) || typeof app.id !== "string" || typeof app.name !== "string") {
            throw failure("invalid_response", "Kuali returned an invalid app.");
          }
          if (app.formVersion === null) {
            return {
              app: { id: app.id, name: app.name },
              fields: [],
              fieldCount: 0,
              published: false,
              truncated: false,
            };
          }
          if (!isPlainObject(app.formVersion) || !Array.isArray(app.formVersion.schema)) {
            throw failure("invalid_response", "Kuali returned an invalid published form schema.");
          }
          const fields = app.formVersion.schema.slice(0, MAX_SCHEMA_FIELDS).map((field) => {
            if (!isPlainObject(field)) {
              throw failure("invalid_response", "Kuali returned an invalid form field.");
            }
            return {
              formKey: typeof field.formKey === "string" ? field.formKey : null,
              label: typeof field.label === "string" ? field.label : null,
            };
          });
          return {
            app: { id: app.id, name: app.name },
            fields,
            fieldCount: app.formVersion.schema.length,
            published: true,
            truncated: app.formVersion.schema.length > fields.length,
          };
        }
        case "kuali-build.documents.list": {
          const operators = [];
          if (parsed.workflowStatus !== undefined) operators.push({ field: "meta.workflowStatus", type: "IS", value: parsed.workflowStatus });
          if (parsed.updatedAfter !== undefined) operators.push({ field: "meta.updatedAt", type: "RANGE", min: String(parsed.updatedAfter) });
          const variables = {
            appId: parsed.appId,
            skip: parsed.skip,
            limit: parsed.limit,
            sort: ["meta.updatedAt"],
            query: parsed.query ?? "",
            fields: operators.length === 0 ? null : { type: "AND", operators },
          };
          const app = extract(await execute(credential.apiKey, "documentsList", variables, invocationContext.signal), "app");
          if (app === null) {
            return { app: null, documents: [], pageInfo: null, totalCount: 0, truncated: false };
          }
          if (
            !isPlainObject(app) ||
            typeof app.id !== "string" ||
            typeof app.name !== "string" ||
            !isPlainObject(app.documentConnection) ||
            !Array.isArray(app.documentConnection.edges) ||
            !Number.isSafeInteger(app.documentConnection.totalCount)
          ) {
            throw failure("invalid_response", "Kuali returned an invalid document connection.");
          }
          const selectedEdges = app.documentConnection.edges.slice(0, parsed.limit);
          const documents = selectedEdges.map((edge) => {
            if (!isPlainObject(edge)) {
              throw failure("invalid_response", "Kuali returned an invalid document edge.");
            }
            return projectDocumentSummary(edge.node);
          });
          return {
            app: { id: app.id, name: app.name },
            documents,
            pageInfo: projectPageInfo(app.documentConnection.pageInfo),
            totalCount: app.documentConnection.totalCount,
            truncated: app.documentConnection.edges.length > selectedEdges.length,
          };
        }
        case "kuali-build.documents.get": {
          const document = extract(
            await execute(
              credential.apiKey,
              "documentGet",
              { id: parsed.documentId },
              invocationContext.signal,
            ),
            "document",
          );
          return { document: document === null ? null : projectDocument(document) };
        }
        case "kuali-build.documents.drafts.resolve": {
          const action = extract(
            await execute(
              credential.apiKey,
              "actionGet",
              { actionId: parsed.actionId },
              invocationContext.signal,
            ),
            "action",
          );
          return { action: action === null ? null : projectDraftAction(action) };
        }
        case "kuali-build.documents.update": {
          validateWriteInvocation(invocationContext);
          requireCapability(credential, WRITE_CAPABILITY);
          const current = extract(
            await execute(
              credential.apiKey,
              "documentVersion",
              { id: parsed.documentId },
              invocationContext.signal,
            ),
            "document",
          );
          if (current === null) {
            throw failure("document_not_found", "The Kuali Build document was not found.");
          }
          if (!isPlainObject(current) || !isPlainObject(current.meta)) {
            throw failure(
              "concurrency_check_unavailable",
              "Kuali did not return meta.updatedAt, so the edit was not attempted.",
            );
          }
          const currentUpdatedAt = current.meta.updatedAt;
          if (
            typeof currentUpdatedAt !== "string" &&
            !(typeof currentUpdatedAt === "number" && Number.isSafeInteger(currentUpdatedAt))
          ) {
            throw failure(
              "concurrency_check_unavailable",
              "Kuali did not return a usable meta.updatedAt, so the edit was not attempted.",
            );
          }
          if (String(currentUpdatedAt) !== parsed.expectedUpdatedAt) {
            throw failure(
              "document_changed",
              "The document changed since it was read. Read it again, review the new values, and prepare a new update.",
              false,
              { currentUpdatedAt: String(currentUpdatedAt) },
            );
          }
          return executeMutation(
            credential.apiKey,
            "documentUpdate",
            { id: parsed.documentId, data: parsed.data },
            invocationContext,
            { documentId: parsed.documentId },
            (data) => {
              const updated = extract(data, "updateDocument");
              if (
                !isPlainObject(updated) ||
                typeof updated.id !== "string" ||
                !objectIdPattern.test(updated.id) ||
                updated.id.toLowerCase() !== parsed.documentId
              ) {
                throw failure("invalid_response", "Kuali returned an invalid updated document.");
              }
              return {
                document: { id: updated.id.toLowerCase() },
                updatedFormKeys: Object.keys(parsed.data),
                precondition: { expectedUpdatedAt: parsed.expectedUpdatedAt },
              };
            },
          );
        }
        case "kuali-build.documents.drafts.initialize": {
          validateWriteInvocation(invocationContext);
          requireCapability(credential, WRITE_CAPABILITY);
          const app = extract(
            await execute(
              credential.apiKey,
              "appGet",
              { id: parsed.appId },
              invocationContext.signal,
            ),
            "app",
          );
          if (app === null) throw failure("app_not_found", "The Kuali Build app was not found.");
          projectApp(app);
          return executeMutation(
            credential.apiKey,
            "draftInitialize",
            { appId: parsed.appId },
            invocationContext,
            { appId: parsed.appId },
            (data) => {
              const initialized = extract(data, "initializeWorkflow");
              if (
                !isPlainObject(initialized) ||
                typeof initialized.actionId !== "string" ||
                !objectIdPattern.test(initialized.actionId)
              ) {
                throw failure("invalid_response", "Kuali returned an invalid initialized draft.");
              }
              return {
                appId: parsed.appId,
                actionId: initialized.actionId.toLowerCase(),
                state: "draft_initialized",
                nextTool: "kuali-build.documents.drafts.resolve",
                atomic: false,
              };
            },
          );
        }
        case "kuali-build.documents.submit": {
          validateWriteInvocation(invocationContext);
          requireCapability(credential, WRITE_CAPABILITY);
          const actionValue = extract(
            await execute(
              credential.apiKey,
              "actionGet",
              { actionId: parsed.actionId },
              invocationContext.signal,
            ),
            "action",
          );
          if (actionValue === null) {
            throw failure("draft_action_not_found", "The Kuali Build draft action was not found.");
          }
          const action = projectDraftAction(actionValue);
          if (action.documentId !== parsed.documentId) {
            throw failure(
              "draft_action_mismatch",
              "The action ID does not belong to the supplied draft document ID.",
            );
          }
          return executeMutation(
            credential.apiKey,
            "documentSubmit",
            {
              documentId: parsed.documentId,
              data: parsed.data,
              actionId: parsed.actionId,
              status: "completed",
            },
            invocationContext,
            { actionId: parsed.actionId, documentId: parsed.documentId },
            (data) => {
              const result = extract(data, "submitDocument");
              if (typeof result !== "string" || result.length === 0 || result.length > 128) {
                throw failure("invalid_response", "Kuali returned an invalid submission result.");
              }
              return {
                actionId: parsed.actionId,
                documentId: parsed.documentId,
                result,
                state: "submitted",
                workflowStarted: true,
                atomic: false,
              };
            },
          );
        }
        case "kuali-build.users.lookup": {
          const connection = extract(
            await execute(
              credential.apiKey,
              "usersLookup",
              { query: parsed.query, limit: MAX_USER_RESULTS + 1 },
              invocationContext.signal,
            ),
            "usersConnection",
          );
          if (!isPlainObject(connection) || !Array.isArray(connection.edges)) throw failure("invalid_response", "Kuali returned an invalid user connection.");
          const users = connection.edges.slice(0, MAX_USER_RESULTS).map((edge) => {
            if (!isPlainObject(edge)) throw failure("invalid_response", "Kuali returned an invalid user edge.");
            return projectUser(edge.node);
          });
          return {
            users,
            returned: users.length,
            truncated: connection.edges.length > users.length,
          };
        }
        case "kuali-build.graphql.schema": {
          const roots = await schemaRoots(credential.apiKey, invocationContext.signal);
          if (parsed.typeName !== undefined) {
            const type = await schemaType(
              credential.apiKey,
              parsed.typeName,
              roots.mutationTypeName,
              invocationContext.signal,
            );
            return { type };
          }
          const queryRoot = roots.queryTypeName === null
            ? null
            : await schemaType(credential.apiKey, roots.queryTypeName, roots.mutationTypeName, invocationContext.signal);
          const mutationRoot = roots.mutationTypeName === null
            ? null
            : await schemaType(credential.apiKey, roots.mutationTypeName, roots.mutationTypeName, invocationContext.signal);
          const needle = parsed.search?.toLowerCase();
          const matching = needle === undefined
            ? roots.types
            : roots.types.filter((type) => type.name.toLowerCase().includes(needle));
          const filterFields = (fields) => needle === undefined
            ? fields
            : fields.filter((field) =>
                field.name.toLowerCase().includes(needle) ||
                (field.description ?? "").toLowerCase().includes(needle));
          return {
            queries: queryRoot === null ? [] : filterFields(queryRoot.fields),
            mutations: mutationRoot === null ? [] : filterFields(mutationRoot.fields),
            types: matching.slice(0, SCHEMA_MAX_TYPE_NAMES),
            typesTruncated: matching.length > SCHEMA_MAX_TYPE_NAMES,
            grantedPermissions: credential.capabilities,
            note: "Each mutation lists the permission it needs. Use kuali-build.graphql.schema with typeName for a type's fields and arguments.",
          };
        }
        case "kuali-build.graphql.query": {
          const result = await rawGraphql(
            fetchImplementation,
            credential.apiKey,
            parsed.document,
            parsed.variables,
            parsed.operationName,
            invocationContext.signal,
          );
          if (result.data === null) {
            throw failure("graphql_error", "Kuali Build rejected the query.", false, {
              messages: result.errors,
            });
          }
          return {
            data: redactResponse(result.data),
            errors: result.errors,
            rootFields: parsed.analysis.rootFields,
          };
        }
        case "kuali-build.graphql.mutate": {
          validateWriteInvocation(invocationContext);
          requireCapability(credential, WRITE_CAPABILITY);
          return executeGenericMutation(credential.apiKey, parsed, invocationContext);
        }
        case "kuali-build.graphql.admin": {
          validateWriteInvocation(invocationContext);
          requireCapability(credential, ADMIN_CAPABILITY);
          return executeGenericMutation(credential.apiKey, parsed, invocationContext);
        }
        case "kuali-build.workflows.status": {
          const document = extract(
            await execute(
              credential.apiKey,
              "workflowStatus",
              { id: parsed.documentId },
              invocationContext.signal,
            ),
            "document",
          );
          if (document === null) return { document: null };
          if (
            !isPlainObject(document) ||
            typeof document.id !== "string" ||
            !objectIdPattern.test(document.id) ||
            !isPlainObject(document.meta)
          ) {
            throw failure("invalid_response", "Kuali returned invalid workflow metadata.");
          }
          return {
            document: {
              id: document.id.toLowerCase(),
              workflowStatus: document.meta.workflowStatus ?? null,
              workflowData: document.meta.workflowData ?? null,
              submittedAt: document.meta.submittedAt ?? null,
              updatedAt: document.meta.updatedAt ?? null,
            },
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
