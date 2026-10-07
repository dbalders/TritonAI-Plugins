import * as NodeUtil from "node:util";

export type JsonSchema = { readonly [key: string]: unknown };

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Keywords the local validator enforces. Anything else that constrains a value fails the build,
// so an unsupported upstream construct can never silently widen what the plugin accepts.
const VALIDATED_KEYWORDS = new Set([
  "$defs",
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type",
  "uniqueItems",
]);
// Annotations and keywords the remote service enforces itself. They never widen local acceptance.
const IGNORED_KEYWORDS = new Set([
  "$comment",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "format",
  "readOnly",
  "title",
  "writeOnly",
]);

const SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

export interface CompiledSchema {
  /** Returns the first violation as a JSON-pointer-like path and reason, or null when valid. */
  validate(value: unknown): string | null;
}

function resolveReference(root: JsonSchema, reference: string, path: string): JsonSchema {
  if (!reference.startsWith("#/")) {
    throw new Error(`Schema at ${path} uses a non-local reference.`);
  }
  let current: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!plainRecord(current) || !Object.hasOwn(current, segment)) {
      throw new Error(`Schema at ${path} has an unresolved reference ${reference}.`);
    }
    current = current[segment];
  }
  if (!plainRecord(current)) throw new Error(`Schema at ${path} references a non-schema.`);
  return current;
}

