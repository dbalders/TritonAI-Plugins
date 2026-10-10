import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as NodeHttp from "node:http";

const PROVIDER_ID = "jira-data-center";
const READ = "jira-data-center.read";
const WRITE = "jira-data-center.write";
const SECRET_NAME = "oauth-credential";
// Version 1 stored a personal access token. It is never used again and is removed on connect
// and disconnect.
const LEGACY_SECRET_NAME = "personal-access-token";
const TENANT_ORIGIN = "https://its-pro.ucsd.edu";
const API_ROOT = `${TENANT_ORIGIN}/rest/api/2`;
const AUTHORIZE_ENDPOINT = `${TENANT_ORIGIN}/rest/oauth2/latest/authorize`;
const BROKER_CALLBACK_PATH = "/jira/callback";
const LOOPBACK_CALLBACK_PATH = "/tritonai/jira/callback";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50_000;
const MAX_OBJECT_KEYS = 1_000;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_STRING_CHARS = 1_048_576;
const MAX_TOKEN_CHARS = 4_096;
const FLOW_LIFETIME_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_SECONDS = 2;
const ACCESS_SKEW_MS = 60_000;
const PLAN_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_PLANS = 8;
const UNCONFIRMED_MEMORY_MS = 24 * 60 * 60 * 1_000;
const MAX_UNCONFIRMED = 32;
const MAX_PROJECT_RESULTS = 100;
const MAX_SEARCH_RESULTS = 50;
const MAX_COMMENT_RESULTS = 50;
const MAX_FIELD_RESULTS = 200;
const MAX_USER_RESULTS = 20;
const MAX_WORKLOG_RESULTS = 50;
const MAX_META_FIELDS = 200;
const MAX_ALLOWED_VALUES = 100;
const MAX_DESCRIPTION_CHARS = 100_000;
const MAX_COMMENT_BODY_CHARS = 100_000;
const MAX_WRITE_TEXT_CHARS = 32_000;
const MAX_PREVIEW_TEXT_CHARS = 2_000;
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const issueKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,49}-[1-9][0-9]{0,11}$/u;
const projectKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,49}$/u;
const numericIdPattern = /^[1-9][0-9]{0,17}$/u;
const customFieldPattern = /^customfield_[1-9][0-9]{0,9}$/u;
const usernamePattern = /^[^\s\u0000-\u001f\u007f][^\u0000-\u001f\u007f]{0,254}$/u;
const labelPattern = /^[^\s\u0000-\u001f\u007f]{1,255}$/u;
const datePattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;
const timeSpentPattern = /^(?:[1-9]\d{0,3}[wdhm])(?: [1-9]\d{0,3}[wdhm]){0,3}$/u;
const startedPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/u;
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
  "parent",
]);
// Typed fields a prepare tool may set. Custom fields use their exact `customfield_N` ID.
const STANDARD_WRITE_FIELDS = Object.freeze({
  summary: "summary",
  description: "description",
  priority: "priority",
  labels: "labels",
  components: "components",
  dueDate: "duedate",
});

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

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function textEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateHttpsOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw failure("invalid_configuration", `${label} is not a valid URL.`);
  }
  if (
    typeof value !== "string" ||
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (value !== parsed.origin && value !== `${parsed.origin}/`)
  ) {
    throw failure("invalid_configuration", `${label} must be an exact HTTPS origin.`);
  }
  return parsed.origin;
}

function validateConfiguration(value) {
  const configuration = ownKeys(
    value,
    new Set(["tenantUrl", "brokerUrl", "oauthClientId"]),
    "Configuration",
  );
  const tenantUrl = Object.hasOwn(configuration, "tenantUrl")
    ? configuration.tenantUrl
    : TENANT_ORIGIN;
  if (validateHttpsOrigin(tenantUrl, "tenantUrl") !== TENANT_ORIGIN || tenantUrl !== TENANT_ORIGIN) {
    throw failure("invalid_configuration", `tenantUrl must be exactly ${TENANT_ORIGIN}.`);
  }
  const brokerUrl = validateHttpsOrigin(configuration.brokerUrl, "brokerUrl");
  if (brokerUrl === TENANT_ORIGIN) {
    throw failure("invalid_configuration", "brokerUrl must be the TritonAI Jira OAuth relay.");
  }
  const clientId = configuration.oauthClientId;
  if (typeof clientId !== "string" || !/^[A-Za-z0-9._~-]{1,256}$/u.test(clientId)) {
    throw failure("invalid_configuration", "oauthClientId must be the Jira OAuth client ID.");
  }
  return { brokerUrl, clientId };
}

function validateOperationContext(context, { requiresCommit = false, invocation = false } = {}) {
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

async function admitCommit(context) {
  const signal = await context.beginCommit();
  if (!(signal instanceof AbortSignal)) {
    throw failure("invalid_context", "The host commit signal is invalid.");
  }
  signal.throwIfAborted();
  return signal;
}

function hasControlCharacters(value, { allowNewlines = false } = {}) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (allowNewlines && (code === 0x0a || code === 0x0d || code === 0x09)) continue;
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
    throw failure("invalid_input", `${label} must be ${minimum}-${maximum} visible characters.`);
  }
  return value;
}

function validateText(value, label, maximum = MAX_WRITE_TEXT_CHARS) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    value.trim().length === 0 ||
    hasControlCharacters(value, { allowNewlines: true })
  ) {
    throw failure("invalid_input", `${label} must be 1-${maximum} characters of text.`);
  }
  return value;
}

function validatePattern(value, pattern, label, transform = (text) => text) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw failure("invalid_input", `${label} is invalid.`);
  }
  return transform(value);
}

function validateIssueKey(value, label = "issueKey") {
  return validatePattern(value, issueKeyPattern, label, (text) => text.toUpperCase());
}

function validateInteger(value, label, minimum, maximum, fallback) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw failure(
      "invalid_input",
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return selected;
}

function optional(input, key, validate) {
  return Object.hasOwn(input, key) ? validate(input[key]) : undefined;
}

function validateCustomFieldValue(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure("invalid_input", "Custom field numbers must be finite.");
    return value;
  }
  if (typeof value === "string") return validateText(value, "Custom field text");
  if (depth >= 2) throw failure("invalid_input", "Custom field values are nested too deeply.");
  if (Array.isArray(value)) {
    if (value.length > 50) throw failure("invalid_input", "Custom field arrays allow 50 values.");
    return value.map((item) => validateCustomFieldValue(item, depth + 1));
  }
  // Option, user, and version references such as { "value": "High" } or { "id": "10100" }.
  const reference = ownKeys(value, new Set(["id", "value", "name", "key"]), "Custom field value");
  const entries = Object.entries(reference);
  if (entries.length !== 1) {
    throw failure("invalid_input", "Custom field references need exactly one of id, value, name, or key.");
  }
  const [[key, item]] = entries;
  return { [key]: validateVisibleString(item, `Custom field ${key}`, 1, 1_024) };
}

function validateFieldChanges(input, { creating }) {
  const changes = {};
  const summary = optional(input, "summary", (value) =>
    validateVisibleString(value, "summary", 1, 255),
  );
  if (summary !== undefined) changes.summary = summary;
  const description = optional(input, "description", (value) =>
    value === null ? null : validateText(value, "description"),
  );
  if (description !== undefined) changes.description = description;
  const priority = optional(input, "priority", (value) =>
    validateVisibleString(value, "priority", 1, 255),
  );
  if (priority !== undefined) changes.priority = priority;
  const labels = optional(input, "labels", (value) => {
    if (!Array.isArray(value) || value.length > 20) {
      throw failure("invalid_input", "labels must be an array of up to 20 labels.");
    }
    const unique = [...new Set(value.map((label) => validatePattern(label, labelPattern, "label")))];
    return unique;
  });
  if (labels !== undefined) changes.labels = labels;
  const components = optional(input, "components", (value) => {
    if (!Array.isArray(value) || value.length > 20) {
      throw failure("invalid_input", "components must be an array of up to 20 component names.");
    }
    return [...new Set(value.map((name) => validateVisibleString(name, "component", 1, 255)))];
  });
  if (components !== undefined) changes.components = components;
  const dueDate = optional(input, "dueDate", (value) =>
    value === null ? null : validatePattern(value, datePattern, "dueDate"),
  );
  if (dueDate !== undefined) changes.dueDate = dueDate;
  const customFields = optional(input, "customFields", (value) => {
    if (!isPlainObject(value)) throw failure("invalid_input", "customFields must be an object.");
    const entries = Object.entries(value);
    if (entries.length > 20) throw failure("invalid_input", "customFields allows 20 fields.");
    const output = {};
    for (const [key, item] of entries) {
      if (!customFieldPattern.test(key)) {
        throw failure("invalid_input", "customFields keys must be customfield_N field IDs.");
      }
      output[key] = validateCustomFieldValue(item);
    }
    return output;
  });
  if (customFields !== undefined && Object.keys(customFields).length > 0) {
    changes.customFields = customFields;
  }
  if (!creating && Object.keys(changes).length === 0) {
    throw failure("invalid_input", "Specify at least one field to change.");
  }
  if (creating && changes.summary === undefined) {
    throw failure("invalid_input", "summary is required to create an issue.");
  }
  return changes;
}

const FIELD_INPUT_KEYS = [
  "summary",
  "description",
  "priority",
  "labels",
  "components",
  "dueDate",
  "customFields",
];

function validateUnconfirmedReference(input) {
  return optional(input, "afterUnconfirmedOperationId", (value) =>
    validatePattern(
      value,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      "afterUnconfirmedOperationId",
    ),
  );
}

