// Test-owned protocol model. This is neither the Harness broker nor an OS sandbox.
import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/plugin-sdk/index.mjs";
import {
  BROKER_PROTOCOL,
  validateBrokerPolicy,
  validateOperationRequest,
} from "../../packages/plugin-sdk/broker.mjs";

export const sha256 = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const clone = (value) => JSON.parse(canonicalJson(value));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function validate(schema, input, root = schema) {
  if (schema.$ref) {
    const resolved = schema.$ref
      .slice(2)
      .split("/")
      .reduce((value, key) => value[key], root);
    return validate(resolved, input, root);
  }
  if (schema.anyOf) {
    assert(
      schema.anyOf.some((part) => {
        try {
          validate(part, input, root);
          return true;
        } catch {
          return false;
        }
      }),
      "schema anyOf",
    );
  }
  if (schema.const !== undefined)
    assert(canonicalJson(schema.const) === canonicalJson(input), "schema const");
  if (schema.enum) assert(schema.enum.includes(input), "schema enum");
  if (schema.type === "object") {
    assert(input !== null && typeof input === "object" && !Array.isArray(input), "schema object");
    assert(
      (schema.required ?? []).every((key) => Object.hasOwn(input, key)),
      "schema required",
    );
    for (const [key, value] of Object.entries(input)) {
      if (schema.properties?.[key]) validate(schema.properties[key], value, root);
      else assert(schema.additionalProperties !== false, "schema extra property");
    }
    assert(
      schema.maxProperties === undefined || Object.keys(input).length <= schema.maxProperties,
      "schema members",
    );
  }
  if (schema.type === "string") {
    assert(typeof input === "string", "schema string");
    assert(
      input.length >= (schema.minLength ?? 0) && input.length <= (schema.maxLength ?? Infinity),
      "schema string length",
    );
    if (schema.pattern) assert(new RegExp(schema.pattern, "u").test(input), "schema pattern");
  }
  if (schema.type === "integer" || schema.type === "number") {
    assert(
      typeof input === "number" &&
        Number.isFinite(input) &&
        (schema.type !== "integer" || Number.isSafeInteger(input)),
      "schema number",
    );
    assert(
      input >= (schema.minimum ?? -Infinity) && input <= (schema.maximum ?? Infinity),
      "schema number bounds",
    );
  }
  if (schema.type === "boolean") assert(typeof input === "boolean", "schema boolean");
  if (schema.type === "array") {
    assert(
      Array.isArray(input) &&
        input.length >= (schema.minItems ?? 0) &&
        input.length <= (schema.maxItems ?? Infinity),
      "schema array",
    );
    if (schema.items) input.forEach((item) => validate(schema.items, item, root));
  }
}

function hasControlCharacter(value, allowWhitespace = false) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if ((code <= 0x1f && !(allowWhitespace && [0x09, 0x0a, 0x0d].includes(code))) || code === 0x7f)
      return true;
  }
  return false;
}

function formData(value, confirmNullValues) {
  const output = {};
  const stack = [];
  for (const [key, item] of Object.entries(value)) {
    assert(/^(?:data\.)?[A-Za-z0-9_-]{1,128}$/u.test(key), "invalid form key");
    const normalized = key.startsWith("data.") ? key.slice(5) : key;
    assert(
      !["__proto__", "constructor", "prototype"].includes(normalized) &&
        !Object.hasOwn(output, normalized),
      "unsafe or duplicate form key",
    );
    output[normalized] = item;
    stack.push({ value: item, depth: 1 });
  }
  let nodes = 0;
  let sawNull = false;
  while (stack.length > 0) {
    const { value: item, depth } = stack.pop();
    assert(++nodes <= 5_000 && depth <= 16, "form data exceeds JSON bounds");
    if (item === null) sawNull = true;
    else if (Array.isArray(item)) {
      assert(item.length <= 500, "form data exceeds array limit");
      for (const child of item) stack.push({ value: child, depth: depth + 1 });
    } else if (typeof item === "object") {
      const entries = Object.entries(item);
      assert(entries.length <= 200, "form data exceeds object member limit");
      for (const [key, child] of entries) {
        assert(
          !["__proto__", "constructor", "prototype"].includes(key) &&
            key.length > 0 &&
            key.length <= 128 &&
            !hasControlCharacter(key),
          "unsafe nested form key",
        );
        stack.push({ value: child, depth: depth + 1 });
      }
    } else if (typeof item === "string") {
      assert(
        item.length <= 32_768 && !hasControlCharacter(item, true),
        "form data exceeds string bounds",
      );
    }
  }
  assert(!sawNull || confirmNullValues === true, "null confirmation");
  return output;
}

