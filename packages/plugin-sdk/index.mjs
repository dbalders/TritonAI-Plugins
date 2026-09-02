export const PLUGIN_API_VERSION = "tritonai.plugin/v1";
export const PLUGIN_KIND = "IntegrationPlugin";
export const PLUGIN_MANIFEST_VERSION = 1;
export const SDK_API_MAJOR = 1;
export const HOST_CONTRACT_LEVEL = 2;

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const TOOL_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MANIFEST_KEYS = new Set([
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
]);
const SDK_KEYS = new Set(["apiMajor", "requiredHostContractLevel"]);
const CAPABILITY_KEYS = new Set(["id", "displayName", "description", "access"]);
const TOOL_KEYS = new Set([
  "name",
  "displayName",
  "description",
  "capabilities",
  "effect",
  "destructive",
  "idempotent",
  "openWorld",
  "inputSchema",
]);
const SKILL_KEYS = new Set(["name", "description", "capabilities"]);
const SKILL = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_JSON_NODES = 20_000;
const MAX_SCHEMA_BYTES = 128 * 1_024;
const SCHEMA_VALUE_KEYWORDS = [
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_MAP_KEYWORDS = ["$defs", "dependentSchemas", "patternProperties", "properties"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmpty(value, maximum = 512) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximum
  );
}

function stableId(value, maximum = 128) {
  return nonEmpty(value, maximum) && ID.test(value);
}

function stableToolId(value) {
  return nonEmpty(value, 128) && TOOL_ID.test(value);
}

function assertJson(value, path = "$", depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  assert(budget.nodes <= MAX_JSON_NODES, `${path} exceeds the JSON node limit.`);
  assert(depth <= 32, `${path} exceeds the JSON depth limit.`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${path} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    assert(value.length <= 1_024, `${path} exceeds the JSON array limit.`);
    for (let index = 0; index < value.length; index += 1) {
      assertJson(value[index], `${path}[${index}]`, depth + 1, budget);
    }
    return;
  }
  assert(plainObject(value), `${path} must contain only plain JSON values.`);
  const keys = Object.keys(value);
  assert(keys.length <= 1_024, `${path} exceeds the JSON object member limit.`);
  for (const key of keys) {
    assert(key.length > 0 && key.length <= 256, `${path} contains an invalid JSON member name.`);
    assert(key !== "__proto__", `${path} contains an unsafe JSON member name.`);
    assertJson(value[key], `${path}.${key}`, depth + 1, budget);
  }
}

