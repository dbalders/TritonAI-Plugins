import assert from "node:assert/strict";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import test from "node:test";

import { validateManifestV1 } from "../packages/plugin-sdk/index.mjs";
import {
  BROKER_PROTOCOL,
  validateBrokerManifest,
  validateBrokerPolicy,
  validateOperationRequest,
  createOperationBroker,
  validateOperationResponse,
} from "../packages/plugin-sdk/broker.mjs";
import {
  buildPluginArtifact,
  inspectPluginModule,
  verifyPluginArtifact,
} from "../scripts/sdk-artifact.mjs";
import { createTestHost, sha256 } from "./fixtures/broker-host.mjs";

import { fixture } from "./fixtures/provider.mjs";

for (const id of ["synthetic-api-key", "kuali-build"]) {
  test(`${id}: SDK2 artifact binds policy, entry and exact schemas; SDK1 fails closed`, async (t) => {
    const { root, manifest, policy } = await fixture(id);
    assert.equal(validateBrokerManifest(manifest), manifest);
    assert.equal(validateBrokerPolicy(policy, manifest), policy);
    assert.throws(() => validateManifestV1(manifest), /unsupported|Unsupported/u);
    const temp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "plugin-broker-artifact-"));
    t.after(() => Fs.rm(temp, { recursive: true, force: true }));
    const output = Path.join(temp, "artifact");
    await buildPluginArtifact(root, output);
    await assert.rejects(
      verifyPluginArtifact(output, { hostNodeVersion: "24.13.1", workerNodeVersion: "24.13.1" }),
      /incompatible/u,
    );
    await assert.rejects(
      verifyPluginArtifact(output, {
        sdkApiMajor: 2,
        hostContractLevel: 3,
        hostNodeVersion: "24.13.1",
      }),
      /actual worker/u,
    );
    const verified = await verifyPluginArtifact(output, {
      sdkApiMajor: 2,
      hostContractLevel: 3,
      hostNodeVersion: "24.13.1",
      workerNodeVersion: "24.13.1",
    });
    assert.equal(verified.descriptor.format, "tritonai.plugin-artifact/v2");
    assert.deepEqual(verified.descriptor.target.environments, ["isolated-worker"]);
    assert.equal(verified.descriptor.target.nodeBuiltins.length, 0);
    assert.equal(verified.descriptor.broker.protocol, BROKER_PROTOCOL);
    assert.equal(verified.descriptor.broker.policy.id, policy.id);
    const policyPath = Path.join(output, ".tritonai-plugin/broker-policy.json");
    await Fs.appendFile(policyPath, " ");
    await assert.rejects(
      verifyPluginArtifact(output, {
        sdkApiMajor: 2,
        hostContractLevel: 3,
        hostNodeVersion: "24.13.1",
        workerNodeVersion: "24.13.1",
      }),
      /mismatch/u,
    );
  });

  test(`${id}: provider accepts broker only and has no connection or raw credential lifecycle`, async () => {
    const { create, provider, broker } = await fixture(id);
    assert.deepEqual(Object.keys(provider).sort(), ["close", "id", "invoke"]);
    assert.throws(() => create({ secrets: {}, configuration: {} }));
    assert.throws(() => create({ broker, secrets: {}, configuration: {} }));
    assert.throws(() => create({ broker: { ...broker, get: () => "secret" }, configuration: {} }));
    const source = (await fixture(id)).source;
    await inspectPluginModule(source, { broker: true });
    for (const dependency of [
      "fetch('https://example.invalid')",
      "process.env.KEY",
      "globalThis.fetch",
      "secrets.get('api-key')",
      "require('node:http')",
    ]) {
      await assert.rejects(
        inspectPluginModule(`${source}\n${dependency};`, { broker: true }),
        /forbidden/u,
      );
    }
    await assert.rejects(
      inspectPluginModule(`import fs from 'node:fs';\n${source}`, { broker: true }),
      /import/u,
    );
  });
}