function assertSupported(schema: JsonSchema, path: string): void {
  for (const key of Object.keys(schema)) {
    if (!VALIDATED_KEYWORDS.has(key) && !IGNORED_KEYWORDS.has(key)) {
      throw new Error(`Schema at ${path} uses unsupported keyword ${key}.`);
    }
  }
  const type = schema.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (types.length === 0 || types.some((entry) => !SCHEMA_TYPES.has(entry as string))) {
      throw new Error(`Schema at ${path} has an unsupported type.`);
    }
  }
  const numeric = [
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maxItems",
    "maxLength",
    "maximum",
    "minItems",
    "minLength",
    "minimum",
  ];
  for (const key of numeric) {
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
    ) {
      throw new Error(`Schema at ${path}.${key} must be a finite number.`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string")
      throw new Error(`Schema at ${path}.pattern is invalid.`);
    new RegExp(schema.pattern, "u");
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string"))
  ) {
    throw new Error(`Schema at ${path}.required is invalid.`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`Schema at ${path}.enum is invalid.`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    throw new Error(`Schema at ${path}.uniqueItems is invalid.`);
  }
  if (schema.properties !== undefined && !plainRecord(schema.properties)) {
    throw new Error(`Schema at ${path}.properties is invalid.`);
  }
  // `true` and `{}` accept anything and are enforced as such; `false` and tuple forms would need
  // rules this validator does not implement.
  if (schema.items !== undefined && schema.items !== true && !plainRecord(schema.items)) {
    throw new Error(`Schema at ${path}.items uses an unsupported form.`);
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean" &&
    !plainRecord(schema.additionalProperties)
  ) {
    throw new Error(`Schema at ${path}.additionalProperties is invalid.`);
  }
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return plainRecord(value);
    default:
      return false;
  }
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

/**
 * Compiles the bounded draft 2020-12 subset that MCP servers emit for tool inputs. The host
 * compiles the sealed manifest schema authoritatively before any call; this local check is
 * defense in depth and keeps the provider honest when it is exercised outside the host.
 */
export function compileSchema(root: JsonSchema): CompiledSchema {
  const patterns = new Map<string, RegExp>();
  const visit = (schema: JsonSchema, path: string, seen: ReadonlySet<string>): void => {
    assertSupported(schema, path);
    if (typeof schema.$ref === "string") {
      if (seen.has(schema.$ref)) throw new Error(`Schema at ${path} has a recursive reference.`);
      visit(resolveReference(root, schema.$ref, path), path, new Set([...seen, schema.$ref]));
    }
    if (typeof schema.pattern === "string" && !patterns.has(schema.pattern)) {
      patterns.set(schema.pattern, new RegExp(schema.pattern, "u"));
    }
    if (plainRecord(schema.properties)) {
      for (const [name, child] of Object.entries(schema.properties)) {
        if (!plainRecord(child)) throw new Error(`Schema at ${path}.${name} is not an object.`);
        visit(child, `${path}.${name}`, seen);
      }
    }
    if (plainRecord(schema.$defs)) {
      for (const [name, child] of Object.entries(schema.$defs)) {
        if (!plainRecord(child)) throw new Error(`Schema at ${path}.$defs.${name} is invalid.`);
      }
    }
    if (plainRecord(schema.items)) visit(schema.items, `${path}[]`, seen);
    if (plainRecord(schema.additionalProperties)) {
      visit(schema.additionalProperties, `${path}.*`, seen);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const members = schema[keyword];
      if (members === undefined) continue;
      if (!Array.isArray(members) || members.length === 0) {
        throw new Error(`Schema at ${path}.${keyword} is invalid.`);
      }
      members.forEach((member, index) => {
        if (!plainRecord(member)) throw new Error(`Schema at ${path}.${keyword} is invalid.`);
        visit(member, `${path}.${keyword}[${index}]`, seen);
      });
    }
  };
  visit(root, "$", new Set());

  const check = (schema: JsonSchema, value: unknown, path: string): string | null => {
    if (typeof schema.$ref === "string") {
      const failure = check(resolveReference(root, schema.$ref, path), value, path);
      if (failure) return failure;
    }
    if (schema.type !== undefined) {
      const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
      if (!types.some((type) => typeMatches(type, value))) {
        return `${path} must be ${types.join(" or ")}`;
      }
    }
    if ("const" in schema && !NodeUtil.isDeepStrictEqual(schema.const, value)) {
      return `${path} must equal ${JSON.stringify(schema.const)}`;
    }
    if (
      Array.isArray(schema.enum) &&
      !schema.enum.some((entry) => NodeUtil.isDeepStrictEqual(entry, value))
    ) {
      return `${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`;
    }
    if (typeof value === "string") {
      const length = codePointLength(value);
      if (typeof schema.minLength === "number" && length < schema.minLength) {
        return `${path} must have at least ${schema.minLength} characters`;
      }
      if (typeof schema.maxLength === "number" && length > schema.maxLength) {
        return `${path} must have at most ${schema.maxLength} characters`;
      }
      if (typeof schema.pattern === "string" && !patterns.get(schema.pattern)!.test(value)) {
        return `${path} does not match the required pattern`;
      }
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        return `${path} must be at least ${schema.minimum}`;
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        return `${path} must be at most ${schema.maximum}`;
      }
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
        return `${path} must be greater than ${schema.exclusiveMinimum}`;
      }
      if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
        return `${path} must be less than ${schema.exclusiveMaximum}`;
      }
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        return `${path} must have at least ${schema.minItems} items`;
      }
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        return `${path} must have at most ${schema.maxItems} items`;
      }
      if (schema.uniqueItems === true) {
        for (let left = 0; left < value.length; left += 1) {
          for (let right = left + 1; right < value.length; right += 1) {
            if (NodeUtil.isDeepStrictEqual(value[left], value[right])) {
              return `${path} must not repeat items`;
            }
          }
        }
      }
      if (plainRecord(schema.items)) {
        for (let index = 0; index < value.length; index += 1) {
          const failure = check(schema.items, value[index], `${path}[${index}]`);
          if (failure) return failure;
        }
      }
    }
    if (plainRecord(value)) {
      const properties = plainRecord(schema.properties) ? schema.properties : {};
      if (Array.isArray(schema.required)) {
        for (const name of schema.required as string[]) {
          if (!Object.hasOwn(value, name)) return `${path}.${name} is required`;
        }
      }
      for (const [name, member] of Object.entries(value)) {
        if (Object.hasOwn(properties, name)) {
          const failure = check(properties[name] as JsonSchema, member, `${path}.${name}`);
          if (failure) return failure;
        } else if (schema.additionalProperties === false) {
          return `${path}.${name} is not allowed`;
        } else if (plainRecord(schema.additionalProperties)) {
          const failure = check(schema.additionalProperties, member, `${path}.${name}`);
          if (failure) return failure;
        }
      }
    }
    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf as JsonSchema[]) {
        const failure = check(member, value, path);
        if (failure) return failure;
      }
    }
    if (Array.isArray(schema.anyOf)) {
      const members = schema.anyOf as JsonSchema[];
      if (!members.some((member) => check(member, value, path) === null)) {
        return `${path} does not match any allowed shape`;
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const matches = (schema.oneOf as JsonSchema[]).filter(
        (member) => check(member, value, path) === null,
      ).length;
      if (matches !== 1) return `${path} must match exactly one allowed shape`;
    }
    return null;
  };

  return { validate: (value) => check(root, value, "$") };
}

// Keywords that define which calls a tool accepts and what an omitted argument means. Descriptions,
// titles, and validation bounds are deliberately excluded: they change wording or tighten limits
// upstream without changing the call contract the plugin reviewed. Defaults are compared because a
// changed default changes what a call that omits the argument does, such as how widely to share.
const STRUCTURAL_SCHEMA_KEYS = new Set([
  "$ref",
  "additionalProperties",
  "anyOf",
  "default",
  "enum",
  "items",
  "oneOf",
  "properties",
  "required",
  "type",
]);