function assertSchema(schema, label) {
  assertJson(schema, label);
  assert(plainObject(schema), `${label} must be a JSON Schema object.`);
  assert(
    new TextEncoder().encode(canonicalJson(schema)).length <= MAX_SCHEMA_BYTES,
    `${label} exceeds the schema byte limit.`,
  );
  assert(
    schema.$schema === "https://json-schema.org/draft/2020-12/schema",
    `${label} must declare JSON Schema draft 2020-12.`,
  );
  assert(schema.type === "object", `${label} must describe an object.`);
  assert(
    schema.additionalProperties === false,
    `${label} must fail closed with additionalProperties false.`,
  );
  assert(plainObject(schema.properties), `${label} properties must be an object.`);
  function resolveReference(reference, path) {
    let pointer;
    try {
      pointer = decodeURIComponent(reference.slice(1));
    } catch {
      throw new Error(`${path} must be a local fragment JSON Pointer.`);
    }
    assert(
      reference.startsWith("#") && /^(?:\/(?:[^~/]|~[01])*)*$/u.test(pointer),
      `${path} must be a local fragment JSON Pointer.`,
    );
    let target = schema;
    const tokens = pointer.length === 0 ? [] : pointer.slice(1).split("/");
    for (const part of tokens) {
      const token = part.replaceAll("~1", "/").replaceAll("~0", "~");
      assert(
        (plainObject(target) || Array.isArray(target)) && Object.hasOwn(target, token),
        `${path} does not resolve.`,
      );
      target = target[token];
    }
    assert(plainObject(target) || typeof target === "boolean", `${path} must resolve to a schema.`);
    return target;
  }
  function visitSubschemas(current, path, visit) {
    for (const keyword of SCHEMA_VALUE_KEYWORDS) {
      const value = current[keyword];
      if (value === undefined) continue;
      assert(
        plainObject(value) || typeof value === "boolean",
        `${path}.${keyword} must be a schema.`,
      );
      visit(value, `${path}.${keyword}`);
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      const values = current[keyword];
      if (values === undefined) continue;
      assert(Array.isArray(values), `${path}.${keyword} must be a schema array.`);
      values.forEach((value, index) => {
        assert(
          plainObject(value) || typeof value === "boolean",
          `${path}.${keyword}[${index}] must be a schema.`,
        );
        visit(value, `${path}.${keyword}[${index}]`);
      });
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const values = current[keyword];
      if (values === undefined) continue;
      assert(plainObject(values), `${path}.${keyword} must be a schema map.`);
      for (const [name, value] of Object.entries(values)) {
        assert(
          plainObject(value) || typeof value === "boolean",
          `${path}.${keyword}.${name} must be a schema.`,
        );
        visit(value, `${path}.${keyword}.${name}`);
      }
    }
  }
  const inspected = new Set();
  function inspect(current, path) {
    if (!plainObject(current)) return;
    if (inspected.has(current)) return;
    inspected.add(current);
    for (const keyword of [
      "$anchor",
      "$dynamicAnchor",
      "$dynamicRef",
      "$id",
      "$recursiveAnchor",
      "$recursiveRef",
      "$vocabulary",
    ]) {
      assert(current[keyword] === undefined, `${path} may not use ${keyword}.`);
    }
    if (current.pattern !== undefined) {
      assert(
        typeof current.pattern === "string" && current.pattern.length <= 256,
        `${path}.pattern is invalid or too long.`,
      );
      try {
        new RegExp(current.pattern, "u");
      } catch {
        throw new Error(`${path}.pattern is not a valid regular expression.`);
      }
    }
    if (current.patternProperties !== undefined) {
      assert(
        plainObject(current.patternProperties),
        `${path}.patternProperties must be an object.`,
      );
      for (const pattern of Object.keys(current.patternProperties)) {
        assert(pattern.length <= 256, `${path}.patternProperties contains an excessive pattern.`);
        try {
          new RegExp(pattern, "u");
        } catch {
          throw new Error(`${path}.patternProperties contains an invalid regular expression.`);
        }
      }
    }
    if (current.$ref !== undefined) {
      assert(
        typeof current.$ref === "string" && current.$ref.startsWith("#"),
        `${path} may reference only this schema document.`,
      );
      inspect(resolveReference(current.$ref, `${path}.$ref`), `${path}.$ref target`);
    }
    visitSubschemas(current, path, inspect);
  }
  inspect(schema, label);
  const visiting = new Set();
  const visited = new Set();
  function assertAcyclic(target, name) {
    if (typeof target === "boolean" || visited.has(target)) return;
    assert(!visiting.has(target), `${label} contains a recursive reference graph at ${name}.`);
    visiting.add(target);
    const nested = new Set();
    function collect(current) {
      if (!plainObject(current)) return;
      if (typeof current.$ref === "string") nested.add(current.$ref);
      visitSubschemas(current, label, collect);
    }
    collect(target);
    for (const reference of nested) {
      assertAcyclic(resolveReference(reference, `${label} reference ${reference}`), reference);
    }
    visiting.delete(target);
    visited.add(target);
  }
  assertAcyclic(schema, "#");
}

export function canonicalJson(value) {
  assertJson(value);
  function normalize(current) {
    if (Array.isArray(current)) return current.map(normalize);
    if (plainObject(current)) {
      return Object.fromEntries(
        Object.keys(current)
          .sort()
          .map((key) => [key, normalize(current[key])]),
      );
    }
    return Object.is(current, -0) ? 0 : current;
  }
  return JSON.stringify(normalize(value));
}