function validateMutationReceipt(operationId, input, result) {
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const objectId = (value) => typeof value === "string" && /^[0-9a-f]{24}$/iu.test(value);
  assert(record(result), "unusable mutation receipt");
  switch (operationId) {
    case "kuali-build.documents.update.v1": {
      const receipt = result.updateDocument;
      assert(
        record(receipt) &&
          objectId(receipt.id) &&
          receipt.id.toLowerCase() === input.documentId.toLowerCase(),
        "unusable update receipt",
      );
      return;
    }
    case "kuali-build.documents.drafts.initialize.v1": {
      const receipt = result.initializeWorkflow;
      assert(record(receipt) && objectId(receipt.actionId), "unusable initialization receipt");
      return;
    }
    case "kuali-build.documents.submit.v1":
      assert(
        typeof result.submitDocument === "string" &&
          result.submitDocument.length > 0 &&
          result.submitDocument.length <= 128,
        "unusable submission receipt",
      );
      return;
    default:
      throw new Error("No reviewed mutation receipt validator.");
  }
}

export function recipeVariables(recipe, input) {
  return Object.fromEntries(
    Object.entries(recipe.variables).map(([key, binding]) => {
      let value;
      if (Object.hasOwn(binding, "literal")) value = binding.literal;
      else {
        value = binding.input === "$" ? input : (input[binding.input] ?? binding.default);
        if (binding.transform === "lowercase-id") value = value.toLowerCase();
        if (binding.transform === "kuali-form-data")
          value = formData(value, input.confirmNullValues);
        if (binding.transform === "kuali-document-filters") {
          const operators = [];
          if (input.workflowStatus !== undefined)
            operators.push({
              field: "meta.workflowStatus",
              type: "IS",
              value: input.workflowStatus,
            });
          if (input.updatedAfter !== undefined)
            operators.push({
              field: "meta.updatedAt",
              type: "RANGE",
              min: String(input.updatedAfter),
            });
          value = operators.length ? { type: "AND", operators } : null;
        }
      }
      assert(value !== undefined, "unbound recipe parameter");
      return [key, clone(value)];
    }),
  );
}

