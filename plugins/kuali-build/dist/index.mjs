const PROVIDER_ID = "kuali-build";

const TENANT_ORIGIN = "https://ucsd.kualibuild.com";

const MAX_JSON_DEPTH = 32;

const MAX_JSON_NODES = 50_000;

const MAX_OBJECT_KEYS = 1_000;

const MAX_ARRAY_ITEMS = 5_000;

const MAX_STRING_CHARS = 1_048_576;

const MAX_APP_RESULTS = 100;

const MAX_SCHEMA_FIELDS = 500;

const MAX_USER_RESULTS = 50;

const MAX_WRITE_FIELDS = 100;

const MAX_WRITE_DEPTH = 16;

const MAX_WRITE_NODES = 5_000;

const MAX_WRITE_ARRAY_ITEMS = 500;

const MAX_WRITE_OBJECT_KEYS = 200;

const MAX_WRITE_STRING_CHARS = 32_768;

const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

const objectIdPattern = /^[0-9a-f]{24}$/iu;

function failure(code, message, retryable = false, details) {
  const value = { _tag: "PluginFailure", code, message, retryable };
  if (details !== undefined) value.details = details;
  return Object.freeze(value);
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

export function createIntegrationProvider(context) {
  const factory = ownKeys(context, new Set(["broker", "configuration"]), "Factory context");
  if (!isPlainObject(factory.broker) || Object.keys(factory.broker).some((key) => key !== "request") || typeof factory.broker.request !== "function") {
    throw failure("invalid_context", "SDK2 requires the host operation broker.");
  }
  validateConfiguration(factory.configuration);
  let closed = false;
  return {
    id: PROVIDER_ID,
    async invoke(toolName, input, context) {
      if (closed) throw failure("provider_closed", "The Kuali Build provider is closed.");
      if (!isPlainObject(context) || !(context.signal instanceof AbortSignal)) throw failure("invalid_context", "The invocation signal is required.");
      context.signal.throwIfAborted();
      const parsed = validateInput(toolName, input);
      // The host binds the original input, not these normalized projection values.
      const data = validateJsonTree(await factory.broker.request(`${toolName}.v1`, input));
      context.signal.throwIfAborted();
      if (!isPlainObject(data)) throw failure("invalid_response", "The host returned an invalid Kuali data envelope.");
      switch (toolName) {
        case "kuali-build.apps.list": {
          const available = projectApps(extract(data, "apps"));
          const apps = available.slice(0, parsed.limit);
          return { apps, returned: apps.length, truncated: available.length > apps.length };
        }
        case "kuali-build.apps.get": {
          const app = extract(data, "app");
          return { app: app === null ? null : projectApp(app) };
        }
        case "kuali-build.forms.schema": {
          const app = extract(data, "app");
          if (app === null) return { app: null };
          projectApp(app);
          if (app.formVersion === null) return { app: { id: app.id, name: app.name }, fields: [], fieldCount: 0, published: false, truncated: false };
          if (!isPlainObject(app.formVersion) || !Array.isArray(app.formVersion.schema)) throw failure("invalid_response", "Kuali returned an invalid published form schema.");
          const fields = app.formVersion.schema.slice(0, MAX_SCHEMA_FIELDS).map((field) => {
            if (!isPlainObject(field)) throw failure("invalid_response", "Kuali returned an invalid form field.");
            return { formKey: typeof field.formKey === "string" ? field.formKey : null, label: typeof field.label === "string" ? field.label : null };
          });
          return { app: { id: app.id, name: app.name }, fields, fieldCount: app.formVersion.schema.length, published: true, truncated: app.formVersion.schema.length > fields.length };
        }
        case "kuali-build.documents.list": {
          const app = extract(data, "app");
          if (app === null) return { app: null, documents: [], pageInfo: null, totalCount: 0, truncated: false };
          projectApp(app);
          if (!isPlainObject(app.documentConnection) || !Array.isArray(app.documentConnection.edges) || !Number.isSafeInteger(app.documentConnection.totalCount)) throw failure("invalid_response", "Kuali returned an invalid document connection.");
          const selected = app.documentConnection.edges.slice(0, parsed.limit);
          const documents = selected.map((edge) => {
            if (!isPlainObject(edge)) throw failure("invalid_response", "Kuali returned an invalid document edge.");
            return projectDocumentSummary(edge.node);
          });
          return { app: { id: app.id, name: app.name }, documents, pageInfo: projectPageInfo(app.documentConnection.pageInfo), totalCount: app.documentConnection.totalCount, truncated: app.documentConnection.edges.length > selected.length };
        }
        case "kuali-build.documents.get": {
          const document = extract(data, "document");
          return { document: document === null ? null : projectDocument(document) };
        }
        case "kuali-build.documents.drafts.resolve": {
          const action = extract(data, "action");
          return { action: action === null ? null : projectDraftAction(action) };
        }
        case "kuali-build.documents.update": {
          const updated = extract(data, "updateDocument");
          if (!isPlainObject(updated) || typeof updated.id !== "string" || !objectIdPattern.test(updated.id) || updated.id.toLowerCase() !== parsed.documentId) throw failure("invalid_response", "Kuali returned an invalid updated document.");
          return { document: { id: updated.id.toLowerCase() }, updatedFormKeys: Object.keys(parsed.data), precondition: { expectedUpdatedAt: parsed.expectedUpdatedAt } };
        }
        case "kuali-build.documents.drafts.initialize": {
          const initialized = extract(data, "initializeWorkflow");
          if (!isPlainObject(initialized) || typeof initialized.actionId !== "string" || !objectIdPattern.test(initialized.actionId)) throw failure("invalid_response", "Kuali returned an invalid initialized draft.");
          return { appId: parsed.appId, actionId: initialized.actionId.toLowerCase(), state: "draft_initialized", nextTool: "kuali-build.documents.drafts.resolve", atomic: false };
        }
        case "kuali-build.documents.submit": {
          const result = extract(data, "submitDocument");
          if (typeof result !== "string" || result.length === 0 || result.length > 128) throw failure("invalid_response", "Kuali returned an invalid submission result.");
          return { actionId: parsed.actionId, documentId: parsed.documentId, result, state: "submitted", workflowStarted: true, atomic: false };
        }
        case "kuali-build.users.lookup": {
          const connection = extract(data, "usersConnection");
          if (!isPlainObject(connection) || !Array.isArray(connection.edges)) throw failure("invalid_response", "Kuali returned an invalid user connection.");
          const users = connection.edges.slice(0, MAX_USER_RESULTS).map((edge) => {
            if (!isPlainObject(edge)) throw failure("invalid_response", "Kuali returned an invalid user edge.");
            return projectUser(edge.node);
          });
          return { users, returned: users.length, truncated: connection.edges.length > users.length };
        }
        case "kuali-build.workflows.status": {
          const document = extract(data, "document");
          if (document === null) return { document: null };
          if (!isPlainObject(document) || typeof document.id !== "string" || !objectIdPattern.test(document.id) || !isPlainObject(document.meta)) throw failure("invalid_response", "Kuali returned invalid workflow metadata.");
          return { document: { id: document.id.toLowerCase(), workflowStatus: document.meta.workflowStatus ?? null, workflowData: document.meta.workflowData ?? null, submittedAt: document.meta.submittedAt ?? null, updatedAt: document.meta.updatedAt ?? null } };
        }
        default: throw failure("tool_not_found", "The requested tool is not provided by this plugin.");
      }
    },
    async close() { closed = true; },
  };
}