/** Normalizes a schema to its structural call contract so equivalent encodings compare equal. */
export function schemaContract(
  value: unknown,
  root: unknown = value,
  activeReferences: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => schemaContract(entry, root, activeReferences));
    return mapped.every((entry) => typeof entry === "string")
      ? (mapped as string[]).toSorted()
      : mapped;
  }
  if (!plainRecord(value)) return value;
  if (typeof value.$ref === "string" && !activeReferences.has(value.$ref) && plainRecord(root)) {
    let resolved: JsonSchema | null = null;
    try {
      resolved = resolveReference(root, value.$ref, "$");
    } catch {
      resolved = null;
    }
    if (resolved) {
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
      return schemaContract(
        { ...resolved, ...siblings },
        root,
        new Set([...activeReferences, value.$ref]),
      );
    }
  }
  if (Array.isArray(value.type) && !("anyOf" in value)) {
    const { type, ...rest } = value;
    if (type.length === 1)
      return schemaContract({ ...rest, type: type[0] }, root, activeReferences);
    return schemaContract(
      { ...rest, anyOf: type.map((entry) => ({ type: entry })) },
      root,
      activeReferences,
    );
  }
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value)
    .filter((entry) => STRUCTURAL_SCHEMA_KEYS.has(entry))
    .toSorted()) {
    if (key === "properties") {
      if (!plainRecord(value.properties)) continue;
      const properties = value.properties;
      normalized.properties = Object.fromEntries(
        Object.keys(properties)
          .toSorted()
          .map((name) => [name, schemaContract(properties[name], root, activeReferences)]),
      );
      continue;
    }
    if (key === "additionalProperties") {
      // `true` and an omitted keyword are the same contract.
      if (value.additionalProperties === true) continue;
    }
    normalized[key] = schemaContract(value[key], root, activeReferences);
  }
  if ("const" in value && !("enum" in value)) {
    normalized.enum = [schemaContract(value.const, root, activeReferences)];
  }
  if (plainRecord(normalized.properties) && Object.keys(normalized.properties).length === 0) {
    delete normalized.properties;
  }
  if (plainRecord(normalized.items) && Object.keys(normalized.items).length === 0) {
    delete normalized.items;
  }
  if (Array.isArray(normalized.required) && normalized.required.length === 0) {
    delete normalized.required;
  }
  return normalized;
}

/**
 * Whether a live upstream input schema still accepts every call the pinned schema allows, in the
 * same shape. Upstream may add optional top-level properties, and change wording or bounds,
 * without pausing a tool. A new required property, a removed or retyped property, or any nested
 * structural change is drift.
 */
export function compatibleUpstreamSchema(live: unknown, pinned: unknown): boolean {
  const liveContract = schemaContract(live);
  const pinnedContract = schemaContract(pinned);
  if (NodeUtil.isDeepStrictEqual(liveContract, pinnedContract)) return true;
  if (!plainRecord(liveContract) || !plainRecord(pinnedContract)) return false;
  if (liveContract.type !== "object" || pinnedContract.type !== "object") return false;
  const liveProperties = plainRecord(liveContract.properties) ? liveContract.properties : {};
  const pinnedProperties = plainRecord(pinnedContract.properties) ? pinnedContract.properties : {};
  const liveRequired = new Set(
    Array.isArray(liveContract.required) ? (liveContract.required as string[]) : [],
  );
  const pinnedRequired = new Set(
    Array.isArray(pinnedContract.required) ? (pinnedContract.required as string[]) : [],
  );
  for (const name of liveRequired) {
    if (!pinnedRequired.has(name)) return false;
  }
  for (const [name, schema] of Object.entries(pinnedProperties)) {
    if (!Object.hasOwn(liveProperties, name)) return false;
    if (!NodeUtil.isDeepStrictEqual(liveProperties[name], schema)) return false;
  }
  const { properties: _liveProperties, required: _liveRequired, ...liveRest } = liveContract;
  const {
    properties: _pinnedProperties,
    required: _pinnedRequired,
    ...pinnedRest
  } = pinnedContract;
  return NodeUtil.isDeepStrictEqual(liveRest, pinnedRest);
}

/**
 * Prepares a pinned upstream input schema for the sealed manifest: draft 2020-12, top-level
 * `additionalProperties: false`, and draft-07 `definitions` rewritten as `$defs`.
 */
export function manifestInputSchema(upstream: JsonSchema): JsonSchema {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!plainRecord(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (key === "$ref" && typeof member === "string" && member.startsWith("#/definitions/")) {
        result.$ref = `#/$defs/${member.slice("#/definitions/".length)}`;
        continue;
      }
      if (key === "definitions") {
        result.$defs = rewrite(member);
        continue;
      }
      if (key === "$schema") continue;
      result[key] = rewrite(member);
    }
    return result;
  };
  const body = rewrite(upstream) as Record<string, unknown>;
  if (body.type !== "object") throw new Error("Upstream tool input schema must be an object.");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...body,
    properties: plainRecord(body.properties) ? body.properties : {},
    additionalProperties: false,
  };
}