test("broker request is strict JSON with no worker authority or transport escape fields", () => {
  const request = {
    protocol: BROKER_PROTOCOL,
    requestId: 1,
    kind: "operation",
    operationId: "synthetic.items.list.v1",
    parameters: {},
  };
  assert.equal(validateOperationRequest(request), request);
  for (const field of [
    "url",
    "headers",
    "connectionId",
    "generation",
    "pluginId",
    "invocationId",
    "approved",
    "token",
    "method",
    "proxy",
  ]) {
    assert.throws(
      () => validateOperationRequest({ ...request, [field]: "untrusted" }),
      /unsupported/u,
    );
  }
  for (const requestId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => validateOperationRequest({ ...request, requestId }));
  assert.throws(
    () => validateOperationRequest({ ...request, parameters: { body: "x".repeat(524_288) } }),
    /byte/u,
  );
  assert.throws(() =>
    validateOperationRequest({
      ...request,
      parameters: {
        get value() {
          throw new Error("accessor");
        },
      },
    }),
  );
});

test("declarative recipe cannot self-grant a broader destination or capability", async () => {
  const { manifest, policy } = await fixture("kuali-build");
  const changed = structuredClone(policy);
  changed.transport.origin = "https://attacker.example";
  assert.throws(
    () => createTestHost({ manifest, policy: changed, approvedPolicySha256: sha256(policy) }),
    /independently host approved/u,
  );
  changed.transport.headers = { authorization: "worker-token" };
  assert.throws(() => validateBrokerPolicy(changed, manifest), /unsupported/u);
  const escalation = structuredClone(policy);
  escalation.operations[0].effect = "write";
  assert.throws(() => validateBrokerPolicy(escalation, manifest), /mismatch/u);
  const extra = structuredClone(manifest);
  extra.broker.operations.push({ id: "generic.proxy.v1", tool: "generic.proxy" });
  assert.throws(() => validateBrokerManifest(extra), /exactly/u);
});

test("synthetic broker read/write keeps fixture credentials host-side and connection-scoped", async () => {
  const { host, channel, provider, create } = await fixture("synthetic-api-key");
  const flow = host.beginConnect("b");
  const status = host.completeOAuth(flow.flowId, {
    access_token: "host-only-token-canary",
    refresh_token: "host-only-refresh-canary",
  });
  assert.equal(JSON.stringify(status).includes("canary"), false);
  assert.throws(() => host.submit(flow.flowId, "replay"), /expired/u);
  const b = host.bind("b");
  const other = create({ configuration: {}, broker: b.broker });
  await host.invoke(
    channel,
    provider,
    "synthetic.items.put",
    { id: "one", value: "first" },
    { approved: true },
  );
  assert.deepEqual(await host.invoke(channel, provider, "synthetic.items.list", {}), {
    items: [{ id: "one", value: "first" }],
  });
  assert.deepEqual(await host.invoke(b.channel, other, "synthetic.items.list", {}), { items: [] });
  assert.equal(host.journals.length, 1);
  assert.equal(host.journals[0].state, "confirmed");
  host.disconnect("a");
  await assert.rejects(host.invoke(channel, provider, "synthetic.items.list", {}), /revoked/u);
  host.connect("a");
  await assert.rejects(host.invoke(channel, provider, "synthetic.items.list", {}), /generation/u);
});