function validateInput(toolName, value) {
  switch (toolName) {
    case "jira.me.get":
    case "jira.issue_link_types.list": {
      ownKeys(value, new Set(), "Input");
      return {};
    }
    case "jira.projects.list": {
      const input = ownKeys(value, new Set(["limit"]), "Input");
      return { limit: validateInteger(input.limit, "limit", 1, MAX_PROJECT_RESULTS, 50) };
    }
    case "jira.issues.search": {
      const input = ownKeys(value, new Set(["jql", "startAt", "maxResults"]), "Input");
      return {
        jql: validateVisibleString(input.jql, "jql", 1, 2_000),
        startAt: validateInteger(input.startAt, "startAt", 0, 10_000, 0),
        maxResults: validateInteger(input.maxResults, "maxResults", 1, MAX_SEARCH_RESULTS, 25),
      };
    }
    case "jira.issues.get":
    case "jira.transitions.list":
    case "jira.issues.edit_metadata": {
      const input = ownKeys(value, new Set(["issueKey"]), "Input");
      return { issueKey: validateIssueKey(input.issueKey) };
    }
    case "jira.comments.list":
    case "jira.worklogs.list": {
      const maximum = toolName === "jira.comments.list" ? MAX_COMMENT_RESULTS : MAX_WORKLOG_RESULTS;
      const input = ownKeys(value, new Set(["issueKey", "startAt", "maxResults"]), "Input");
      return {
        issueKey: validateIssueKey(input.issueKey),
        startAt: validateInteger(input.startAt, "startAt", 0, 10_000, 0),
        maxResults: validateInteger(input.maxResults, "maxResults", 1, maximum, 25),
      };
    }
    case "jira.fields.list": {
      const input = ownKeys(value, new Set(["query", "limit"]), "Input");
      const output = { limit: validateInteger(input.limit, "limit", 1, MAX_FIELD_RESULTS, 100) };
      if (Object.hasOwn(input, "query")) {
        output.query = validateVisibleString(input.query, "query", 1, 128);
      }
      return output;
    }
    case "jira.issues.create_metadata": {
      const input = ownKeys(value, new Set(["projectKey", "issueTypeId"]), "Input");
      return {
        projectKey: validatePattern(input.projectKey, projectKeyPattern, "projectKey", (text) =>
          text.toUpperCase(),
        ),
        issueTypeId: optional(input, "issueTypeId", (item) =>
          validatePattern(item, numericIdPattern, "issueTypeId"),
        ),
      };
    }
    case "jira.users.assignable": {
      const input = ownKeys(value, new Set(["issueKey", "projectKey", "query", "maxResults"]), "Input");
      const issueKey = optional(input, "issueKey", validateIssueKey);
      const projectKey = optional(input, "projectKey", (item) =>
        validatePattern(item, projectKeyPattern, "projectKey", (text) => text.toUpperCase()),
      );
      if ((issueKey === undefined) === (projectKey === undefined)) {
        throw failure("invalid_input", "Provide exactly one of issueKey or projectKey.");
      }
      return {
        issueKey,
        projectKey,
        query: validateVisibleString(input.query, "query", 1, 128),
        maxResults: validateInteger(input.maxResults, "maxResults", 1, MAX_USER_RESULTS, 10),
      };
    }
    case "jira.changes.prepare_create_issue": {
      const input = ownKeys(
        value,
        new Set([
          "projectKey",
          "issueTypeId",
          "parentKey",
          "assignee",
          "afterUnconfirmedOperationId",
          ...FIELD_INPUT_KEYS,
        ]),
        "Input",
      );
      return {
        projectKey: validatePattern(input.projectKey, projectKeyPattern, "projectKey", (text) =>
          text.toUpperCase(),
        ),
        issueTypeId: validatePattern(input.issueTypeId, numericIdPattern, "issueTypeId"),
        parentKey: optional(input, "parentKey", (item) => validateIssueKey(item, "parentKey")),
        assignee: optional(input, "assignee", (item) =>
          validatePattern(item, usernamePattern, "assignee"),
        ),
        afterUnconfirmedOperationId: validateUnconfirmedReference(input),
        changes: validateFieldChanges(input, { creating: true }),
      };
    }
    case "jira.changes.prepare_update_issue": {
      const input = ownKeys(value, new Set(["issueKey", ...FIELD_INPUT_KEYS]), "Input");
      return {
        issueKey: validateIssueKey(input.issueKey),
        changes: validateFieldChanges(input, { creating: false }),
      };
    }
    case "jira.changes.prepare_transition": {
      const input = ownKeys(
        value,
        new Set(["issueKey", "transitionId", "resolution", "comment"]),
        "Input",
      );
      return {
        issueKey: validateIssueKey(input.issueKey),
        transitionId: validatePattern(input.transitionId, numericIdPattern, "transitionId"),
        resolution: optional(input, "resolution", (item) =>
          validateVisibleString(item, "resolution", 1, 255),
        ),
        comment: optional(input, "comment", (item) => validateText(item, "comment")),
      };
    }
    case "jira.changes.prepare_assign": {
      const input = ownKeys(value, new Set(["issueKey", "assignee"]), "Input");
      if (!Object.hasOwn(input, "assignee")) {
        throw failure("invalid_input", "assignee is required; use null to unassign.");
      }
      return {
        issueKey: validateIssueKey(input.issueKey),
        assignee:
          input.assignee === null ? null : validatePattern(input.assignee, usernamePattern, "assignee"),
      };
    }
    case "jira.changes.prepare_add_comment": {
      const input = ownKeys(
        value,
        new Set(["issueKey", "body", "visibility", "afterUnconfirmedOperationId"]),
        "Input",
      );
      return {
        issueKey: validateIssueKey(input.issueKey),
        body: validateText(input.body, "body"),
        visibility: optional(input, "visibility", (item) => {
          const visibility = ownKeys(item, new Set(["type", "value"]), "visibility");
          if (visibility.type !== "role" && visibility.type !== "group") {
            throw failure("invalid_input", "visibility.type must be role or group.");
          }
          return {
            type: visibility.type,
            value: validateVisibleString(visibility.value, "visibility.value", 1, 255),
          };
        }),
        afterUnconfirmedOperationId: validateUnconfirmedReference(input),
      };
    }
    case "jira.changes.prepare_update_comment": {
      const input = ownKeys(value, new Set(["issueKey", "commentId", "body"]), "Input");
      return {
        issueKey: validateIssueKey(input.issueKey),
        commentId: validatePattern(input.commentId, numericIdPattern, "commentId"),
        body: validateText(input.body, "body"),
      };
    }
    case "jira.changes.prepare_add_worklog": {
      const input = ownKeys(
        value,
        new Set(["issueKey", "timeSpent", "started", "comment", "afterUnconfirmedOperationId"]),
        "Input",
      );
      return {
        issueKey: validateIssueKey(input.issueKey),
        timeSpent: validatePattern(input.timeSpent, timeSpentPattern, "timeSpent"),
        started: optional(input, "started", (item) =>
          validatePattern(item, startedPattern, "started"),
        ),
        comment: optional(input, "comment", (item) => validateText(item, "comment")),
        afterUnconfirmedOperationId: validateUnconfirmedReference(input),
      };
    }
    case "jira.changes.prepare_link_issues": {
      const input = ownKeys(
        value,
        new Set(["linkType", "inwardIssueKey", "outwardIssueKey", "afterUnconfirmedOperationId"]),
        "Input",
      );
      const inwardIssueKey = validateIssueKey(input.inwardIssueKey, "inwardIssueKey");
      const outwardIssueKey = validateIssueKey(input.outwardIssueKey, "outwardIssueKey");
      if (inwardIssueKey === outwardIssueKey) {
        throw failure("invalid_input", "An issue cannot be linked to itself.");
      }
      return {
        linkType: validateVisibleString(input.linkType, "linkType", 1, 255),
        inwardIssueKey,
        outwardIssueKey,
        afterUnconfirmedOperationId: validateUnconfirmedReference(input),
      };
    }
    case "jira.changes.apply": {
      const input = ownKeys(value, new Set(["planId", "previewHash", "summary"]), "Input");
      return {
        planId: validatePattern(
          input.planId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
          "planId",
        ),
        previewHash: validatePattern(input.previewHash, /^[0-9a-f]{64}$/u, "previewHash"),
        summary: validateVisibleString(input.summary, "summary", 1, 600),
      };
    }
    default:
      throw failure("tool_not_found", "The requested tool is not provided by this plugin.");
  }
}

const TOOL_CAPABILITY = new Map([
  ["jira.me.get", READ],
  ["jira.projects.list", READ],
  ["jira.issues.search", READ],
  ["jira.issues.get", READ],
  ["jira.comments.list", READ],
  ["jira.fields.list", READ],
  ["jira.transitions.list", READ],
  ["jira.issues.create_metadata", READ],
  ["jira.issues.edit_metadata", READ],
  ["jira.users.assignable", READ],
  ["jira.issue_link_types.list", READ],
  ["jira.worklogs.list", READ],
  ["jira.changes.prepare_create_issue", WRITE],
  ["jira.changes.prepare_update_issue", WRITE],
  ["jira.changes.prepare_transition", WRITE],
  ["jira.changes.prepare_assign", WRITE],
  ["jira.changes.prepare_add_comment", WRITE],
  ["jira.changes.prepare_update_comment", WRITE],
  ["jira.changes.prepare_add_worklog", WRITE],
  ["jira.changes.prepare_link_issues", WRITE],
  ["jira.changes.apply", WRITE],
]);

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

async function boundedBody(response, limit = MAX_RESPONSE_BYTES) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw failure("response_too_large", "The response exceeded the byte limit.");
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
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw failure("response_too_large", "The response exceeded the byte limit.");
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

function timeoutSignal(parent, label) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(failure("request_timeout", `${label} request timed out.`, true)),
    REQUEST_TIMEOUT_MS,
  );
  timeout.unref?.();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

// Sends one fixed Jira REST request. Transport failures throw; HTTP statuses are returned so
// write callers can classify a settled rejection separately from an unknown outcome.
async function jiraSend(fetchImplementation, accessToken, path, { method = "GET", query, body, signal }) {
  signal.throwIfAborted();
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("..")) {
    throw failure("invalid_request", "The Jira REST path is invalid.");
  }
  const url = new URL(`${API_ROOT}${path}`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key) || typeof value !== "string") {
        throw failure("invalid_request", "The Jira query is invalid.");
      }
      url.searchParams.set(key, value);
    }
  }
  const headers = { accept: "application/json", authorization: `Bearer ${accessToken}` };
  let encodedBody;
  if (body !== undefined) {
    encodedBody = JSON.stringify(body);
    if (encoder.encode(encodedBody).byteLength > MAX_REQUEST_BYTES) {
      throw failure("request_too_large", "Jira request exceeded the byte limit.");
    }
    headers["content-type"] = "application/json";
  }
  const composed = timeoutSignal(signal, "UCSD Jira");
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
      throw failure("network_error", "The UCSD Jira request failed before a response was received.", true);
    }
    if (!(response instanceof Response)) {
      throw failure("invalid_response", "Jira returned an invalid HTTP response.");
    }
    if (response.url && response.url !== url.href) {
      throw failure("redirect_rejected", "Jira response origin or endpoint changed unexpectedly.");
    }
    let value = null;
    try {
      const bytes = await boundedBody(response);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (bytes.byteLength > 0 && contentType === "application/json") {
        value = validateJsonTree(JSON.parse(decoder.decode(bytes)));
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (composed.signal.aborted) {
        throw failure("request_timeout", "UCSD Jira request timed out.", true);
      }
      if (error?._tag === "PluginFailure") throw error;
      if (response.ok) throw failure("invalid_response", "Jira returned malformed UTF-8 JSON.");
    }
    return { status: response.status, ok: response.ok, response, value };
  } finally {
    composed.cleanup();
  }
}

