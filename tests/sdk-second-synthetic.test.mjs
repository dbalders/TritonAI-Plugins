import assert from "node:assert/strict";
import * as Fs from "node:fs/promises";
import test from "node:test";
import { createIntegrationProvider } from "../artifacts/synthetic-api-key/plugin.mjs";
import { createTestHost, sha256 } from "./fixtures/broker-host.mjs";

// Exercise the actual generated artifact with the new host-only credential lifecycle.
test("sealed synthetic SDK2 artifact uses broker-only lifecycle and one admitted write", async () => {
  const manifest = JSON.parse(
    await Fs.readFile(
      new URL("../artifacts/synthetic-api-key/.tritonai-plugin/plugin.json", import.meta.url),
      "utf8",
    ),
  );
  const policy = JSON.parse(
    await Fs.readFile(
      new URL(
        "../artifacts/synthetic-api-key/.tritonai-plugin/broker-policy.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const host = createTestHost({ manifest, policy, approvedPolicySha256: sha256(policy) });
  const flow = host.beginConnect("selected");
  const status = host.submit(flow.flowId, "host-fixture-key");
  assert.equal(JSON.stringify(status).includes("host-fixture-key"), false);
  const { channel, broker } = host.bind("selected");
  const provider = createIntegrationProvider({ broker, configuration: {} });
  await assert.rejects(
    host.invoke(channel, provider, "synthetic.items.put", { id: "one", value: "first" }),
    /approval/u,
  );
  assert.equal(host.journals.length, 0);
  assert.deepEqual(
    await host.invoke(
      channel,
      provider,
      "synthetic.items.put",
      { id: "one", value: "first" },
      { approved: true },
    ),
    { id: "one", value: "first" },
  );
  assert.deepEqual(await host.invoke(channel, provider, "synthetic.items.list", {}), {
    items: [{ id: "one", value: "first" }],
  });
  assert.equal(host.journals.length, 1);
  host.disconnect("selected");
  await assert.rejects(host.invoke(channel, provider, "synthetic.items.list", {}), /revoked/u);
});
