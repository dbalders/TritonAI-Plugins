import assert from "node:assert/strict";
import * as Fs from "node:fs/promises";
import test from "node:test";

import { canonicalJson, validateManifestV1 } from "../packages/plugin-sdk/index.mjs";
import {
  BROKER_LIMITS,
  BROKER_PROTOCOL,
  createOperationBroker,
  validateBrokerManifest,
  validateBrokerPolicy,
  validateOperationRequest,
  validateOperationResponse,
} from "../packages/plugin-sdk/broker.mjs";

const request = (parameters) => ({
  protocol: BROKER_PROTOCOL,
  requestId: 1,
  kind: "operation",
  operationId: "synthetic.items.put.v1",
  parameters,
});
const response = (value) => ({ protocol: BROKER_PROTOCOL, requestId: 1, kind: "result", value });
const json = async (path) => JSON.parse(await Fs.readFile(new URL(path, import.meta.url), "utf8"));

for (const [name, wrap] of [
  ["object member", (get) => Object.defineProperty({}, "value", { enumerable: true, get })],
  [
    "nested object member",
    (get) => ({ nested: Object.defineProperty({}, "value", { enumerable: true, get }) }),
  ],
  ["array element", (get) => Object.defineProperty([0], "0", { enumerable: true, get })],
]) {
  test(`canonical JSON rejects ${name} accessors without executing them`, () => {
    let reads = 0;
    const value = wrap(() => {
      reads += 1;
      return "innocent";
    });
    assert.throws(() => canonicalJson(value), /accessor|data propert/u);
    assert.equal(reads, 0);
  });
}

for (const [name, make] of [
  ["symbol property", () => ({ [Symbol("hidden")]: 1 })],
  ["non-enumerable object property", () => Object.defineProperty({}, "hidden", { value: 1 })],
  ["extra array property", () => Object.assign([], { url: "https://example.invalid" })],
  ["sparse array", () => Object.defineProperty([], "length", { value: 1 })],
  ["non-enumerable array element", () => Object.defineProperty([1], "0", { enumerable: false })],
]) {
  test(`canonical JSON rejects unsupported ${name} rather than silently dropping it`, () => {
    assert.throws(() => canonicalJson(make()));
  });
}

test("canonical JSON preserves ordinary SDK1 encoding, including numeric member order and frozen data", () => {
  const value = Object.freeze({
    z: Object.freeze([0, false, null, "text"]),
    10: "ten",
    2: "two",
    a: Object.freeze({ z: -0, a: true }),
  });
  assert.equal(
    canonicalJson(value),
    '{"2":"two","10":"ten","a":{"a":true,"z":0},"z":[0,false,null,"text"]}',
  );
});

for (const kind of ["request", "result", "error", "manifest-v1", "manifest-v2", "policy-v2"]) {
  test(`${kind} rejects nested accessors before executing any getter`, async () => {
    let reads = 0;
    const nested = Object.defineProperty({}, "text", {
      enumerable: true,
      get() {
        reads += 1;
        return "short";
      },
    });
    let value;
    let validate;
    if (kind === "request") {
      value = request({ data: nested });
      validate = validateOperationRequest;
    }
    if (kind === "result") {
      value = response({ data: nested });
      validate = validateOperationResponse;
    }
    if (kind === "error") {
      value = {
        protocol: BROKER_PROTOCOL,
        requestId: 1,
        kind: "error",
        error: { code: "denied", message: "Denied", outcome: "not_dispatched" },
      };
      Object.defineProperty(value.error, "message", {
        enumerable: true,
        get() {
          reads += 1;
          return "Denied";
        },
      });
      validate = validateOperationResponse;
    }
    if (kind === "manifest-v1" || kind === "manifest-v2") {
      value = await json(
        kind === "manifest-v1"
          ? "../plugins/synthetic-readonly/.tritonai-plugin/plugin.json"
          : "../plugins/synthetic-api-key/.tritonai-plugin/plugin.json",
      );
      value.tools[0].inputSchema.properties.extra = { type: "object", default: nested };
      validate = kind === "manifest-v1" ? validateManifestV1 : validateBrokerManifest;
    }
    if (kind === "policy-v2") {
      const manifest = await json("../plugins/synthetic-api-key/.tritonai-plugin/plugin.json");
      value = await json("../plugins/synthetic-api-key/.tritonai-plugin/broker-policy.json");
      Object.defineProperty(value.operations[0].recipe, "kind", {
        enumerable: true,
        get() {
          reads += 1;
          return "synthetic-items-list";
        },
      });
      validate = (policy) => validateBrokerPolicy(policy, manifest);
    }
    assert.throws(() => validate(value), /accessor|data propert/u);
    assert.equal(reads, 0);
  });
}

