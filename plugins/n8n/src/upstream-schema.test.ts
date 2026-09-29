import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { decoderFromJsonSchema, mergeAllOfMembers } from "./upstream-schema.ts";

const decode = (schema: Record<string, unknown>, input: unknown) =>
  Schema.decodeUnknownPromise(decoderFromJsonSchema(schema) as Schema.Decoder<unknown>)(input, {
    onExcessProperty: "error",
  });

describe("upstream schema decoding", () => {
  it("keeps every constraint an allOf member adds", async () => {
    const schema = {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
      additionalProperties: false,
      allOf: [
        { properties: { versionId: { type: "string", maxLength: 8 } }, required: ["versionId"] },
      ],
    };
    await expect(decode(schema, { agentId: "a", versionId: "v1" })).resolves.toEqual({
      agentId: "a",
      versionId: "v1",
    });
    await expect(decode(schema, { agentId: "a" })).rejects.toBeDefined();
    await expect(decode(schema, { agentId: "a", versionId: "too-long-id" })).rejects.toBeDefined();
  });

  it("keeps the stricter bound when members constrain the same keyword", async () => {
    const schema = {
      allOf: [
        { type: "string", maxLength: 10 },
        { type: "string", maxLength: 4 },
      ],
    };
    await expect(decode(schema, "abcd")).resolves.toBe("abcd");
    await expect(decode(schema, "abcde")).rejects.toBeDefined();
  });

  it("refuses to build a decoder from allOf members that conflict", () => {
    expect(() =>
      decoderFromJsonSchema({ allOf: [{ type: "string" }, { type: "number" }] }),
    ).toThrow(/cannot be merged/u);
    expect(
      mergeAllOfMembers({ properties: { id: { type: "string" } } }, [
        { properties: { id: { type: "number" } } },
      ]),
    ).toBeNull();
    expect(mergeAllOfMembers({ pattern: "^a" }, [{ pattern: "^b" }])).toBeNull();
  });
});
