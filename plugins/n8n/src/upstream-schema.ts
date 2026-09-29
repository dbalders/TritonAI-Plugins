import * as Schema from "effect/Schema";

export interface UpstreamToolSnapshot {
  readonly name: string;
  readonly title: string;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
  readonly inputSchema: JsonSchema;
}

type JsonSchema = { readonly [key: string]: unknown };

// A property-free object that rejects any member. Effect emits an object-or-array JSON Schema
// for a Never-valued record, so keep the wire schema property-free and filter instead.
export const EmptyInput = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.check(Schema.makeFilter((input) => Object.keys(input).length === 0)),
);

function asSchema(value: unknown, path: string): JsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`n8n upstream schema at ${path} is not an object.`);
  }
  return value as JsonSchema;
}

function numberKeyword(schema: JsonSchema, key: string): number | undefined {
  const value = schema[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// JSON Schema patterns are matched with the `u` flag by the SDK. zod-to-json-schema emits the
// source of non-unicode JavaScript regexes, where escaping a non-syntax character such as `\=` is
// a harmless identity escape but a unicode-mode syntax error. Drop those redundant escapes.
function unicodePattern(pattern: string): string {
  try {
    new RegExp(pattern, "u");
    return pattern;
  } catch {
    const repaired = pattern.replace(/\\([=!:<>@#%&'",;~`])/gu, "$1");
    new RegExp(repaired, "u");
    return repaired;
  }
}

function mergeAllOf(schema: JsonSchema, path: string): JsonSchema {
  if (!Array.isArray(schema.allOf)) return schema;
  const { allOf, ...rest } = schema;
  let merged: Record<string, unknown> = { ...rest };
  (allOf as unknown[]).forEach((member, index) => {
    merged = { ...mergeAllOf(asSchema(member, `${path}.allOf[${index}]`), path), ...merged };
  });
  return merged;
}

function describe<S extends Schema.Top>(schema: S, source: JsonSchema): S {
  return typeof source.description === "string"
    ? (schema.annotate({ description: source.description }) as S)
    : schema;
}

function stringSchema(schema: JsonSchema): Schema.Top {
  const checks = [];
  const minimum = numberKeyword(schema, "minLength");
  const maximum = numberKeyword(schema, "maxLength");
  if (minimum !== undefined) checks.push(Schema.isMinLength(minimum));
  if (maximum !== undefined) checks.push(Schema.isMaxLength(maximum));
  if (typeof schema.pattern === "string") {
    checks.push(Schema.isPattern(new RegExp(unicodePattern(schema.pattern), "u")));
  }
  return checks.length === 0
    ? Schema.String
    : Schema.String.check(...(checks as [(typeof checks)[number]]));
}

function numberSchema(schema: JsonSchema, integer: boolean): Schema.Top {
  const checks = [];
  const minimum = numberKeyword(schema, "minimum");
  const maximum = numberKeyword(schema, "maximum");
  const exclusiveMinimum = numberKeyword(schema, "exclusiveMinimum");
  const exclusiveMaximum = numberKeyword(schema, "exclusiveMaximum");
  if (minimum !== undefined) checks.push(Schema.isGreaterThanOrEqualTo(minimum));
  if (maximum !== undefined) checks.push(Schema.isLessThanOrEqualTo(maximum));
  if (exclusiveMinimum !== undefined) checks.push(Schema.isGreaterThan(exclusiveMinimum));
  if (exclusiveMaximum !== undefined) checks.push(Schema.isLessThan(exclusiveMaximum));
  const base = integer ? Schema.Int : Schema.Finite;
  return checks.length === 0 ? base : base.check(...(checks as [(typeof checks)[number]]));
}

function arraySchema(schema: JsonSchema, path: string): Schema.Top {
  const items =
    schema.items === undefined
      ? Schema.Unknown
      : decoderFromJsonSchema(asSchema(schema.items, `${path}.items`), `${path}.items`);
  const checks = [];
  const minimum = numberKeyword(schema, "minItems");
  const maximum = numberKeyword(schema, "maxItems");
  if (minimum !== undefined) checks.push(Schema.isMinLength(minimum));
  if (maximum !== undefined) checks.push(Schema.isMaxLength(maximum));
  const array = Schema.Array(items);
  return checks.length === 0 ? array : array.check(...(checks as [(typeof checks)[number]]));
}

function objectSchema(schema: JsonSchema, path: string): Schema.Top {
  const properties =
    schema.properties === undefined ? {} : asSchema(schema.properties, `${path}.properties`);
  const names = Object.keys(properties);
  if (names.length === 0) {
    if (schema.additionalProperties === false) return EmptyInput;
    const values =
      schema.additionalProperties === undefined || schema.additionalProperties === true
        ? Schema.Unknown
        : decoderFromJsonSchema(
            asSchema(schema.additionalProperties, `${path}.additionalProperties`),
            `${path}.additionalProperties`,
          );
    return Schema.Record(Schema.String, values);
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(`n8n upstream schema at ${path} mixes properties with open members.`);
  }
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]) : []);
  const fields: Record<string, Schema.Top> = {};
  for (const name of names) {
    const field = decoderFromJsonSchema(
      asSchema(properties[name], `${path}.properties.${name}`),
      `${path}.properties.${name}`,
    );
    fields[name] = required.has(name) ? field : (Schema.optionalKey(field) as Schema.Top);
  }
  return Schema.Struct(fields);
}

function literalSchema(values: ReadonlyArray<unknown>, path: string): Schema.Top {
  if (
    values.length === 0 ||
    !values.every(
      (value) =>
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)),
    )
  ) {
    throw new Error(`n8n upstream schema at ${path} has unsupported literal values.`);
  }
  const literals = values as ReadonlyArray<string | number | boolean | null>;
  if (literals.length === 1) {
    return literals[0] === null ? Schema.Null : Schema.Literal(literals[0]!);
  }
  if (literals.some((value) => value === null)) {
    throw new Error(`n8n upstream schema at ${path} mixes null into an enum.`);
  }
  return Schema.Literals(literals as ReadonlyArray<string | number | boolean>);
}

