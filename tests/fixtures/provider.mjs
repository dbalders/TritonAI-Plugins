import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { runInNewContext } from "node:vm";
import { createTestHost, sha256 } from "./broker-host.mjs";

export async function fixture(id, options = {}) {
  const root = Path.resolve(import.meta.dirname, "../..", "plugins", id);
  const manifest = JSON.parse(
    await Fs.readFile(Path.join(root, ".tritonai-plugin/plugin.json"), "utf8"),
  );
  const policy = JSON.parse(
    await Fs.readFile(Path.join(root, ".tritonai-plugin/broker-policy.json"), "utf8"),
  );
  const host = createTestHost({
    manifest,
    policy,
    approvedPolicySha256: sha256(policy),
    ...options,
  });
  host.connect("a");
  const { channel, broker } = host.bind("a");
  const source = await Fs.readFile(Path.join(root, "dist/index.mjs"), "utf8");
  // Deliberately missing networking, process and secret APIs. This is a JS test realm, not confinement proof.
  const rawCreate = runInNewContext(
    `${source.replace("export function createIntegrationProvider", "function createIntegrationProvider")}\ncreateIntegrationProvider`,
    { AbortSignal, URL, Object },
  );
  const create = (context) => {
    const worker = rawCreate(context);
    return {
      id: worker.id,
      close: () => worker.close(),
      invoke: async (...args) => JSON.parse(JSON.stringify(await worker.invoke(...args))),
    };
  };
  const provider = create({ broker, configuration: {} });
  return { root, manifest, policy, host, channel, broker, provider, create, source };
}
