import { canonicalJson, validateManifestV1 } from "./index.mjs";

export const BROKER_API_VERSION = "tritonai.plugin/v2";
export const BROKER_PROTOCOL = "tritonai.plugin-broker/v1";
export const BROKER_SDK_API_MAJOR = 2;
export const BROKER_HOST_CONTRACT_LEVEL = 4;
export const BROKER_EXECUTION_PROFILE = "tritonai.quickjs-wasm/v1";
export const BROKER_POLICY_FORMAT = "tritonai.plugin-broker-policy/v1";
export const BROKER_LIMITS = Object.freeze({ frameBytes: 524_288, requestId: 2_147_483_647 });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function record(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => "value" in entry)
  );
}
function keys(value, required, optional = []) {
  assert(record(value), "Broker value must be a plain JSON object.");
  assert(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => [...required, ...optional].includes(key)),
    "Broker value contains missing or unsupported fields.",
  );
}
function id(value) {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)
  );
}
function bounded(value) {
  const encoded = canonicalJson(value);
  assert(
    new TextEncoder().encode(encoded).length <= BROKER_LIMITS.frameBytes,
    "Broker value exceeds the byte limit.",
  );
  return JSON.parse(encoded);
}

export function validateBrokerManifest(value) {
  value = bounded(value);
  keys(value, [
    "apiVersion",
    "kind",
    "manifestVersion",
    "id",
    "name",
    "description",
    "version",
    "sdk",
    "entry",
    "provider",
    "configurationSchema",
    "capabilities",
    "tools",
    "skills",
    "broker",
  ]);
  assert(
    value.apiVersion === BROKER_API_VERSION && value.manifestVersion === 2,
    "Unsupported broker plugin ABI.",
  );
  assert(
    value.sdk?.apiMajor === BROKER_SDK_API_MAJOR &&
      Number.isSafeInteger(value.sdk.requiredHostContractLevel) &&
      value.sdk.requiredHostContractLevel >= BROKER_HOST_CONTRACT_LEVEL,
    "Broker plugin requires SDK2 and host contract level 4 or newer.",
  );
  const { broker, ...legacyShape } = value;
  validateManifestV1({
    ...legacyShape,
    apiVersion: "tritonai.plugin/v1",
    manifestVersion: 1,
    sdk: { ...value.sdk, apiMajor: 1 },
  });
  keys(broker, ["protocol", "policyId", "policyVersion", "operations"]);
  assert(
    broker.protocol === BROKER_PROTOCOL &&
      id(broker.policyId) &&
      Number.isSafeInteger(broker.policyVersion) &&
      broker.policyVersion > 0,
    "Broker policy identity is invalid.",
  );
  assert(
    Array.isArray(broker.operations) && broker.operations.length === value.tools.length,
    "Every tool requires exactly one broker operation.",
  );
  const tools = new Set(value.tools.map((tool) => tool.name));
  const operations = new Set();
  for (const operation of broker.operations) {
    keys(operation, ["id", "tool"]);
    assert(
      id(operation.id) &&
        operation.id === `${operation.tool}.v1` &&
        tools.delete(operation.tool) &&
        !operations.has(operation.id),
      "Invalid or duplicate broker operation binding.",
    );
    operations.add(operation.id);
  }
  return value;
}

export function validateOperationRequest(value) {
  value = bounded(value);
  keys(value, ["protocol", "requestId", "kind", "operationId", "parameters"]);
  assert(
    value.protocol === BROKER_PROTOCOL && value.kind === "operation",
    "Unsupported broker request.",
  );
  assert(
    Number.isSafeInteger(value.requestId) &&
      value.requestId > 0 &&
      value.requestId <= BROKER_LIMITS.requestId,
    "Invalid broker request ID.",
  );
  assert(id(value.operationId) && record(value.parameters), "Invalid broker operation parameters.");
  return value;
}

