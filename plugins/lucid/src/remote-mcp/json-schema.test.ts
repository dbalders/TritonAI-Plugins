import { describe, expect, it } from "vite-plus/test";

import { compatibleUpstreamSchema, compileSchema, manifestInputSchema } from "./json-schema.ts";

describe("compileSchema", () => {
  const schema = compileSchema({
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 5 },
      kind: { enum: ["flowchart", "erd"] },
      count: { type: "integer", minimum: 1, maximum: 3 },
      tags: { type: "array", items: { type: "string" }, maxItems: 2, uniqueItems: true },
      node: { $ref: "#/$defs/node" },
      either: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["title"],
    additionalProperties: false,
    $defs: {
      node: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  });

  it("accepts conforming input", () => {
    expect(
      schema.validate({
        title: "abc",
        kind: "erd",
        count: 2,
        tags: ["a", "b"],
        node: { id: "n1" },
        either: null,
      }),
    ).toBeNull();
  });

  it("reports the first violation with its path", () => {
    expect(schema.validate({})).toBe("$.title is required");
    expect(schema.validate({ title: "abcdef" })).toBe("$.title must have at most 5 characters");
    expect(schema.validate({ title: "a", extra: 1 })).toBe("$.extra is not allowed");
    expect(schema.validate({ title: "a", kind: "uml" })).toContain("must be one of");
    expect(schema.validate({ title: "a", count: 1.5 })).toBe("$.count must be integer");
    expect(schema.validate({ title: "a", tags: ["x", "x"] })).toBe("$.tags must not repeat items");
    expect(schema.validate({ title: "a", node: {} })).toBe("$.node.id is required");
    expect(schema.validate({ title: "a", either: 3 })).toContain("does not match any");
  });

  it("counts characters by code point", () => {
    expect(schema.validate({ title: "🙂🙂🙂🙂🙂" })).toBeNull();
  });

  it("fails closed on keywords it cannot enforce", () => {
    expect(() =>
      compileSchema({ type: "object", properties: { a: { type: "string", not: {} } } }),
    ).toThrow(/unsupported keyword not/u);
    expect(() => compileSchema({ type: "object", if: {} })).toThrow(/unsupported keyword if/u);
    expect(() => compileSchema({ $ref: "https://example.invalid/schema" })).toThrow(/non-local/u);
    expect(() => compileSchema({ $ref: "#/$defs/a", $defs: { a: { $ref: "#/$defs/a" } } })).toThrow(
      /recursive/u,
    );
  });
});

describe("compatibleUpstreamSchema", () => {
  const pinned = {
    type: "object",
    properties: {
      documentId: { type: "string", description: "The document." },
      pageIndex: { type: "integer" },
    },
    required: ["documentId"],
  };

  it("ignores wording, bounds, and new optional properties", () => {
    expect(
      compatibleUpstreamSchema(
        {
          type: "object",
          properties: {
            documentId: { type: "string", description: "Changed wording.", maxLength: 64 },
            pageIndex: { type: ["integer"] },
            format: { type: "string" },
          },
          required: ["documentId"],
          additionalProperties: true,
        },
        pinned,
      ),
    ).toBe(true);
  });

  it("treats new required, removed, or retyped properties as drift", () => {
    expect(
      compatibleUpstreamSchema(
        {
          ...pinned,
          properties: { ...pinned.properties, mode: { type: "string" } },
          required: ["documentId", "mode"],
        },
        pinned,
      ),
    ).toBe(false);
    expect(
      compatibleUpstreamSchema(
        { ...pinned, properties: { documentId: { type: "string" } } },
        pinned,
      ),
    ).toBe(false);
    expect(
      compatibleUpstreamSchema(
        { ...pinned, properties: { ...pinned.properties, pageIndex: { type: "string" } } },
        pinned,
      ),
    ).toBe(false);
    expect(compatibleUpstreamSchema({ ...pinned, additionalProperties: false }, pinned)).toBe(
      false,
    );
  });
});

describe("drift and validator hardening", () => {
  it("treats a changed default as drift", () => {
    const pinned = {
      type: "object",
      properties: { restrict_to_account: { type: "boolean", default: true } },
    };
    expect(compatibleUpstreamSchema(pinned, pinned)).toBe(true);
    expect(
      compatibleUpstreamSchema(
        {
          type: "object",
          properties: { restrict_to_account: { type: "boolean", default: false } },
        },
        pinned,
      ),
    ).toBe(false);
  });

  it("rejects keyword forms it would otherwise ignore", () => {
    for (const property of [
      { type: "array", items: false },
      { type: "array", items: [{ type: "string" }] },
      { type: "number", exclusiveMaximum: true },
      { type: "string", maxLength: "5" },
      { type: "object", required: "a" },
      { enum: [] },
    ]) {
      expect(() => compileSchema({ type: "object", properties: { value: property } })).toThrow();
    }
    expect(
      compileSchema({
        type: "object",
        properties: { value: { type: "array", items: true } },
      }).validate({ value: [1, "a"] }),
    ).toBeNull();
  });
});

describe("manifestInputSchema", () => {
  it("seals the top level and rewrites draft-07 definitions", () => {
    expect(
      manifestInputSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { node: { $ref: "#/definitions/node" } },
        definitions: { node: { type: "string" } },
      }),
    ).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { node: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "string" } },
      additionalProperties: false,
    });
    expect(() => manifestInputSchema({ type: "string" })).toThrow(/must be an object/u);
  });
});