export function createTestHost({
  manifest,
  policy,
  approvedPolicySha256,
  transport = async () => ({}),
}) {
  validateBrokerPolicy(policy, manifest);
  assert(sha256(policy) === approvedPolicySha256, "policy is not independently host approved");
  policy = clone(policy);
  manifest = clone(manifest);
  const connections = new Map();
  const channels = new Set();
  const events = [];
  const journals = [];
  const flows = new Map();
  let flowSequence = 0;
  function connect(
    id,
    { credential = "synthetic-fixture-key", capabilities = policy.credential.capabilities } = {},
  ) {
    assert(
      policy.credential.requiredCapabilities.every((capability) =>
        capabilities.includes(capability),
      ) && capabilities.every((capability) => policy.credential.capabilities.includes(capability)),
      "connection capability escalation",
    );
    connections.set(id, {
      credential,
      capabilities: [...capabilities],
      generation: (connections.get(id)?.generation ?? 0) + 1,
      items: new Map(),
    });
    return status(id);
  }
  function status(id) {
    const connection = connections.get(id);
    return {
      state: connection?.credential ? "connected" : "not_connected",
      accountLabel: connection?.credential ? "Test account" : null,
      grantedCapabilities: connection?.credential ? connection.capabilities : [],
      message: null,
    };
  }
  function live(channel, active) {
    const connection = connections.get(channel.connectionId);
    assert(
      channels.has(channel) &&
        !channel.closed &&
        connection?.credential &&
        connection.generation === channel.generation,
      "connection or worker generation revoked",
    );
    assert(
      channel.active === active && active && !active.signal.aborted && !active.finished,
      "invocation cancelled or expired",
    );
    return connection;
  }
  async function request(channel, wire) {
    validateOperationRequest(wire);
    assert(wire.requestId === channel.nextRequestId, "request replay or out of order");
    channel.nextRequestId += 1;
    const active = channel.active;
    const connection = live(channel, active);
    assert(!active.used, "one operation per invocation");
    const operation = policy.operations.find((candidate) => candidate.id === wire.operationId);
    assert(operation && operation.tool === active.toolName, "operation/tool mismatch");
    assert(
      sha256(wire.parameters) === active.inputSha256,
      "approved payload or destination mismatch",
    );
    assert(
      operation.capabilities.every((capability) => connection.capabilities.includes(capability)),
      "connection capability denied",
    );
    if (operation.effect === "write")
      assert(active.approvedPayloadSha256 === active.inputSha256, "F05 approval missing or stale");
    active.used = true;
    const input = clone(active.input);
    const send = async (document, variables, phase) => {
      live(channel, active);
      return transport({
        connectionId: channel.connectionId,
        credential: connection.credential,
        origin: policy.transport.origin,
        path: policy.transport.path,
        method: policy.transport.method,
        document,
        variables: clone(variables),
        phase,
        signal: active.signal,
      });
    };
    if (operation.precondition?.kind === "kuali-document-version") {
      const current = clone(
        await send(
          "query KualiBuildDocumentVersion($id: ID!) { document(id: $id) { id meta } }",
          { id: input.documentId.toLowerCase() },
          "precondition",
        ),
      );
      const document = current?.document;
      const meta = document?.meta;
      const version = meta?.updatedAt;
      const record = (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value);
      assert(
        record(current) &&
          record(document) &&
          record(meta) &&
          typeof document.id === "string" &&
          document.id.toLowerCase() === input.documentId.toLowerCase() &&
          (typeof version === "string" ||
            (typeof version === "number" && Number.isSafeInteger(version))) &&
          String(version) === input.expectedUpdatedAt,
        "invalid document or document changed",
      );
    }
    if (operation.precondition?.kind === "kuali-app-exists") {
      const current = await send(
        "query KualiBuildApp($id: ID) { app(id: $id) { id name } }",
        { id: input.appId.toLowerCase() },
        "precondition",
      );
      assert(current.app?.id?.toLowerCase() === input.appId.toLowerCase(), "app not found");
    }
    if (operation.precondition?.kind === "kuali-draft-binding") {
      const current = await send(
        "query KualiBuildDraftAction($actionId: String!) { action(actionId: $actionId) { id appId document { id } } }",
        { actionId: input.actionId.toLowerCase() },
        "precondition",
      );
      assert(
        current.action?.id?.toLowerCase() === input.actionId.toLowerCase() &&
          current.action?.document?.id?.toLowerCase() === input.documentId.toLowerCase(),
        "draft action mismatch",
      );
    }
    live(channel, active);
    const variables =
      operation.recipe.kind === "graphql" ? recipeVariables(operation.recipe, input) : null;
    let journal;
    if (operation.effect === "write") {
      journal = {
        connectionId: channel.connectionId,
        generation: channel.generation,
        tool: active.toolName,
        inputSha256: active.inputSha256,
        state: "admitted",
      };
      journals.push(journal);
      events.push("beginCommit");
    }
    try {
      let result;
      if (operation.recipe.kind === "synthetic-items-list")
        result = { items: [...connection.items].map(([id, value]) => ({ id, value })) };
      else if (operation.recipe.kind === "synthetic-items-put") {
        connection.items.set(input.id, input.value);
        result = { id: input.id, value: input.value };
      } else result = await send(operation.recipe.document, variables, "operation");
      result = clone(result);
      if (journal && policy.transport.kind === "graphql")
        validateMutationReceipt(operation.id, input, result);
      live(channel, active);
      if (journal) journal.state = "confirmed";
      return result;
    } catch (error) {
      if (journal) {
        journal.state = "unknown";
        active.commitFailure = Object.freeze({
          _tag: "ExternalCommitOutcomeUnknown",
          code: "external_commit_outcome_unknown",
          message: "The admitted external mutation could not be confirmed.",
          retryable: false,
        });
        throw active.commitFailure;
      }
      throw error;
    }
  }
  return {
    connect,
    status,
    events,
    journals,
    beginConnect(id) {
      const flowId = `flow-${++flowSequence}`;
      flows.set(flowId, id);
      return { flowId, kind: "api_key" };
    },
    submit(flowId, credential) {
      assert(flows.has(flowId), "expired flow");
      const id = flows.get(flowId);
      flows.delete(flowId);
      return connect(id, { credential });
    },
    completeOAuth(flowId, tokenResponse) {
      return this.submit(flowId, tokenResponse.access_token);
    },
    disconnect(id) {
      const connection = connections.get(id);
      if (connection) {
        connection.generation += 1;
        connection.credential = null;
      }
    },
    bind(id) {
      const connection = connections.get(id);
      assert(connection?.credential, "not connected");
      const channel = {
        connectionId: id,
        generation: connection.generation,
        nextRequestId: 1,
        active: null,
        closed: false,
      };
      channels.add(channel);
      const broker = Object.freeze({
        request: (operationId, parameters) =>
          request(channel, {
            protocol: BROKER_PROTOCOL,
            requestId: channel.nextRequestId,
            kind: "operation",
            operationId,
            parameters,
          }),
      });
      return { channel, broker };
    },
    request,
    close(channel) {
      channel.closed = true;
    },
    async invoke(
      channel,
      provider,
      toolName,
      input,
      { approved = false, approvedPayloadSha256, signal = new AbortController().signal } = {},
    ) {
      assert(!channel.active, "concurrent invocation denied");
      const tool = manifest.tools.find((candidate) => candidate.name === toolName);
      assert(tool, "unknown tool");
      const frozen = clone(input);
      validate(tool.inputSchema, frozen);
      const active = {
        toolName,
        input: frozen,
        inputSha256: sha256(frozen),
        approvedPayloadSha256: approvedPayloadSha256 ?? (approved ? sha256(frozen) : null),
        signal,
        used: false,
        finished: false,
      };
      channel.active = active;
      try {
        const result = await provider.invoke(toolName, clone(frozen), { signal });
        if (active.commitFailure) throw active.commitFailure;
        return clone(result);
      } catch (error) {
        throw active.commitFailure ?? error;
      } finally {
        active.finished = true;
        channel.active = null;
      }
    },
  };
}