function typedSchema(schema: JsonSchema, type: string, path: string): Schema.Top {
  switch (type) {
    case "string":
      return stringSchema(schema);
    case "number":
      return numberSchema(schema, false);
    case "integer":
      return numberSchema(schema, true);
    case "boolean":
      return Schema.Boolean;
    case "null":
      return Schema.Null;
    case "array":
      return arraySchema(schema, path);
    case "object":
      return objectSchema(schema, path);
    default:
      throw new Error(`n8n upstream schema at ${path} has unsupported type ${type}.`);
  }
}

/**
 * Builds a strict Effect decoder from a pinned n8n input schema. It covers the zod-to-json-schema
 * subset n8n emits and throws on anything else, so an unsupported upstream construct fails the
 * build instead of widening what the plugin accepts. `default` and `format` are left to n8n,
 * which applies and validates them server side.
 */
export function decoderFromJsonSchema(source: JsonSchema, path = "$"): Schema.Top {
  const schema = mergeAllOf(source, path);
  if (schema.not !== undefined) {
    const negated = asSchema(schema.not, `${path}.not`);
    if (Object.keys(negated).length !== 0) {
      throw new Error(`n8n upstream schema at ${path} negates a non-empty schema.`);
    }
    return Schema.Never;
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const members = ((schema.anyOf ?? schema.oneOf) as unknown[]).map((member, index) =>
      decoderFromJsonSchema(asSchema(member, `${path}.anyOf[${index}]`), `${path}.anyOf[${index}]`),
    );
    return describe(Schema.Union(members), schema);
  }
  if ("const" in schema) return describe(literalSchema([schema.const], path), schema);
  if (Array.isArray(schema.enum)) return describe(literalSchema(schema.enum, path), schema);
  if (Array.isArray(schema.type)) {
    const members = (schema.type as unknown[]).map((type) => {
      if (typeof type !== "string") {
        throw new Error(`n8n upstream schema at ${path} has an invalid type list.`);
      }
      return typedSchema(schema, type, path);
    });
    return describe(Schema.Union(members), schema);
  }
  if (typeof schema.type === "string") {
    return describe(typedSchema(schema, schema.type, path), schema);
  }
  if (Object.keys(schema).every((key) => key === "description" || key === "default")) {
    return describe(Schema.Unknown, schema);
  }
  throw new Error(`n8n upstream schema at ${path} is not a supported shape.`);
}