export function validateBrokerPolicy(value, manifestValue) {
  const manifest = validateBrokerManifest(manifestValue);
  value = bounded(value);
  keys(value, ["format", "id", "version", "pluginId", "credential", "transport", "operations"]);
  assert(
    value.format === BROKER_POLICY_FORMAT &&
      value.id === manifest.broker.policyId &&
      value.version === manifest.broker.policyVersion &&
      value.pluginId === manifest.id,
    "Broker recipe identity mismatch.",
  );
  keys(value.credential, ["recipe", "capabilities", "requiredCapabilities"]);
  assert(value.credential.recipe === "host-api-key/v1", "Unsupported host credential recipe.");
  const capabilities = manifest.capabilities.map((capability) => capability.id);
  assert(
    canonicalJson(value.credential.capabilities) === canonicalJson(capabilities) &&
      Array.isArray(value.credential.requiredCapabilities) &&
      new Set(value.credential.requiredCapabilities).size ===
        value.credential.requiredCapabilities.length &&
      value.credential.requiredCapabilities.every((capability) =>
        capabilities.includes(capability),
      ),
    "Credential capabilities must match the manifest.",
  );
  if (value.transport?.kind === "synthetic") {
    keys(value.transport, ["kind"]);
  } else {
    keys(value.transport, [
      "kind",
      "origin",
      "path",
      "method",
      "credentialPlacement",
      "response",
      "redirects",
      "timeoutMs",
      "maxRequestBytes",
      "maxResponseBytes",
    ]);
    assert(
      value.transport.kind === "graphql" &&
        value.transport.method === "POST" &&
        value.transport.credentialPlacement === "authorization-bearer" &&
        value.transport.response === "graphql-data" &&
        value.transport.redirects === "error",
      "Unsupported broker transport recipe.",
    );
    const origin = new URL(value.transport.origin);
    assert(
      origin.protocol === "https:" &&
        origin.origin === value.transport.origin &&
        !origin.username &&
        !origin.password &&
        !origin.port &&
        /^\/(?:[a-zA-Z0-9_-]+\/?)*$/u.test(value.transport.path),
      "Invalid fixed broker destination.",
    );
    for (const field of ["timeoutMs", "maxRequestBytes", "maxResponseBytes"]) {
      assert(
        Number.isSafeInteger(value.transport[field]) &&
          value.transport[field] > 0 &&
          value.transport[field] <= (field === "timeoutMs" ? 30_000 : BROKER_LIMITS.frameBytes),
        "Invalid broker transport limit.",
      );
    }
  }
  assert(
    Array.isArray(value.operations) && value.operations.length === manifest.tools.length,
    "Broker recipe inventory mismatch.",
  );
  const bindings = new Map(manifest.broker.operations.map((binding) => [binding.id, binding.tool]));
  for (const operation of value.operations) {
    keys(operation, ["id", "tool", "effect", "capabilities", "recipe"], ["precondition"]);
    assert(
      bindings.get(operation.id) === operation.tool && bindings.delete(operation.id),
      "Broker recipe tool binding mismatch.",
    );
    const tool = manifest.tools.find((candidate) => candidate.name === operation.tool);
    assert(
      operation.effect === tool.effect &&
        canonicalJson(operation.capabilities) === canonicalJson(tool.capabilities),
      "Broker recipe capability/effect mismatch.",
    );
    if (value.transport.kind === "synthetic") {
      keys(operation.recipe, ["kind"]);
      assert(
        ["synthetic-items-list", "synthetic-items-put"].includes(operation.recipe.kind),
        "Unknown synthetic recipe.",
      );
    } else {
      keys(operation.recipe, ["kind", "document", "variables"]);
      assert(
        operation.recipe.kind === "graphql" &&
          typeof operation.recipe.document === "string" &&
          operation.recipe.document.length <= 4096 &&
          operation.recipe.document.startsWith(tool.effect === "write" ? "mutation " : "query "),
        "Invalid GraphQL recipe.",
      );
      assert(record(operation.recipe.variables), "Invalid GraphQL variables recipe.");
      for (const binding of Object.values(operation.recipe.variables)) {
        if (Object.hasOwn(binding, "literal")) keys(binding, ["literal"]);
        else {
          keys(binding, ["input"], ["default", "transform"]);
          assert(
            typeof binding.input === "string" &&
              (binding.input === "$" || Object.hasOwn(tool.inputSchema.properties, binding.input)),
            "Recipe references undeclared input.",
          );
          assert(
            binding.transform === undefined ||
              ["lowercase-id", "kuali-form-data", "kuali-document-filters"].includes(
                binding.transform,
              ),
            "Unknown recipe transform.",
          );
        }
      }
    }
    if (operation.precondition !== undefined) {
      keys(operation.precondition, ["kind"]);
      assert(
        operation.effect === "write" &&
          ["kuali-document-version", "kuali-app-exists", "kuali-draft-binding"].includes(
            operation.precondition.kind,
          ),
        "Unknown broker precondition.",
      );
    }
  }
  return value;
}

export function validateOperationResponse(value) {
  value = bounded(value);
  keys(value, ["protocol", "requestId", "kind"], value.kind === "result" ? ["value"] : ["error"]);
  assert(
    value.protocol === BROKER_PROTOCOL &&
      Number.isSafeInteger(value.requestId) &&
      value.requestId > 0 &&
      value.requestId <= BROKER_LIMITS.requestId,
    "Invalid broker response identity.",
  );
  if (value.kind === "result") assert(Object.hasOwn(value, "value"), "Missing broker result.");
  else {
    assert(value.kind === "error", "Unknown broker response.");
    keys(value.error, ["code", "message", "outcome"]);
    assert(
      id(value.error.code) &&
        typeof value.error.message === "string" &&
        value.error.message.length > 0 &&
        value.error.message.length <= 1024 &&
        ["not_dispatched", "unknown"].includes(value.error.outcome),
      "Invalid sanitized broker error.",
    );
  }
  return value;
}

/** Worker-side framing helper only; host admission and native isolation are separate requirements. */
export function createOperationBroker(transport) {
  assert(typeof transport === "function", "A broker transport is required.");
  let nextRequestId = 1;
  let pending = false;
  let failed = false;
  return Object.freeze({
    async request(operationId, parameters) {
      assert(!failed && !pending, "Broker channel is closed or already has an active operation.");
      const request = validateOperationRequest({
        protocol: BROKER_PROTOCOL,
        requestId: nextRequestId++,
        kind: "operation",
        operationId,
        parameters,
      });
      pending = true;
      try {
        const response = validateOperationResponse(await transport(request));
        assert(response.requestId === request.requestId, "Broker response request mismatch.");
        if (response.kind === "error") {
          throw Object.freeze(
            response.error.outcome === "unknown"
              ? {
                  _tag: "ExternalCommitOutcomeUnknown",
                  code: "external_commit_outcome_unknown",
                  message: response.error.message,
                  retryable: false,
                }
              : {
                  _tag: "PluginFailure",
                  code: response.error.code,
                  message: response.error.message,
                  retryable: false,
                },
          );
        }
        return response.value;
      } catch (error) {
        // A broken frame/transport cannot be recovered by replaying worker requests.
        failed = true;
        throw error;
      } finally {
        pending = false;
      }
    },
  });
}