export function validateManifestV1(value) {
  assert(plainObject(value), "Plugin manifest must be a plain object.");
  assert(exactKeys(value, MANIFEST_KEYS), "Plugin manifest contains unsupported fields.");
  assert(
    value.apiVersion === PLUGIN_API_VERSION,
    `Unsupported plugin apiVersion ${String(value.apiVersion)}.`,
  );
  assert(
    value.kind === PLUGIN_KIND && value.manifestVersion === PLUGIN_MANIFEST_VERSION,
    "Plugin manifest kind or manifestVersion is unsupported.",
  );
  assert(stableId(value.id, 64), "Plugin id must be a lowercase stable slug.");
  assert(nonEmpty(value.name, 128), "Plugin name is required.");
  assert(nonEmpty(value.description, 1_024), "Plugin description is required.");
  assert(
    typeof value.version === "string" && VERSION.test(value.version),
    "Plugin version must be semver.",
  );
  assert(
    plainObject(value.sdk) && exactKeys(value.sdk, SDK_KEYS),
    "Plugin sdk contract is invalid.",
  );
  assert(value.sdk.apiMajor === SDK_API_MAJOR, "Plugin sdk apiMajor is unsupported.");
  assert(
    Number.isSafeInteger(value.sdk.requiredHostContractLevel) &&
      value.sdk.requiredHostContractLevel > 0,
    "Plugin requiredHostContractLevel is invalid.",
  );
  assert(
    typeof value.entry === "string" && /^dist\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.mjs$/u.test(value.entry),
    "Plugin entry must be one dist/*.mjs file.",
  );
  assert(stableId(value.provider, 64), "Plugin provider must be a lowercase stable slug.");
  assertSchema(value.configurationSchema, "Plugin configurationSchema");
  assert(
    Array.isArray(value.capabilities) && value.capabilities.length > 0,
    "Plugin capabilities are required.",
  );
  assert(Array.isArray(value.tools) && value.tools.length > 0, "Plugin tools are required.");
  assert(Array.isArray(value.skills), "Plugin skills must be an array.");

  const capabilities = new Set();
  for (const capability of value.capabilities) {
    assert(
      plainObject(capability) && exactKeys(capability, CAPABILITY_KEYS),
      "Capability contains unsupported fields.",
    );
    assert(stableId(capability.id, 64), "Capability id is invalid.");
    assert(
      nonEmpty(capability.displayName, 128),
      `Capability ${capability.id} displayName is required.`,
    );
    assert(
      nonEmpty(capability.description, 1_024),
      `Capability ${capability.id} description is required.`,
    );
    assert(
      capability.access === "default" || capability.access === "opt-in",
      `Capability ${capability.id} access is invalid.`,
    );
    assert(!capabilities.has(capability.id), `Duplicate capability ${capability.id}.`);
    capabilities.add(capability.id);
  }

  const tools = new Set();
  for (const tool of value.tools) {
    assert(plainObject(tool) && exactKeys(tool, TOOL_KEYS), "Tool contains unsupported fields.");
    assert(stableToolId(tool.name), "Tool name is invalid.");
    assert(nonEmpty(tool.displayName, 128), `Tool ${tool.name} displayName is required.`);
    assert(nonEmpty(tool.description, 1_024), `Tool ${tool.name} description is required.`);
    assert(
      tool.effect === "read" || tool.effect === "write",
      `Tool ${tool.name} effect is invalid.`,
    );
    for (const annotation of ["destructive", "idempotent", "openWorld"]) {
      assert(
        typeof tool[annotation] === "boolean",
        `Tool ${tool.name} ${annotation} annotation is required.`,
      );
    }
    assert(
      Array.isArray(tool.capabilities) &&
        tool.capabilities.length > 0 &&
        new Set(tool.capabilities).size === tool.capabilities.length &&
        tool.capabilities.every((id) => capabilities.has(id)),
      `Tool ${tool.name} references an unknown or duplicate capability.`,
    );
    assertSchema(tool.inputSchema, `Tool ${tool.name} inputSchema`);
    assert(!tools.has(tool.name), `Duplicate tool ${tool.name}.`);
    tools.add(tool.name);
  }
  const skills = new Set();
  for (const skill of value.skills) {
    assert(
      plainObject(skill) && exactKeys(skill, SKILL_KEYS),
      "Skill contains unsupported fields.",
    );
    assert(typeof skill.name === "string" && SKILL.test(skill.name), "Skill name is invalid.");
    assert(nonEmpty(skill.description, 1_024), `Skill ${skill.name} description is required.`);
    assert(
      Array.isArray(skill.capabilities) &&
        skill.capabilities.length > 0 &&
        new Set(skill.capabilities).size === skill.capabilities.length &&
        skill.capabilities.every((id) => capabilities.has(id)),
      `Skill ${skill.name} references an unknown or duplicate capability.`,
    );
    assert(!skills.has(skill.name), `Duplicate skill ${skill.name}.`);
    skills.add(skill.name);
  }
  assertJson(value);
  return value;
}

export function pluginFailure(code, message, options = {}) {
  assert(nonEmpty(code, 128) && /^[a-z][a-z0-9_]*$/u.test(code), "Plugin failure code is invalid.");
  assert(nonEmpty(message, 1_024), "Plugin failure message is required.");
  assert(plainObject(options), "Plugin failure options must be a plain object.");
  assert(
    options.details === undefined || plainObject(options.details),
    "Plugin failure details must be a plain object.",
  );
  const failure = {
    _tag: "PluginFailure",
    code,
    message,
    retryable: options.retryable === true,
    ...(options.details === undefined ? {} : { details: options.details }),
  };
  assertJson(failure);
  return Object.freeze(failure);
}

export function externalCommitOutcomeUnknown(message, details) {
  assert(
    details === undefined || plainObject(details),
    "External commit details must be a plain object.",
  );
  const failure = {
    _tag: "ExternalCommitOutcomeUnknown",
    code: "external_commit_outcome_unknown",
    message: nonEmpty(message, 1_024) ? message : "The external commit outcome is unknown.",
    retryable: false,
    ...(details === undefined ? {} : { details }),
  };
  assertJson(failure);
  return Object.freeze(failure);
}
