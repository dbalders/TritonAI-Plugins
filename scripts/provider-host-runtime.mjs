import assert from "node:assert/strict";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertHarnessEffectPeerContract,
  verifyHarnessEffectRuntime,
} from "./harness-contract.mjs";

// Composition supplies the one host Effect runtime. Probe the unchanged release
// bytes in that consumer context rather than comparing two unrelated development
// installations of Effect (whose Schema AST types can intentionally differ).
export async function stageProviderHostRuntime(packageRoot, harness) {
  const identity = await verifyHarnessEffectRuntime(harness);
  const hostRuntime = await import(
    pathToFileURL(Path.join(harness, "packages/shared/src/pluginHostRuntime.ts")).href
  );
  assertHarnessEffectPeerContract(hostRuntime.EFFECT_HOST_PEER_RANGE);
  const metadata = JSON.parse(await Fs.readFile(Path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(hostRuntime.resolvePluginHostRuntimeDependencies(metadata, identity.version), [
    { name: "effect", version: identity.version, declaration: "peer" },
  ]);
  const effectRoot = await Fs.realpath(Path.join(harness, "apps/server/node_modules/effect"));
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "tritonai-provider-host-contract-"));
  try {
    for (const name of ["package.json", ".tritonai-plugin", "dist"]) {
      await Fs.cp(Path.join(packageRoot, name), Path.join(root, name), {
        recursive: true,
        dereference: false,
      });
    }
    await Fs.mkdir(Path.join(root, "node_modules"));
    await Fs.symlink(effectRoot, Path.join(root, "node_modules/effect"), "junction");
    const load = (name) => import(pathToFileURL(Path.join(effectRoot, "dist", `${name}.js`)).href);
    const [Effect, Option, Schema] = await Promise.all([
      load("Effect"),
      load("Option"),
      load("Schema"),
    ]);
    const providerTypes = Path.join(root, "dist/index.js");
    const providerModule = await import(pathToFileURL(providerTypes).href);
    const originalFetch = globalThis.fetch;
    let networkRequests = 0;
    globalThis.fetch = async () => {
      networkRequests += 1;
      throw new Error("The local host-runtime contract probe must not use the network.");
    };
    return {
      Effect,
      Option,
      Schema,
      identity,
      providerModule,
      providerTypes,
      assertNoNetwork: () => assert.equal(networkRequests, 0),
      close: async () => {
        globalThis.fetch = originalFetch;
        await Fs.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

// Local runtime contract proof only: no credentials or external calls. Live
// authenticated tool output remains a separate packaged-product acceptance gate.
export async function verifyProviderHostRuntime(provider, probe) {
  const { Schema } = probe;
  assert.equal((await provider.status()).state, "not_connected");
  let schemas = 0;
  for (const tool of provider.tools) {
    assert.equal(Schema.toJsonSchemaDocument(tool.input).schema.type, "object");
    await assert.rejects(Schema.decodeUnknownPromise(tool.input)(null));
    schemas += 1;
  }
  const tool = provider.tools.find(({ readOnly }) => readOnly);
  assert.ok(tool, "Provider must expose a read-only contract probe tool.");
  await Schema.decodeUnknownPromise(tool.input)({}, { onExcessProperty: "error" });
  await assert.rejects(
    Schema.decodeUnknownPromise(tool.input)(
      { unexpected_contract_field: true },
      { onExcessProperty: "error" },
    ),
  );
  await assert.rejects(provider.invoke(tool.name, {}), (error) => {
    assert.equal(error.constructor.name, "IntegrationProviderPublicError");
    assert.match(error.message, /connect|session|access|refresh/iu);
    return true;
  });
  await assert.rejects(
    provider.invoke(tool.name, {}, { signal: AbortSignal.abort() }),
    /cancelled/iu,
  );
  probe.assertNoNetwork();
  console.log(
    `${provider.id}: host Effect ${probe.identity.version}; ${schemas} schemas; secret Effect, unauthenticated invocation, and cancellation passed (local contract only)`,
  );
}