function readFailure(result) {
  const { status, response } = result;
  if (status === 401) {
    return failure(
      "authentication_failed",
      "UCSD Jira rejected the sign-in. Try again; if this continues, disconnect and connect UCSD Jira again.",
      true,
    );
  }
  if (status === 403) {
    return failure("permission_denied", "The connected Jira user is not permitted to do this.");
  }
  if (status === 404) {
    return failure(
      "not_found",
      "Jira did not find the requested resource, or the connected user cannot view it.",
    );
  }
  if (status === 429) {
    const seconds = retryAfter(response);
    return failure(
      "rate_limited",
      "UCSD Jira rate limited the request; no automatic retry was attempted.",
      true,
      seconds === undefined ? {} : { retryAfterSeconds: seconds },
    );
  }
  if (status === 400) {
    return failure("jira_rejected", "Jira rejected the request.", false, jiraMessages(result.value));
  }
  return failure("http_error", `UCSD Jira returned HTTP ${status}.`, status >= 500, { status });
}

// Jira's own validation messages, bounded. They name fields and reasons, not credentials.
function jiraMessages(value) {
  const messages = [];
  if (isPlainObject(value)) {
    if (Array.isArray(value.errorMessages)) {
      for (const message of value.errorMessages.slice(0, 10)) {
        if (typeof message === "string") messages.push(message.slice(0, 300));
      }
    }
    if (isPlainObject(value.errors)) {
      for (const [field, message] of Object.entries(value.errors).slice(0, 10)) {
        if (typeof message === "string") messages.push(`${field.slice(0, 100)}: ${message.slice(0, 300)}`);
      }
    }
  }
  return { jiraMessages: messages };
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

// Approval prompts show one line; summaries collapse whitespace so multi-line text stays legible
// and remains a valid apply argument.
function oneLine(value) {
  return String(value).replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim();
}

function quoted(value, maximum = 200) {
  const text = oneLine(value);
  return text.length > maximum
    ? `"${text.slice(0, maximum)}…" (${value.length} characters)`
    : `"${text}"`;
}

// Puts the values being written into the approval summary, not only field names, so a
// harmless-looking prompt cannot hide what the change contains.
function describeValues(readable, budget = 360) {
  const parts = [];
  const entries = Object.entries(readable).filter(([, value]) => value !== undefined);
  let used = 0;
  for (const [index, [field, value]] of entries.entries()) {
    const shown =
      value === null
        ? "(cleared)"
        : typeof value === "string"
          ? quoted(value, 120)
          : oneLine(JSON.stringify(value)).slice(0, 120);
    const part = `${field}: ${shown}`;
    if (used + part.length > budget && parts.length > 0) {
      parts.push(`+${entries.length - index} more fields (see preview)`);
      break;
    }
    parts.push(part);
    used += part.length + 2;
  }
  return parts.join("; ");
}

function clip(value, maximum = MAX_PREVIEW_TEXT_CHARS) {
  if (value === null || value === undefined) return null;
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
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
  if (!isPlainObject(value)) {
    throw failure("invalid_response", "Jira returned an invalid user profile.");
  }
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
  const description = optionalText(fields.description, "issue description", MAX_STRING_CHARS);
  output.description = description?.slice(0, MAX_DESCRIPTION_CHARS) ?? null;
  output.descriptionTruncated = description !== null && description.length > MAX_DESCRIPTION_CHARS;
  output.dueDate = optionalString(fields.duedate, "issue due date", 128);
  output.parentKey =
    isPlainObject(fields.parent) && typeof fields.parent.key === "string"
      ? requiredString(fields.parent.key, "parent key", 128)
      : null;
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

function projectVisibility(value) {
  if (!isPlainObject(value)) {
    throw failure("invalid_response", "Jira returned invalid comment visibility.");
  }
  return {
    type: optionalString(value.type, "comment visibility type", 128),
    value: optionalString(value.value, "comment visibility value", 512),
  };
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

function projectWorklog(value) {
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned an invalid worklog.");
  const comment = optionalText(value.comment, "worklog comment", MAX_STRING_CHARS);
  return {
    id: requiredString(value.id, "worklog id", 128),
    author: projectUser(value.author, "worklog author"),
    timeSpent: optionalString(value.timeSpent, "worklog time spent", 128),
    timeSpentSeconds: Number.isSafeInteger(value.timeSpentSeconds) ? value.timeSpentSeconds : null,
    started: optionalString(value.started, "worklog start", 128),
    comment: clip(comment, 4_000),
  };
}

function projectSchema(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned an invalid field schema.");
  return {
    type: optionalString(value.type, "field schema type", 128),
    items: optionalString(value.items, "field schema items", 128),
    system: optionalString(value.system, "field schema system", 256),
    custom: optionalString(value.custom, "field schema custom type", 512),
    customId:
      Number.isSafeInteger(value.customId) && value.customId >= 0 ? value.customId : null,
  };
}

function projectField(value) {
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned an invalid field.");
  return {
    id: requiredString(value.id, "field id", 256),
    name: requiredString(value.name, "field name", 512),
    custom: typeof value.custom === "boolean" ? value.custom : null,
    orderable: typeof value.orderable === "boolean" ? value.orderable : null,
    navigable: typeof value.navigable === "boolean" ? value.navigable : null,
    searchable: typeof value.searchable === "boolean" ? value.searchable : null,
    schema: projectSchema(value.schema),
  };
}

function projectAllowedValue(value) {
  if (!isPlainObject(value)) return null;
  const label = value.name ?? value.value ?? value.key ?? null;
  return {
    id: optionalString(value.id, "allowed value id", 128),
    name: typeof label === "string" ? label.slice(0, 512) : null,
  };
}

function projectMetaField(fieldId, value) {
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned invalid field metadata.");
  const allowed = Array.isArray(value.allowedValues) ? value.allowedValues : null;
  return {
    fieldId: requiredString(fieldId, "field id", 256),
    name: requiredString(value.name, "field name", 512),
    required: value.required === true,
    hasDefaultValue: value.hasDefaultValue === true,
    schema: projectSchema(value.schema),
    allowedValues:
      allowed === null
        ? null
        : allowed.slice(0, MAX_ALLOWED_VALUES).map(projectAllowedValue).filter(Boolean),
    allowedValuesTruncated: allowed !== null && allowed.length > MAX_ALLOWED_VALUES,
  };
}

function projectTransition(value) {
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned an invalid transition.");
  const fields = isPlainObject(value.fields) ? value.fields : {};
  return {
    id: requiredString(value.id, "transition id", 128),
    name: requiredString(value.name, "transition name", 512),
    to: projectNamed(value.to, "transition target status"),
    fields: Object.entries(fields)
      .slice(0, MAX_META_FIELDS)
      .map(([fieldId, field]) => projectMetaField(fieldId, field)),
  };
}

function projectLinkType(value) {
  if (!isPlainObject(value)) throw failure("invalid_response", "Jira returned an invalid link type.");
  return {
    id: requiredString(value.id, "link type id", 128),
    name: requiredString(value.name, "link type name", 512),
    inward: requiredString(value.inward, "link type inward description", 512),
    outward: requiredString(value.outward, "link type outward description", 512),
  };
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function parseCredential(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 16_000) return undefined;
  try {
    const parsed = JSON.parse(value);
    ownKeys(
      parsed,
      new Set(["version", "refreshToken", "scope", "capabilities", "account", "updatedAt"]),
      "Stored credential",
    );
    const account = ownKeys(parsed.account, new Set(["key", "name", "displayName"]), "Account");
    if (
      parsed.version !== 2 ||
      typeof parsed.refreshToken !== "string" ||
      parsed.refreshToken.length === 0 ||
      parsed.refreshToken.length > MAX_TOKEN_CHARS ||
      (parsed.scope !== "READ" && parsed.scope !== "WRITE") ||
      canonical(parsed.capabilities) !==
        canonical(parsed.scope === "WRITE" ? [READ, WRITE] : [READ]) ||
      typeof account.key !== "string" ||
      account.key.length === 0 ||
      typeof parsed.updatedAt !== "string"
    ) {
      return undefined;
    }
    return {
      version: 2,
      refreshToken: parsed.refreshToken,
      scope: parsed.scope,
      capabilities: [...parsed.capabilities],
      account: {
        key: account.key,
        name: typeof account.name === "string" ? account.name : null,
        displayName: typeof account.displayName === "string" ? account.displayName : null,
      },
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function requestedCapabilities(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => item !== READ && item !== WRITE) ||
    new Set(value).size !== value.length
  ) {
    throw failure(
      "invalid_capabilities",
      "The connection may request only jira-data-center.read and jira-data-center.write.",
    );
  }
  // Writes depend on reading current state, so a write grant always includes read.
  return value.includes(WRITE) ? { scope: "WRITE", capabilities: [READ, WRITE] } : { scope: "READ", capabilities: [READ] };
}

function grantedFromScope(requested, scope) {
  if (typeof scope !== "string" || scope.trim() === "") return requested;
  const scopes = new Set(scope.toUpperCase().split(/[\s,]+/u));
  if (requested.scope === "WRITE" && scopes.has("WRITE")) return requested;
  if (scopes.has("READ") || scopes.has("WRITE")) return { scope: "READ", capabilities: [READ] };
  return null;
}

function callbackPage(response, status, message) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>TritonAI Harness</title></head><body><main><h1>${message}</h1><p>You can close this window and return to TritonAI Harness.</p></main></body></html>`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    connection: "close",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function createIntegrationProvider(context) {
  const factory = ownKeys(context, new Set(["secrets", "configuration"]), "Factory context");
  if (
    !isPlainObject(factory.secrets) ||
    !["get", "set", "remove"].every((name) => typeof factory.secrets[name] === "function")
  ) {
    throw failure("invalid_context", "The package-scoped secret store is invalid.");
  }
  const { brokerUrl, clientId } = validateConfiguration(factory.configuration);
  const fetchImplementation = globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw failure("invalid_runtime", "The Node fetch API is unavailable.");
  }
  const secrets = factory.secrets;
  const lifetime = new AbortController();
  const flows = new Map();
  const plans = new Map();
  // Appending writes whose outcome is unknown, keyed by payload digest, so the same comment,
  // worklog, link, or issue is not blindly created twice.
  const unconfirmed = new Map();
  let closed = false;
  let generation = 0;
  let access = null;
  // A rotated credential that could not be saved yet. Jira has already invalidated the stored
  // refresh token, so this copy is the only usable one until a later save succeeds.
  let unsaved = null;
  let signInExpired = false;
  let refreshMessage = null;
  // Unconfirmed appends stay remembered across a reconnect by the same Jira account.
  let connectedAccountKey = null;
  let queue = Promise.resolve();

  function ensureOpen() {
    if (closed) throw failure("provider_closed", "The Jira provider is closed.");
  }

  function serialized(operation) {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readStored() {
    let value;
    try {
      value = await secrets.get(SECRET_NAME);
    } catch {
      throw failure("secret_store_error", "The package-scoped credential store could not be read.");
    }
    const credential = parseCredential(value);
    if (credential === undefined) {
      throw failure("credential_corrupt", "The stored Jira credential is invalid. Disconnect and connect again.");
    }
    return credential;
  }

  async function currentCredential() {
    return unsaved ?? (await readStored());
  }

  async function writeCredential(credential) {
    const serializedCredential = JSON.stringify(credential);
    try {
      await secrets.set(SECRET_NAME, serializedCredential);
    } catch {
      let recovered;
      try {
        recovered = await secrets.get(SECRET_NAME);
      } catch {
        throw unknownCommit("The Jira credential save could not be confirmed.");
      }
      if (recovered !== serializedCredential) {
        throw failure("secret_store_error", "The Jira credential could not be saved.");
      }
    }
  }

  // One request to the TritonAI relay, which adds the confidential client credentials.
  async function brokerToken(body, signal) {
    const composed = timeoutSignal(signal, "TritonAI Jira sign-in");
    try {
      let response;
      try {
        response = await fetchImplementation(`${brokerUrl}/v1/token`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: composed.signal,
        });
      } catch {
        return { kind: "unconfirmed" };
      }
      let value;
      try {
        value = JSON.parse(decoder.decode(await boundedBody(response, 64 * 1024)));
      } catch {
        value = null;
      }
      if (response.status === 200) {
        if (
          !isPlainObject(value) ||
          typeof value.access_token !== "string" ||
          value.access_token.length === 0 ||
          value.access_token.length > MAX_TOKEN_CHARS ||
          typeof value.refresh_token !== "string" ||
          value.refresh_token.length === 0 ||
          value.refresh_token.length > MAX_TOKEN_CHARS ||
          !Number.isSafeInteger(value.expires_in) ||
          value.expires_in < 1
        ) {
          return { kind: "unconfirmed" };
        }
        return {
          kind: "ok",
          accessToken: value.access_token,
          refreshToken: value.refresh_token,
          expiresAt: Date.now() + Math.min(value.expires_in, 86_400) * 1_000,
          scope: typeof value.scope === "string" ? value.scope : null,
        };
      }
      if (response.status === 400) {
        return { kind: "rejected", error: isPlainObject(value) && typeof value.error === "string" ? value.error : "invalid_grant" };
      }
      // A throttled request never reached Jira's token endpoint, so nothing rotated.
      if (response.status === 429) return { kind: "rate_limited" };
      return { kind: "unconfirmed" };
    } finally {
      composed.cleanup();
    }
  }

  // A 401 from an older token must not discard one a concurrent refresh just obtained.
  function forgetAccess(token) {
    if (access?.token === token) access = null;
  }

  function rememberUnconfirmed(plan, operationId) {
    if (!plan.appends) return;
    unconfirmed.set(plan.payloadDigest, { operationId, at: Date.now() });
    while (unconfirmed.size > MAX_UNCONFIRMED) unconfirmed.delete(unconfirmed.keys().next().value);
  }

  async function readJson(accessToken, path, options) {
    const result = await jiraSend(fetchImplementation, accessToken, path, options);
    if (!result.ok) {
      if (result.status === 401) forgetAccess(accessToken);
      throw readFailure(result);
    }
    if (result.value === null) {
      throw failure("invalid_response", "Jira returned an unexpected response content type.");
    }
    return result.value;
  }

  async function fetchAccount(accessToken, signal) {
    const user = projectCurrentUser(await readJson(accessToken, "/myself", { signal }));
    if (user.key === null) throw failure("invalid_response", "Jira returned a user without a key.");
    return { key: user.key, name: user.name, displayName: user.displayName };
  }

  function clearPlans() {
    plans.clear();
  }

  async function closeFlow(flow) {
    if (flows.get(flow.flowId) === flow) flows.delete(flow.flowId);
    clearTimeout(flow.timer);
    flow.controller.abort();
    await new Promise((resolve) => {
      flow.server.close(() => resolve());
      flow.server.closeAllConnections?.();
    });
  }

  async function closeAllFlows() {
    await Promise.all([...flows.values()].map(closeFlow));
  }

  async function exchangeCode(flow, code) {
    const signal = flow.controller.signal;
    try {
      const tokens = await brokerToken(
        { grant_type: "authorization_code", code, code_verifier: flow.verifier },
        signal,
      );
      if (tokens.kind !== "ok") {
        flow.result = {
          kind: "failed",
          message:
            tokens.kind === "rejected"
              ? "UCSD Jira did not accept this sign-in. Connect again."
              : "The Jira sign-in could not be completed. Check your connection and connect again.",
        };
        return;
      }
      const granted = grantedFromScope(flow.requested, tokens.scope);
      if (granted === null) {
        flow.result = { kind: "failed", message: "UCSD Jira did not grant the requested access." };
        return;
      }
      const account = await fetchAccount(tokens.accessToken, signal);
      flow.result = { kind: "tokens", tokens, granted, account };
    } catch {
      if (!signal.aborted) {
        flow.result = {
          kind: "failed",
          message: "The Jira sign-in could not be completed. Connect again.",
        };
      }
    }
  }

  function handleCallback(flow, request, response) {
    const invalid = "This UCSD Jira sign-in callback is not valid.";
    const address = flow.server.address();
    const expectedHost = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
    const remote = request.socket.remoteAddress;
    if (
      request.method !== "GET" ||
      request.headers.host !== expectedHost ||
      (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") ||
      flow.expiresAt <= Date.now() ||
      flows.get(flow.flowId) !== flow ||
      closed
    ) {
      callbackPage(response, 400, invalid);
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? "", `http://${expectedHost}`);
    } catch {
      callbackPage(response, 400, invalid);
      return;
    }
    const keys = [...url.searchParams.keys()];
    if (
      url.pathname !== LOOPBACK_CALLBACK_PATH ||
      keys.some((key) => key !== "state" && key !== "code" && key !== "error") ||
      new Set(keys).size !== keys.length ||
      !textEqual(url.searchParams.get("state") ?? "", flow.state) ||
      flow.callbackReceived
    ) {
      callbackPage(response, 400, invalid);
      return;
    }
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if ((code === null) === (oauthError === null) || (code !== null && (code.length === 0 || code.length > 2_048))) {
      callbackPage(response, 400, invalid);
      return;
    }
    flow.callbackReceived = true;
    if (code === null) {
      flow.result = {
        kind: "failed",
        message:
          oauthError === "access_denied"
            ? "Jira access was not allowed. Connect again to retry."
            : "UCSD Jira did not complete the sign-in. Connect again.",
      };
      callbackPage(response, 200, "UCSD Jira sign-in was not completed.");
    } else {
      // Jira authorization codes expire within seconds, so redeem before answering the browser.
      flow.exchange = exchangeCode(flow, code);
      callbackPage(response, 200, "UCSD Jira sign-in received.");
    }
    response.once("finish", () => {
      flow.server.close();
    });
  }

  async function startFlow(requested, signal) {
    let flow = null;
    const server = NodeHttp.createServer((request, response) => {
      if (!flow) {
        callbackPage(response, 503, "This UCSD Jira sign-in is not ready.");
        return;
      }
      handleCallback(flow, request, response);
    });
    server.maxHeadersCount = 32;
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 1;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.port < 1024) {
      await new Promise((resolve) => server.close(() => resolve()));
      throw failure("loopback_unavailable", "The local Jira sign-in listener could not start.");
    }
    const verifier = base64url(randomBytes(32));
    flow = {
      flowId: randomUUID(),
      server,
      requested,
      verifier,
      challenge: base64url(createHash("sha256").update(verifier).digest()),
      state: `${address.port}.${base64url(randomBytes(32))}`,
      expiresAt: Date.now() + FLOW_LIFETIME_MS,
      controller: new AbortController(),
      callbackReceived: false,
      exchange: null,
      result: null,
      timer: null,
    };
    lifetime.signal.addEventListener("abort", () => flow.controller.abort(), { once: true });
    flow.timer = setTimeout(() => void closeFlow(flow), FLOW_LIFETIME_MS + 30_000);
    flow.timer.unref?.();
    if (signal.aborted || closed) {
      await closeFlow(flow);
      throw failure("cancelled", "The Jira sign-in was cancelled.");
    }
    flows.set(flow.flowId, flow);
    return flow;
  }

  function requireAccess(capability) {
    if (signInExpired) {
      throw failure("connection_required", "Your UCSD Jira sign-in expired or was revoked. Connect UCSD Jira again.");
    }
    if (!access || access.expiresAt - ACCESS_SKEW_MS <= Date.now()) {
      throw failure(
        "authorization_unavailable",
        refreshMessage ?? "UCSD Jira access is not ready. Try again in a moment.",
        true,
      );
    }
    if (!access.capabilities.includes(capability)) {
      throw failure("capability_required", "Connect UCSD Jira again and allow changes to use this tool.");
    }
    return access;
  }

  function prunePlans() {
    const now = Date.now();
    for (const [id, plan] of plans) if (plan.expiresAt <= now) plans.delete(id);
    for (const [key, record] of unconfirmed) {
      if (record.at + UNCONFIRMED_MEMORY_MS <= now) unconfirmed.delete(key);
    }
  }

  function guardDuplicate(payloadDigest, acknowledged) {
    const record = unconfirmed.get(payloadDigest);
    if (record && record.operationId !== acknowledged) {
      throw failure(
        "unconfirmed_duplicate",
        "An identical change was sent earlier but Jira did not confirm it. Check whether it already exists before creating it again; if it does not, prepare again with afterUnconfirmedOperationId set to the earlier operationId.",
        false,
        { operationId: record.operationId, sentAt: new Date(record.at).toISOString() },
      );
    }
  }

  function storePlan(current, plan) {
    prunePlans();
    if (current.generation !== generation) {
      throw failure("preview_required", "UCSD Jira was reconnected while this change was prepared. Prepare it again.");
    }
    if (plan.request.body !== undefined && encoder.encode(JSON.stringify(plan.request.body)).byteLength > MAX_REQUEST_BYTES) {
      throw failure("request_too_large", "This change is too large to send to Jira in one request. Shorten the text.");
    }
    // Abandoned previews must not block new ones; the oldest is dropped.
    while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value);
    const planId = randomUUID();
    plan = { ...plan, summary: clip(oneLine(plan.summary), 590) };
    const preview = { operation: plan.operation, summary: plan.summary, ...plan.preview };
    const previewHash = digest(canonical(preview));
    const expiresAt = Date.now() + PLAN_LIFETIME_MS;
    plans.set(planId, {
      ...plan,
      previewHash,
      expiresAt,
      generation: current.generation,
      accountKey: current.accountKey,
    });
    return {
      status: "preview",
      planId,
      previewHash,
      summary: plan.summary,
      expiresAt: new Date(expiresAt).toISOString(),
      preview,
      next: "No Jira change has occurred. Show the user this summary and preview. If they want it, call jira.changes.apply with this planId, previewHash, and the exact summary; Harness asks for approval before the change is sent.",
    };
  }

  async function getIssue(current, issueKey, fields, signal) {
    return readJson(current.token, `/issue/${encodeURIComponent(issueKey)}`, {
      query: { fields: fields.join(",") },
      signal,
    });
  }

  function issueFingerprint(issue) {
    const fields = isPlainObject(issue?.fields) ? issue.fields : {};
    return digest(
      canonical({
        key: typeof issue?.key === "string" ? issue.key : null,
        updated: typeof fields.updated === "string" ? fields.updated : null,
        status: isPlainObject(fields.status) && typeof fields.status.id === "string" ? fields.status.id : null,
      }),
    );
  }

  function commentFingerprint(comment) {
    return digest(canonical({ updated: comment.updated, body: comment.body, visibility: comment.visibility }));
  }

  function resolveAllowed(meta, wanted, label) {
    const options = meta?.allowedValues ?? null;
    if (options === null) return { name: wanted };
    const match =
      options.find((option) => option.id === wanted) ??
      options.find((option) => option.name === wanted) ??
      options.find((option) => option.name?.toLocaleLowerCase("en-US") === wanted.toLocaleLowerCase("en-US"));
    // Beyond the bounded list Jira validates the name itself when the change is sent.
    if (!match?.id && meta.allowedValuesTruncated) return { name: wanted };
    if (!match?.id) {
      throw failure("invalid_input", `${label} "${wanted}" is not an allowed value here.`, false, {
        allowedValues: options.slice(0, 50).map((option) => option.name),
      });
    }
    return { id: match.id, name: match.name };
  }

  // Maps typed changes to Jira's `fields` payload, checked against create or edit metadata so
  // a field the connected user cannot set is refused before approval is requested.
  function buildFields(changes, metaById, { creating }) {
    const fields = {};
    const readable = {};
    const unavailable = [];
    const meta = (fieldId) => {
      const entry = metaById.get(fieldId);
      if (!entry) unavailable.push(fieldId);
      return entry;
    };
    if (changes.summary !== undefined) {
      if (!creating) meta("summary");
      fields.summary = changes.summary;
      readable.summary = changes.summary;
    }
    if (changes.description !== undefined) {
      meta("description");
      fields.description = changes.description;
      readable.description = clip(changes.description);
    }
    if (changes.priority !== undefined) {
      const entry = meta("priority");
      const resolved = resolveAllowed(entry, changes.priority, "priority");
      fields.priority = resolved.id ? { id: resolved.id } : { name: resolved.name };
      readable.priority = resolved.name;
    }
    if (changes.labels !== undefined) {
      meta("labels");
      fields.labels = changes.labels;
      readable.labels = changes.labels;
    }
    if (changes.components !== undefined) {
      const entry = meta("components");
      const resolved = changes.components.map((name) => resolveAllowed(entry, name, "component"));
      fields.components = resolved.map((item) => (item.id ? { id: item.id } : { name: item.name }));
      readable.components = resolved.map((item) => item.name);
    }
    if (changes.dueDate !== undefined) {
      meta("duedate");
      fields.duedate = changes.dueDate;
      readable.dueDate = changes.dueDate;
    }
    for (const [fieldId, value] of Object.entries(changes.customFields ?? {})) {
      const entry = meta(fieldId);
      fields[fieldId] = value;
      readable[entry?.name ? `${entry.name} (${fieldId})` : fieldId] = value;
    }
    if (unavailable.length > 0) {
      throw failure(
        "field_not_settable",
        `The connected user cannot set ${unavailable.join(", ")} here. Use the metadata tools to see settable fields.`,
      );
    }
    return { fields, readable };
  }

  async function createMetaFields(current, projectKey, issueTypeId, signal) {
    const byId = new Map();
    let startAt = 0;
    for (let page = 0; page < 5; page += 1) {
      const value = await readJson(
        current.token,
        `/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`,
        { query: { startAt: String(startAt), maxResults: "100" }, signal },
      );
      if (!isPlainObject(value) || !Array.isArray(value.values)) {
        throw failure("invalid_response", "Jira returned invalid create metadata.");
      }
      for (const field of value.values) {
        if (!isPlainObject(field)) continue;
        const projected = projectMetaField(field.fieldId, field);
        byId.set(projected.fieldId, projected);
      }
      startAt += value.values.length;
      if (value.isLast !== false || value.values.length === 0) break;
    }
    return byId;
  }

  async function editMetaFields(current, issueKey, signal) {
    const value = await readJson(current.token, `/issue/${encodeURIComponent(issueKey)}/editmeta`, {
      signal,
    });
    if (!isPlainObject(value) || !isPlainObject(value.fields)) {
      throw failure("invalid_response", "Jira returned invalid edit metadata.");
    }
    return new Map(
      Object.entries(value.fields)
        .slice(0, 1_000)
        .map(([fieldId, field]) => [fieldId, projectMetaField(fieldId, field)]),
    );
  }

  async function prepareChange(toolName, parsed, current, signal) {
    switch (toolName) {
      case "jira.changes.prepare_create_issue": {
        const types = await readJson(
          current.token,
          `/issue/createmeta/${encodeURIComponent(parsed.projectKey)}/issuetypes`,
          { query: { maxResults: "100" }, signal },
        );
        const issueType = Array.isArray(types?.values)
          ? types.values.find((type) => isPlainObject(type) && type.id === parsed.issueTypeId)
          : undefined;
        if (!issueType) {
          throw failure("invalid_input", "That issue type cannot be created in this project by the connected user.");
        }
        const metaById = await createMetaFields(current, parsed.projectKey, parsed.issueTypeId, signal);
        const { fields, readable } = buildFields(parsed.changes, metaById, { creating: true });
        fields.project = { key: parsed.projectKey };
        fields.issuetype = { id: parsed.issueTypeId };
        if (parsed.parentKey !== undefined) {
          if (issueType.subtask !== true) {
            throw failure("invalid_input", "parentKey is only valid for a sub-task issue type.");
          }
          fields.parent = { key: parsed.parentKey };
        } else if (issueType.subtask === true) {
          throw failure("invalid_input", "A sub-task issue type requires parentKey.");
        }
        if (parsed.assignee !== undefined) {
          if (!metaById.has("assignee")) {
            throw failure("field_not_settable", "The connected user cannot set the assignee here.");
          }
          fields.assignee = { name: parsed.assignee };
        }
        const handled = new Set(["summary", "project", "issuetype", "parent", "reporter", ...Object.keys(fields)]);
        const missing = [...metaById.values()]
          .filter((field) => field.required && !field.hasDefaultValue && !handled.has(field.fieldId))
          .map((field) => `${field.name} (${field.fieldId})`);
        if (missing.length > 0) {
          throw failure("missing_required_fields", `Jira requires these fields: ${missing.join(", ")}.`);
        }
        const body = { fields };
        const payloadDigest = digest(canonical({ operation: "create_issue", body }));
        guardDuplicate(payloadDigest, parsed.afterUnconfirmedOperationId);
        const typeName = typeof issueType.name === "string" ? issueType.name : parsed.issueTypeId;
        return storePlan(current, {
          operation: "create_issue",
          summary: `Create ${typeName} in ${parsed.projectKey}: ${describeValues({
            ...readable,
            ...(parsed.parentKey === undefined ? {} : { parent: parsed.parentKey }),
            ...(parsed.assignee === undefined ? {} : { assignee: parsed.assignee }),
          })}`,
          preview: {
            project: parsed.projectKey,
            issueType: typeName,
            parentKey: parsed.parentKey ?? null,
            assignee: parsed.assignee ?? null,
            fields: readable,
          },
          request: { method: "POST", path: "/issue", body },
          payloadDigest,
          appends: true,
          acknowledgedOperationId: parsed.afterUnconfirmedOperationId ?? null,
        });
      }
      case "jira.changes.prepare_update_issue": {
        const fieldIds = ["summary", "updated", "status", ...Object.values(STANDARD_WRITE_FIELDS), ...Object.keys(parsed.changes.customFields ?? {})];
        const issue = await getIssue(current, parsed.issueKey, [...new Set(fieldIds)], signal);
        const metaById = await editMetaFields(current, parsed.issueKey, signal);
        const { fields, readable } = buildFields(parsed.changes, metaById, { creating: false });
        const before = {};
        for (const fieldId of Object.keys(fields)) {
          const value = issue?.fields?.[fieldId];
          before[fieldId] =
            typeof value === "string"
              ? clip(value)
              : Array.isArray(value)
                ? value.slice(0, 20).map((item) => (isPlainObject(item) ? (item.name ?? item.value ?? item.id ?? null) : item))
                : isPlainObject(value)
                  ? (value.name ?? value.value ?? value.id ?? null)
                  : (value ?? null);
        }
        const title = typeof issue?.fields?.summary === "string" ? issue.fields.summary : parsed.issueKey;
        return storePlan(current, {
          operation: "update_issue",
          summary: `Update ${parsed.issueKey} ${quoted(title, 80)}: ${describeValues(readable)}`,
          preview: { issueKey: parsed.issueKey, before, after: readable },
          request: { method: "PUT", path: `/issue/${encodeURIComponent(parsed.issueKey)}`, body: { fields } },
          fingerprint: { kind: "issue", issueKey: parsed.issueKey, value: issueFingerprint(issue) },
        });
      }
      case "jira.changes.prepare_transition": {
        const issue = await getIssue(current, parsed.issueKey, ["summary", "updated", "status"], signal);
        const value = await readJson(
          current.token,
          `/issue/${encodeURIComponent(parsed.issueKey)}/transitions`,
          { query: { expand: "transitions.fields" }, signal },
        );
        const transitions = Array.isArray(value?.transitions) ? value.transitions.slice(0, 200).map(projectTransition) : [];
        const transition = transitions.find((item) => item.id === parsed.transitionId);
        if (!transition) {
          throw failure("invalid_input", "That transition is not available on this issue for the connected user.", false, {
            available: transitions.map((item) => ({ id: item.id, name: item.name, to: item.to?.name ?? null })),
          });
        }
        const body = { transition: { id: transition.id } };
        const resolutionField = transition.fields.find((field) => field.fieldId === "resolution");
        if (parsed.resolution !== undefined) {
          if (!resolutionField) {
            throw failure("invalid_input", "This transition does not set a resolution.");
          }
          const resolved = resolveAllowed(resolutionField, parsed.resolution, "resolution");
          body.fields = { resolution: resolved.id ? { id: resolved.id } : { name: resolved.name } };
        }
        const missing = transition.fields
          .filter((field) => field.required && !field.hasDefaultValue && !(field.fieldId === "resolution" && body.fields))
          .map((field) => `${field.name} (${field.fieldId})`);
        if (missing.length > 0) {
          throw failure("missing_required_fields", `This transition requires: ${missing.join(", ")}.`);
        }
        if (parsed.comment !== undefined) body.update = { comment: [{ add: { body: parsed.comment } }] };
        const title = typeof issue?.fields?.summary === "string" ? issue.fields.summary : parsed.issueKey;
        const from = issue?.fields?.status?.name ?? "current status";
        return storePlan(current, {
          operation: "transition_issue",
          summary: `Move ${parsed.issueKey} ${quoted(title, 80)} from "${from}" to "${transition.to?.name ?? transition.name}" (${transition.name})${parsed.resolution === undefined ? "" : `, resolution "${parsed.resolution}"`}${parsed.comment === undefined ? "" : `, with comment ${quoted(parsed.comment, 200)}`}`,
          preview: {
            issueKey: parsed.issueKey,
            transition: { id: transition.id, name: transition.name, to: transition.to?.name ?? null },
            from,
            resolution: parsed.resolution ?? null,
            comment: clip(parsed.comment ?? null),
          },
          request: { method: "POST", path: `/issue/${encodeURIComponent(parsed.issueKey)}/transitions`, body },
          fingerprint: { kind: "issue", issueKey: parsed.issueKey, value: issueFingerprint(issue) },
        });
      }
      case "jira.changes.prepare_assign": {
        const issue = await getIssue(current, parsed.issueKey, ["summary", "updated", "status", "assignee"], signal);
        let target = null;
        if (parsed.assignee !== null) {
          target = projectUser(
            await readJson(current.token, "/user", { query: { username: parsed.assignee }, signal }),
            "assignee",
          );
        }
        const previous = projectUser(issue?.fields?.assignee, "issue assignee");
        const title = typeof issue?.fields?.summary === "string" ? issue.fields.summary : parsed.issueKey;
        return storePlan(current, {
          operation: "assign_issue",
          summary: clip(
            target === null
              ? `Unassign ${parsed.issueKey} "${title}"`
              : `Assign ${parsed.issueKey} "${title}" to ${target.displayName ?? parsed.assignee} (${parsed.assignee})`,
            500,
          ),
          preview: {
            issueKey: parsed.issueKey,
            from: previous ? { name: previous.name, displayName: previous.displayName } : null,
            to: target ? { name: parsed.assignee, displayName: target.displayName } : null,
          },
          request: {
            method: "PUT",
            path: `/issue/${encodeURIComponent(parsed.issueKey)}/assignee`,
            body: { name: parsed.assignee },
          },
          fingerprint: { kind: "issue", issueKey: parsed.issueKey, value: issueFingerprint(issue) },
        });
      }
      case "jira.changes.prepare_add_comment": {
        const issue = await getIssue(current, parsed.issueKey, ["summary"], signal);
        const body = { body: parsed.body };
        if (parsed.visibility !== undefined) body.visibility = parsed.visibility;
        const payloadDigest = digest(canonical({ operation: "add_comment", issueKey: parsed.issueKey, body }));
        guardDuplicate(payloadDigest, parsed.afterUnconfirmedOperationId);
        const title = typeof issue?.fields?.summary === "string" ? issue.fields.summary : parsed.issueKey;
        return storePlan(current, {
          operation: "add_comment",
          summary: `Comment on ${parsed.issueKey} ${quoted(title, 80)}${parsed.visibility ? ` visible only to ${parsed.visibility.type} "${parsed.visibility.value}"` : ""}: ${quoted(parsed.body, 300)}`,
          preview: { issueKey: parsed.issueKey, body: clip(parsed.body), visibility: parsed.visibility ?? null },
          request: { method: "POST", path: `/issue/${encodeURIComponent(parsed.issueKey)}/comment`, body },
          payloadDigest,
          appends: true,
          acknowledgedOperationId: parsed.afterUnconfirmedOperationId ?? null,
        });
      }
      case "jira.changes.prepare_update_comment": {
        const path = `/issue/${encodeURIComponent(parsed.issueKey)}/comment/${encodeURIComponent(parsed.commentId)}`;
        const comment = projectComment(await readJson(current.token, path, { signal }));
        return storePlan(current, {
          operation: "update_comment",
          summary: `Edit comment ${parsed.commentId} on ${parsed.issueKey}${comment.visibility ? ` (stays visible only to ${comment.visibility.type} "${comment.visibility.value}")` : ""} to ${quoted(parsed.body, 300)}`,
          preview: {
            issueKey: parsed.issueKey,
            commentId: parsed.commentId,
            author: comment.author?.displayName ?? comment.author?.name ?? null,
            visibility: comment.visibility,
            before: clip(comment.body),
            after: clip(parsed.body),
          },
          // Jira treats a comment update without visibility as public, so the current
          // restriction is sent back explicitly.
          request: {
            method: "PUT",
            path,
            body: comment.visibility?.type && comment.visibility?.value
              ? { body: parsed.body, visibility: { type: comment.visibility.type, value: comment.visibility.value } }
              : { body: parsed.body },
          },
          fingerprint: { kind: "comment", path, value: commentFingerprint(comment) },
        });
      }
      case "jira.changes.prepare_add_worklog": {
        const issue = await getIssue(current, parsed.issueKey, ["summary"], signal);
        const body = { timeSpent: parsed.timeSpent };
        if (parsed.started !== undefined) body.started = parsed.started;
        if (parsed.comment !== undefined) body.comment = parsed.comment;
        const payloadDigest = digest(canonical({ operation: "add_worklog", issueKey: parsed.issueKey, body }));
        guardDuplicate(payloadDigest, parsed.afterUnconfirmedOperationId);
        const title = typeof issue?.fields?.summary === "string" ? issue.fields.summary : parsed.issueKey;
        return storePlan(current, {
          operation: "add_worklog",
          summary: `Log ${parsed.timeSpent} on ${parsed.issueKey} ${quoted(title, 80)}${parsed.started === undefined ? "" : ` starting ${parsed.started}`}${parsed.comment === undefined ? "" : `: ${quoted(parsed.comment, 200)}`}`,
          preview: {
            issueKey: parsed.issueKey,
            timeSpent: parsed.timeSpent,
            started: parsed.started ?? "now",
            comment: clip(parsed.comment ?? null),
            remainingEstimate: "adjusted automatically by Jira",
          },
          request: {
            method: "POST",
            path: `/issue/${encodeURIComponent(parsed.issueKey)}/worklog`,
            query: { adjustEstimate: "auto" },
            body,
          },
          payloadDigest,
          appends: true,
          acknowledgedOperationId: parsed.afterUnconfirmedOperationId ?? null,
        });
      }
      case "jira.changes.prepare_link_issues": {
        const value = await readJson(current.token, "/issueLinkType", { signal });
        const types = Array.isArray(value?.issueLinkTypes) ? value.issueLinkTypes.slice(0, 200).map(projectLinkType) : [];
        const type =
          types.find((item) => item.id === parsed.linkType) ??
          types.find((item) => item.name === parsed.linkType) ??
          types.find((item) => item.name.toLocaleLowerCase("en-US") === parsed.linkType.toLocaleLowerCase("en-US"));
        if (!type) {
          throw failure("invalid_input", "That link type does not exist.", false, {
            available: types.map((item) => item.name),
          });
        }
        const inward = await getIssue(current, parsed.inwardIssueKey, ["summary"], signal);
        const outward = await getIssue(current, parsed.outwardIssueKey, ["summary"], signal);
        const body = {
          type: { name: type.name },
          inwardIssue: { key: parsed.inwardIssueKey },
          outwardIssue: { key: parsed.outwardIssueKey },
        };
        const payloadDigest = digest(canonical({ operation: "link_issues", body }));
        guardDuplicate(payloadDigest, parsed.afterUnconfirmedOperationId);
        return storePlan(current, {
          operation: "link_issues",
          // Jira REST shows the type's outward phrase on the inwardIssue ("A blocks B" for
          // inwardIssue A, outwardIssue B). Verify against UCSD Jira before relying on it.
          summary: `Link: ${parsed.inwardIssueKey} ${type.outward} ${parsed.outwardIssueKey} ("${type.name}")`,
          preview: {
            linkType: type,
            inwardIssue: { key: parsed.inwardIssueKey, summary: clip(inward?.fields?.summary ?? null, 300) },
            outwardIssue: { key: parsed.outwardIssueKey, summary: clip(outward?.fields?.summary ?? null, 300) },
          },
          request: { method: "POST", path: "/issueLink", body },
          payloadDigest,
          appends: true,
          acknowledgedOperationId: parsed.afterUnconfirmedOperationId ?? null,
        });
      }
      default:
        throw failure("tool_not_found", "The requested tool is not provided by this plugin.");
    }
  }

  async function applyChange(parsed, current, invocationContext) {
    prunePlans();
    const plan = plans.get(parsed.planId);
    if (
      !plan ||
      !textEqual(plan.previewHash, parsed.previewHash) ||
      plan.summary !== parsed.summary ||
      plan.accountKey !== current.accountKey ||
      plan.generation !== generation
    ) {
      throw failure(
        "preview_required",
        "Prepare a fresh Jira preview for this account and supply its exact planId, previewHash, and summary.",
      );
    }
    if (plan.fingerprint) {
      const signal = invocationContext.signal;
      const changed =
        plan.fingerprint.kind === "issue"
          ? issueFingerprint(await getIssue(current, plan.fingerprint.issueKey, ["updated", "status"], signal)) !==
            plan.fingerprint.value
          : commentFingerprint(projectComment(await readJson(current.token, plan.fingerprint.path, { signal }))) !==
            plan.fingerprint.value;
      if (changed) {
        plans.delete(parsed.planId);
        throw failure(
          "conflict",
          "The Jira item changed after this preview was prepared. Read it again and prepare a new change.",
        );
      }
    }
    if (Date.now() >= plan.expiresAt || plans.get(parsed.planId) !== plan || plan.generation !== generation) {
      plans.delete(parsed.planId);
      throw failure("preview_required", "The preview expired. Prepare a fresh preview.");
    }
    // Consumed before awaiting admission, with no await since the check above, so a concurrent
    // apply of the same plan fails instead of sending it twice. No outcome is ever replayed.
    plans.delete(parsed.planId);
    // An identical append whose earlier send went unconfirmed after this preview was prepared
    // still needs the agent's acknowledgement.
    if (plan.appends) guardDuplicate(plan.payloadDigest, plan.acknowledgedOperationId);
    const commitSignal = await admitCommit(invocationContext);
    const operationId = randomUUID();
    if (plan.generation !== generation) {
      return {
        status: "not_applied",
        retryable: false,
        operationId,
        operation: plan.operation,
        code: "preview_required",
        message: "UCSD Jira was disconnected or reconnected before this change was sent. Nothing was sent to Jira.",
      };
    }
    let result;
    try {
      result = await jiraSend(fetchImplementation, current.token, plan.request.path, {
        method: plan.request.method,
        query: plan.request.query,
        body: plan.request.body,
        signal: commitSignal,
      });
    } catch (error) {
      if (error?.code === "request_too_large" || error?.code === "invalid_request") {
        return {
          status: "not_applied",
          retryable: false,
          operationId,
          operation: plan.operation,
          code: error.code,
          message: `${error.message} Nothing was sent to Jira.`,
        };
      }
      rememberUnconfirmed(plan, operationId);
      return {
        status: "outcome_unknown",
        retryable: false,
        operationId,
        operation: plan.operation,
        message:
          "The change was sent but Jira's answer was lost. Read the issue to check whether it was applied before preparing anything again; do not retry blindly.",
      };
    }
    if (result.ok) {
      const output = {
        status: "applied",
        operationId,
        operation: plan.operation,
        message: "Jira accepted the change. Read the item again to confirm its current state.",
      };
      if (isPlainObject(result.value)) {
        if (typeof result.value.key === "string") output.issueKey = result.value.key.slice(0, 128);
        if (plan.operation !== "create_issue" && typeof result.value.id === "string") output.id = result.value.id.slice(0, 128);
      }
      return output;
    }
    if (result.status === 401) forgetAccess(current.token);
    if ([400, 401, 403, 404, 409, 429].includes(result.status)) {
      const reason = readFailure(result);
      return {
        status: "not_applied",
        retryable: false,
        operationId,
        operation: plan.operation,
        code: reason.code,
        message: `${reason.message} Nothing was changed. Prepare a new preview after addressing the reason.`,
        ...(reason.details ?? {}),
      };
    }
    rememberUnconfirmed(plan, operationId);
    return {
      status: "outcome_unknown",
      retryable: false,
      operationId,
      operation: plan.operation,
      message: `Jira returned HTTP ${result.status}, so whether the change landed is unknown. Read the issue before preparing anything again; do not retry blindly.`,
    };
  }

  async function runRead(toolName, parsed, current, signal) {
    switch (toolName) {
      case "jira.me.get":
        return { user: projectCurrentUser(await readJson(current.token, "/myself", { signal })) };
      case "jira.projects.list": {
        const value = await readJson(current.token, "/project", { signal });
        if (!Array.isArray(value)) throw failure("invalid_response", "Jira returned an invalid project list.");
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
        const value = await readJson(current.token, "/search", {
          method: "POST",
          body: {
            jql: parsed.jql,
            startAt: parsed.startAt,
            maxResults: parsed.maxResults,
            fields: SEARCH_FIELDS,
          },
          signal,
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
      case "jira.issues.get":
        return {
          issue: projectIssue(await getIssue(current, parsed.issueKey, ISSUE_FIELDS, signal), {
            includeDetails: true,
          }),
        };
      case "jira.comments.list":
      case "jira.worklogs.list": {
        const comments = toolName === "jira.comments.list";
        const value = await readJson(
          current.token,
          `/issue/${encodeURIComponent(parsed.issueKey)}/${comments ? "comment" : "worklog"}`,
          {
            query: { startAt: String(parsed.startAt), maxResults: String(parsed.maxResults) },
            signal,
          },
        );
        const list = comments ? value?.comments : value?.worklogs;
        if (
          !isPlainObject(value) ||
          !Array.isArray(list) ||
          !Number.isSafeInteger(value.startAt) ||
          !Number.isSafeInteger(value.total)
        ) {
          throw failure("invalid_response", `Jira returned an invalid ${comments ? "comment" : "worklog"} page.`);
        }
        // Some Jira versions ignore paging for worklogs and return the whole list from 0; page it
        // here from the requested offset so the response stays bounded and later entries reachable.
        const offset = Math.max(0, parsed.startAt - value.startAt);
        const page = list.slice(offset, offset + parsed.maxResults);
        const startAt = value.startAt + offset;
        const items = page.map(comments ? projectComment : projectWorklog);
        return {
          issueKey: parsed.issueKey,
          [comments ? "comments" : "worklogs"]: items,
          startAt,
          total: value.total,
          returned: items.length,
          hasMore: startAt + items.length < value.total,
        };
      }
      case "jira.fields.list": {
        const value = await readJson(current.token, "/field", { signal });
        if (!Array.isArray(value)) throw failure("invalid_response", "Jira returned an invalid field list.");
        const fields = value.map(projectField);
        const query = parsed.query?.toLocaleLowerCase("en-US");
        const filtered =
          query === undefined
            ? fields
            : fields.filter(
                (field) =>
                  field.id.toLocaleLowerCase("en-US").includes(query) ||
                  field.name.toLocaleLowerCase("en-US").includes(query),
              );
        const selected = filtered.slice(0, parsed.limit);
        return {
          fields: selected,
          returned: selected.length,
          totalMatched: filtered.length,
          truncated: filtered.length > selected.length,
        };
      }
      case "jira.transitions.list": {
        const value = await readJson(
          current.token,
          `/issue/${encodeURIComponent(parsed.issueKey)}/transitions`,
          { query: { expand: "transitions.fields" }, signal },
        );
        if (!isPlainObject(value) || !Array.isArray(value.transitions)) {
          throw failure("invalid_response", "Jira returned invalid transitions.");
        }
        return { issueKey: parsed.issueKey, transitions: value.transitions.slice(0, 100).map(projectTransition) };
      }
      case "jira.issues.create_metadata": {
        if (parsed.issueTypeId === undefined) {
          const value = await readJson(
            current.token,
            `/issue/createmeta/${encodeURIComponent(parsed.projectKey)}/issuetypes`,
            { query: { maxResults: "100" }, signal },
          );
          if (!isPlainObject(value) || !Array.isArray(value.values)) {
            throw failure("invalid_response", "Jira returned invalid create metadata.");
          }
          return {
            projectKey: parsed.projectKey,
            issueTypes: value.values.slice(0, 100).map((type) => ({
              id: requiredString(type?.id, "issue type id", 128),
              name: requiredString(type?.name, "issue type name", 512),
              subtask: type?.subtask === true,
            })),
          };
        }
        const fields = [...(await createMetaFields(current, parsed.projectKey, parsed.issueTypeId, signal)).values()];
        return {
          projectKey: parsed.projectKey,
          issueTypeId: parsed.issueTypeId,
          fields: fields.slice(0, MAX_META_FIELDS),
          truncated: fields.length > MAX_META_FIELDS,
        };
      }
      case "jira.issues.edit_metadata": {
        const fields = [...(await editMetaFields(current, parsed.issueKey, signal)).values()];
        return {
          issueKey: parsed.issueKey,
          fields: fields.slice(0, MAX_META_FIELDS),
          truncated: fields.length > MAX_META_FIELDS,
        };
      }
      case "jira.users.assignable": {
        const query = { username: parsed.query, maxResults: String(parsed.maxResults) };
        if (parsed.issueKey !== undefined) query.issueKey = parsed.issueKey;
        else query.project = parsed.projectKey;
        const value = await readJson(current.token, "/user/assignable/search", { query, signal });
        if (!Array.isArray(value)) throw failure("invalid_response", "Jira returned an invalid user list.");
        return { users: value.slice(0, parsed.maxResults).map((user) => projectUser(user)) };
      }
      case "jira.issue_link_types.list": {
        const value = await readJson(current.token, "/issueLinkType", { signal });
        if (!isPlainObject(value) || !Array.isArray(value.issueLinkTypes)) {
          throw failure("invalid_response", "Jira returned invalid link types.");
        }
        return { linkTypes: value.issueLinkTypes.slice(0, 200).map(projectLinkType) };
      }
      default:
        return prepareChange(toolName, parsed, current, signal);
    }
  }

  async function refresh(lifecycleContext) {
    const credential = await currentCredential();
    if (credential === null || signInExpired) return;
    // Jira invalidates the old refresh token as soon as it processes this request, so the
    // request itself is the credential commit.
    const commitSignal = await admitCommit(lifecycleContext);
    const expectedGeneration = generation;
    const tokens = await brokerToken(
      { grant_type: "refresh_token", refresh_token: credential.refreshToken },
      commitSignal,
    );
    // Disconnect bumps the generation and deleted the credential, so a late rotation is
    // discarded. Close does not: a rotated token is still saved, or the stored one is dead.
    if (expectedGeneration !== generation) return;
    connectedAccountKey = credential.account.key;
    if (tokens.kind === "ok") {
      const rotated = {
        ...credential,
        refreshToken: tokens.refreshToken,
        updatedAt: new Date().toISOString(),
      };
      unsaved = rotated;
      access = {
        token: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        capabilities: credential.capabilities,
        scope: credential.scope,
        accountKey: credential.account.key,
      };
      refreshMessage = null;
      try {
        await writeCredential(rotated);
        unsaved = null;
      } catch {
        // Keep the rotated copy in memory and retry the save on the next preparation.
      }
      return;
    }
    access = null;
    if (tokens.kind === "rejected" && tokens.error === "invalid_grant") {
      signInExpired = true;
      refreshMessage = null;
      return;
    }
    if (tokens.kind === "rejected") {
      refreshMessage = "The TritonAI Jira sign-in service rejected the request. Try again later or contact TritonAI support.";
      return;
    }
    // Unknown whether Jira rotated the token. The stored one is retried next time; if it was
    // rotated, Jira answers invalid_grant and the user is asked to connect again.
    refreshMessage =
      tokens.kind === "rate_limited"
        ? "UCSD Jira sign-in is busy. Try again in a moment."
        : "UCSD Jira access could not be refreshed. Try again in a moment.";
  }

  return {
    id: PROVIDER_ID,
    async status(operationContext) {
      ensureOpen();
      validateOperationContext(operationContext);
      let credential;
      try {
        credential = await currentCredential();
      } catch (error) {
        if (error?.code === "credential_corrupt" || error?.code === "secret_store_error") {
          return { state: "error", accountLabel: null, grantedCapabilities: [], message: error.message };
        }
        throw error;
      }
      if (credential === null) {
        let legacy = null;
        try {
          legacy = await secrets.get(LEGACY_SECRET_NAME);
        } catch {
          legacy = null;
        }
        return {
          state: "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message:
            legacy === null
              ? null
              : "UCSD Jira now uses Jira sign-in instead of personal access tokens. Connect again.",
        };
      }
      const accountLabel = credential.account.displayName ?? credential.account.name ?? "UC San Diego Jira";
      if (signInExpired) {
        return {
          state: "not_connected",
          accountLabel,
          grantedCapabilities: [],
          message: "Your UCSD Jira sign-in expired or was revoked. Connect again.",
        };
      }
      return {
        state: "connected",
        accountLabel,
        grantedCapabilities: credential.capabilities,
        message: unsaved
          ? "Jira access was renewed but could not be saved yet; it will be saved automatically."
          : refreshMessage,
      };
    },
    prepare(lifecycleContext) {
      return serialized(async () => {
        ensureOpen();
        validateOperationContext(lifecycleContext, { requiresCommit: true });
        if (access && access.expiresAt - ACCESS_SKEW_MS > Date.now()) {
          if (unsaved === null) return;
          const commitSignal = await admitCommit(lifecycleContext);
          commitSignal.throwIfAborted();
          try {
            await writeCredential(unsaved);
            unsaved = null;
          } catch {
            // Still in memory; the next preparation retries.
          }
          return;
        }
        await refresh(lifecycleContext);
      });
    },
    async connect(capabilities, lifecycleContext, submission) {
      ensureOpen();
      validateOperationContext(lifecycleContext, { requiresCommit: true });
      if (submission !== undefined) {
        throw failure("invalid_submission", "UCSD Jira uses browser sign-in; no key can be submitted.");
      }
      const requested = requestedCapabilities(capabilities);
      // One sign-in at a time: a newer attempt supersedes any unfinished one.
      const startGeneration = generation;
      await closeAllFlows();
      const flow = await startFlow(requested, lifecycleContext.signal);
      flow.generation = startGeneration;
      if (generation !== startGeneration || closed) {
        // Disconnect ran while the listener was opening and could not see this flow.
        await closeFlow(flow);
        throw failure("cancelled", "UCSD Jira was disconnected while sign-in was starting. Connect again.");
      }
      const url = new URL(AUTHORIZE_ENDPOINT);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", `${brokerUrl}${BROKER_CALLBACK_PATH}`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", requested.scope);
      url.searchParams.set("state", flow.state);
      url.searchParams.set("code_challenge", flow.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return {
        kind: "authorization_url",
        flowId: flow.flowId,
        authorizationUrl: url.href,
        message:
          requested.scope === "WRITE"
            ? "Sign in to UC San Diego Jira and allow TritonAI Harness to read and change Jira as you. Finish in a browser on this computer."
            : "Sign in to UC San Diego Jira and allow TritonAI Harness to read Jira as you. Finish in a browser on this computer.",
        expiresAt: new Date(flow.expiresAt).toISOString(),
        intervalSeconds: POLL_INTERVAL_SECONDS,
      };
    },
    async poll(flowId, lifecycleContext) {
      ensureOpen();
      validateOperationContext(lifecycleContext, { requiresCommit: true });
      const flow = flows.get(flowId);
      if (!flow) return { state: "expired", retryAfterSeconds: null, message: "This Jira sign-in ended. Connect again." };
      if (flow.result === null) {
        if (flow.expiresAt <= Date.now()) {
          await closeFlow(flow);
          return { state: "expired", retryAfterSeconds: null, message: "The Jira sign-in expired. Connect again." };
        }
        return { state: "pending", retryAfterSeconds: POLL_INTERVAL_SECONDS, message: null };
      }
      if (flow.result.kind === "failed") {
        await closeFlow(flow);
        return { state: "failed", retryAfterSeconds: null, message: flow.result.message };
      }
      return serialized(async () => {
        if (flows.get(flowId) !== flow || closed || flow.generation !== generation) {
          if (flows.get(flowId) === flow) await closeFlow(flow);
          return { state: "expired", retryAfterSeconds: null, message: "This Jira sign-in ended. Connect again." };
        }
        lifecycleContext.signal.throwIfAborted();
        const { tokens, granted, account } = flow.result;
        const credential = {
          version: 2,
          refreshToken: tokens.refreshToken,
          scope: granted.scope,
          capabilities: granted.capabilities,
          account,
          updatedAt: new Date().toISOString(),
        };
        const commitSignal = await admitCommit(lifecycleContext);
        await closeFlow(flow);
        commitSignal.throwIfAborted();
        await writeCredential(credential);
        generation += 1;
        unsaved = null;
        signInExpired = false;
        refreshMessage = null;
        clearPlans();
        if (connectedAccountKey !== account.key) unconfirmed.clear();
        connectedAccountKey = account.key;
        access = {
          token: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          capabilities: granted.capabilities,
          scope: granted.scope,
          accountKey: account.key,
        };
        try {
          await secrets.remove(LEGACY_SECRET_NAME);
        } catch {
          // The unused legacy token is retried on disconnect.
        }
        return {
          state: "connected",
          retryAfterSeconds: null,
          message:
            granted.scope === "WRITE"
              ? "Connected to UC San Diego Jira. Changes always ask for your approval first."
              : "Connected to UC San Diego Jira with read access.",
        };
      });
    },
    disconnect(lifecycleContext) {
      return serialized(async () => {
        ensureOpen();
        validateOperationContext(lifecycleContext, { requiresCommit: true });
        // Revoke local use first: new invocations, previews, and sign-ins stop immediately.
        generation += 1;
        access = null;
        unsaved = null;
        signInExpired = false;
        refreshMessage = null;
        clearPlans();
        unconfirmed.clear();
        connectedAccountKey = null;
        await closeAllFlows();
        const commitSignal = await admitCommit(lifecycleContext);
        commitSignal.throwIfAborted();
        // Jira Data Center documents no token revocation endpoint for incoming OAuth clients.
        // Deleting the only copy of the refresh token ends TritonAI's access; Jira also expires
        // unused refresh tokens.
        for (const name of [SECRET_NAME, LEGACY_SECRET_NAME]) {
          try {
            await secrets.remove(name);
          } catch {
            let recovered;
            try {
              recovered = await secrets.get(name);
            } catch {
              throw unknownCommit("Jira credential removal could not be confirmed.");
            }
            if (recovered !== null) {
              throw failure("secret_store_error", "The Jira credential could not be removed.");
            }
          }
        }
      });
    },
    async invoke(toolName, input, invocationContext) {
      ensureOpen();
      validateOperationContext(invocationContext, { invocation: true });
      const capability = TOOL_CAPABILITY.get(toolName);
      if (capability === undefined) {
        throw failure("tool_not_found", "The requested tool is not provided by this plugin.");
      }
      if (
        toolName === "jira.changes.apply" &&
        (invocationContext.writeApproved !== true || typeof invocationContext.beginCommit !== "function")
      ) {
        throw failure("write_not_approved", "Harness must approve this Jira change before it can run.");
      }
      const parsed = validateInput(toolName, input);
      // The generation is captured now so a preparation that spans a reconnect is refused.
      const current = { ...requireAccess(capability), generation };
      if (toolName === "jira.changes.apply") return applyChange(parsed, current, invocationContext);
      return runRead(toolName, parsed, current, invocationContext.signal);
    },
    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      access = null;
      plans.clear();
      await closeAllFlows();
      await queue;
    },
  };
}