for (const kind of ["manifest-v1", "manifest-v2"]) {
  test(`${kind} rejects top-level accessors without reading them`, async () => {
    const value = await json(
      kind === "manifest-v1"
        ? "../plugins/synthetic-readonly/.tritonai-plugin/plugin.json"
        : "../plugins/synthetic-api-key/.tritonai-plugin/plugin.json",
    );
    let reads = 0;
    Object.defineProperty(value, "name", {
      enumerable: true,
      get() {
        reads += 1;
        return "Name";
      },
    });
    assert.throws(
      () => (kind === "manifest-v1" ? validateManifestV1 : validateBrokerManifest)(value),
      /accessor|data propert/u,
    );
    assert.equal(reads, 0);
  });
}

test("changing nested request getter cannot reach transport or bypass byte bounds", async () => {
  let reads = 0;
  let transports = 0;
  const parameters = {
    data: {
      get text() {
        reads += 1;
        return reads <= 2 ? "short" : "x".repeat(600_000);
      },
    },
  };
  const broker = createOperationBroker(async (frame) => {
    transports += 1;
    assert(Buffer.byteLength(JSON.stringify(frame)) <= BROKER_LIMITS.frameBytes);
    return response({});
  });
  await assert.rejects(
    broker.request("kuali-build.documents.update.v1", parameters),
    /accessor|data propert/u,
  );
  assert.equal(reads, 0);
  assert.equal(transports, 0);
});

test("changing nested result getter cannot bypass the response cap or execute", async () => {
  let reads = 0;
  let transports = 0;
  const broker = createOperationBroker(async () => {
    transports += 1;
    return response({
      data: {
        get text() {
          reads += 1;
          return reads <= 2 ? "short" : "x".repeat(600_000);
        },
      },
    });
  });
  await assert.rejects(broker.request("synthetic.items.list.v1", {}), /accessor|data propert/u);
  assert.equal(reads, 0);
  assert.equal(transports, 1);
  await assert.rejects(broker.request("synthetic.items.list.v1", {}), /closed/u);
  assert.equal(transports, 1);
});

for (const kind of ["request", "result", "manifest-v1", "manifest-v2", "policy-v2"]) {
  test(`${kind} returns a detached validated snapshot`, async () => {
    let value;
    let validate;
    let mutate;
    let observe;
    if (kind === "request") {
      value = request({ data: { text: "approved" } });
      validate = validateOperationRequest;
      mutate = () => {
        value.parameters.data.text = "changed";
      };
      observe = (snapshot) => snapshot.parameters.data.text;
    }
    if (kind === "result") {
      value = response({ data: { text: "approved" } });
      validate = validateOperationResponse;
      mutate = () => {
        value.value.data.text = "changed";
      };
      observe = (snapshot) => snapshot.value.data.text;
    }
    if (kind === "manifest-v1" || kind === "manifest-v2") {
      value = await json(
        kind === "manifest-v1"
          ? "../plugins/synthetic-readonly/.tritonai-plugin/plugin.json"
          : "../plugins/synthetic-api-key/.tritonai-plugin/plugin.json",
      );
      value.tools[0].description = "approved";
      validate = kind === "manifest-v1" ? validateManifestV1 : validateBrokerManifest;
      mutate = () => {
        value.tools[0].description = "changed";
      };
      observe = (snapshot) => snapshot.tools[0].description;
    }
    if (kind === "policy-v2") {
      const manifest = await json("../plugins/synthetic-api-key/.tritonai-plugin/plugin.json");
      value = await json("../plugins/synthetic-api-key/.tritonai-plugin/broker-policy.json");
      validate = (policy) => validateBrokerPolicy(policy, manifest);
      mutate = () => {
        value.operations[0].recipe.kind = "changed";
      };
      observe = (snapshot) =>
        snapshot.operations[0].recipe.kind === "synthetic-items-list" ? "approved" : "changed";
    }
    const snapshot = validate(value);
    assert.notEqual(snapshot, value);
    mutate();
    assert.equal(observe(snapshot), "approved");
  });
}