test("host model rejects read-to-write, changed payload, stale approvals, duplicate requests and operation replay", async () => {
  const { host, channel, broker } = await fixture("synthetic-api-key");
  const input = { id: "one", value: "approved" };
  const malicious = (invoke) => ({ invoke });
  await assert.rejects(
    host.invoke(
      channel,
      malicious(() => broker.request("synthetic.items.put.v1", input)),
      "synthetic.items.list",
      {},
    ),
    /operation\/tool/u,
  );
  await assert.rejects(
    host.invoke(
      channel,
      malicious(() => broker.request("synthetic.items.put.v1", { ...input, value: "changed" })),
      "synthetic.items.put",
      input,
      { approved: true },
    ),
    /payload/u,
  );
  await assert.rejects(
    host.invoke(
      channel,
      malicious(() => broker.request("synthetic.items.put.v1", input)),
      "synthetic.items.put",
      input,
    ),
    /approval/u,
  );
  await assert.rejects(
    host.invoke(
      channel,
      malicious(() => broker.request("synthetic.items.put.v1", input)),
      "synthetic.items.put",
      input,
      { approvedPayloadSha256: sha256({ ...input, id: "different-destination" }) },
    ),
    /approval/u,
  );
  await assert.rejects(
    host.invoke(
      channel,
      malicious(() => broker.request("synthetic.items.delete.v1", input)),
      "synthetic.items.put",
      input,
      { approved: true },
    ),
    /operation\/tool/u,
  );
  await assert.rejects(
    host.invoke(
      channel,
      malicious(async () => {
        await broker.request("synthetic.items.put.v1", input);
        return broker.request("synthetic.items.put.v1", input);
      }),
      "synthetic.items.put",
      input,
      { approved: true },
    ),
    /one operation/u,
  );
  await assert.rejects(
    host.request(channel, {
      protocol: BROKER_PROTOCOL,
      requestId: 1,
      kind: "operation",
      operationId: "synthetic.items.list.v1",
      parameters: {},
    }),
    /replay/u,
  );
  assert.equal(host.journals.length, 1);
});

test("host model denies cancelled, ended, retired-worker and capability-restricted requests", async () => {
  const { host, channel, broker, create } = await fixture("synthetic-api-key");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    host.invoke(
      channel,
      { invoke: () => broker.request("synthetic.items.list.v1", {}) },
      "synthetic.items.list",
      {},
      { signal: controller.signal },
    ),
    /cancelled/u,
  );
  await assert.rejects(broker.request("synthetic.items.list.v1", {}), /expired/u);
  host.close(channel);
  await assert.rejects(
    host.invoke(
      channel,
      { invoke: () => broker.request("synthetic.items.list.v1", {}) },
      "synthetic.items.list",
      {},
    ),
    /revoked/u,
  );
  host.connect("read", { capabilities: ["synthetic-api-key.read"] });
  const read = host.bind("read");
  const provider = create({ broker: read.broker, configuration: {} });
  await assert.rejects(
    host.invoke(
      read.channel,
      provider,
      "synthetic.items.put",
      { id: "one", value: "one" },
      { approved: true },
    ),
    /capability/u,
  );
  assert.equal(host.journals.length, 0);
});

test("SDK broker helper correlates strict frames, serializes work and never replays broken channels", async () => {
  const frames = [];
  let finish;
  const broker = createOperationBroker((request) => {
    frames.push(request);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = broker.request("synthetic.items.list.v1", {});
  await assert.rejects(broker.request("synthetic.items.list.v1", {}), /active operation/u);
  finish({ protocol: BROKER_PROTOCOL, requestId: 1, kind: "result", value: { items: [] } });
  assert.deepEqual(await first, { items: [] });
  const second = broker.request("synthetic.items.list.v1", {});
  finish({ protocol: BROKER_PROTOCOL, requestId: 1, kind: "result", value: {} });
  await assert.rejects(second, /mismatch/u);
  await assert.rejects(broker.request("synthetic.items.list.v1", {}), /closed/u);
  assert.deepEqual(
    frames.map((frame) => frame.requestId),
    [1, 2],
  );
  assert.equal(JSON.stringify(frames).includes("connectionId"), false);
  assert.throws(
    () =>
      validateOperationResponse({
        protocol: BROKER_PROTOCOL,
        requestId: 1,
        kind: "result",
        value: {},
        access_token: "secret",
      }),
    /unsupported/u,
  );
  const ambiguous = createOperationBroker(async (request) => ({
    protocol: BROKER_PROTOCOL,
    requestId: request.requestId,
    kind: "error",
    error: { code: "transport_lost", message: "Outcome unknown.", outcome: "unknown" },
  }));
  await assert.rejects(
    ambiguous.request("synthetic.items.put.v1", { id: "one", value: "one" }),
    (error) => error._tag === "ExternalCommitOutcomeUnknown" && error.retryable === false,
  );
});
