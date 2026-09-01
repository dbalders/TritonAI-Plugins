import assert from "node:assert/strict";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import test from "node:test";

import { buildPluginArtifact, instantiatePluginArtifact } from "../scripts/sdk-artifact.mjs";

const source = Path.resolve(import.meta.dirname, "..", "plugins", "synthetic-api-key");

test("second SDK plugin exercises API-key lifecycle and read-write commits", async (t) => {
  const temporary = await Fs.mkdtemp(Path.join(Os.tmpdir(), "tritonai-sdk-api-key-"));
  t.after(() => Fs.rm(temporary, { recursive: true, force: true }));
  const artifact = Path.join(temporary, "artifact");
  await buildPluginArtifact(source, artifact);

  const values = new Map();
  const secrets = {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => values.set(name, value),
    remove: async (name) => values.delete(name),
  };
  const { provider } = await instantiatePluginArtifact(artifact, {
    configuration: {},
    secrets,
  });
  const signal = AbortSignal.timeout(5_000);
  const noCommit = () => Promise.reject(new Error("unexpected commit"));
  assert.equal((await provider.status({ signal })).state, "not_connected");
  assert.deepEqual(
    await provider.connect(["synthetic-api-key.read"], { signal, beginCommit: noCommit }),
    {
      kind: "api_key",
      flowId: "synthetic-api-key",
      label: "Synthetic API key",
      placeholder: "synthetic_test_key",
      message: "Enter any non-empty synthetic API key.",
    },
  );

  let commits = 0;
  const beginCommit = async () => {
    commits += 1;
    return signal;
  };
  await provider.connect(
    ["synthetic-api-key.read", "synthetic-api-key.write"],
    { signal, beginCommit },
    { kind: "api_key", flowId: "synthetic-api-key", value: "fixture-key" },
  );
  assert.equal(commits, 1);
  assert.equal((await provider.status({ signal })).state, "connected");
  await assert.rejects(
    provider.invoke(
      "synthetic.items.put",
      { id: "one", value: "first" },
      { signal, writeApproved: false, beginCommit: noCommit },
    ),
    (error) => error?._tag === "PluginFailure" && error.code === "write_not_approved",
  );
  assert.deepEqual(
    await provider.invoke(
      "synthetic.items.put",
      { id: "one", value: "first" },
      { signal, writeApproved: true, beginCommit },
    ),
    { id: "one", value: "first" },
  );
  assert.equal(commits, 2);
  assert.deepEqual(
    await provider.invoke(
      "synthetic.items.list",
      {},
      { signal, writeApproved: false, beginCommit: noCommit },
    ),
    { items: [{ id: "one", value: "first" }] },
  );
  await provider.disconnect({ signal, beginCommit });
  assert.equal(commits, 3);
  assert.equal((await provider.status({ signal })).state, "not_connected");
});
