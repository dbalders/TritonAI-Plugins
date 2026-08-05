import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import { discoverPluginDirectories } from "./plugin-directories.mjs";
import { assertTrustedHarnessCheckout, verifyHarnessEffectRuntime } from "./harness-contract.mjs";
import {
  assertProviderRuntimeDependencies,
  PROVIDER_EFFECT_PEER_RANGE,
} from "./provider-runtime-dependencies.mjs";

const harnessRoot = process.env.TRITONAI_HARNESS_ROOT;
const expectedHarnessCommit = process.env.TRITONAI_HARNESS_COMMIT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const { actualHead, harness } = assertTrustedHarnessCheckout(harnessRoot, expectedHarnessCommit);

const registry = await Fs.readFile(
  Path.join(harness, "apps/server/src/integrations/IntegrationRegistry.ts"),
  "utf8",
);
const tool = await Fs.readFile(
  Path.join(harness, "apps/server/src/integrations/IntegrationTool.ts"),
  "utf8",
);
const secret = await Fs.readFile(
  Path.join(harness, "apps/server/src/integrations/IntegrationSecretStore.ts"),
  "utf8",
);
const productionBuiltins = await Fs.readFile(
  Path.join(harness, "apps/server/src/integrations/productionBuiltins.ts"),
  "utf8",
);
const { version: harnessEffectVersion } = await verifyHarnessEffectRuntime(harness);

for (const fragment of [
  "beginCommit(): Promise<AbortSignal>",
  "beginCommit?(): Promise<AbortSignal>",
  "status(context?: IntegrationInvocationContext)",
  "prepare?(context: IntegrationLifecycleContext)",
  "context?: IntegrationLifecycleContext",
  "context?: IntegrationInvocationContext",
  "readonly manifest: IntegrationManifest",
  "readonly sourceRoot?: string",
  "readonly bundledFiles?: Readonly<Record<string, string | Uint8Array>>",
  "close?(): Promise<void>",
  '"authorization_url"',
]) {
  assert(registry.includes(fragment), `Harness provider contract drifted: missing ${fragment}`);
}
for (const fragment of [
  "readonly input: Schema.Decoder<unknown>",
  "readonly destructive?: boolean",
  "readonly idempotent?: boolean",
  'onExcessProperty: "error"',
]) {
  assert(tool.includes(fragment), `Harness tool contract drifted: missing ${fragment}`);
}
assert(secret.includes("integration-${integrationId}--"), "Harness secret namespace drifted.");
for (const fragment of [
  "readonly createIntegrationProvider?:",
  "loaded.createIntegrationProvider({",
  "provider factory must be synchronous",
  "created.id !== packageManifest.provider",
]) {
  assert(
    productionBuiltins.includes(fragment),
    `Harness provider factory contract drifted: missing ${fragment}`,
  );
}
const manifestModule = await import(
  pathToFileURL(Path.join(harness, "apps/server/src/integrations/manifest.ts")).href
);
const hostRuntimeModule = await import(
  pathToFileURL(Path.join(harness, "packages/shared/src/pluginHostRuntime.ts")).href
);
assert(
  hostRuntimeModule.EFFECT_HOST_PEER_RANGE === PROVIDER_EFFECT_PEER_RANGE,
  "Plugins and Harness disagree on the canonical Effect peer contract.",
);
const frameworkProbe = {
  apiVersion: "tritonai.harness/v2",
  kind: "IntegrationPlugin",
  manifestVersion: 2,
  id: "framework-probe",
  name: "Framework Probe",
  description: "Validates the repository's generic Harness v2 manifest boundary.",
  version: "1.0.0",
  capabilities: [
    {
      id: "probe.read",
      displayName: "Read probe",
      description: "Read-only probe capability.",
      access: "default",
    },
  ],
  tools: [],
  skills: [
    {
      name: "framework-probe",
      description: "Framework probe skill.",
      capabilities: ["probe.read"],
    },
  ],
};
const validated = manifestModule.validateIntegrationManifest(frameworkProbe);
assert(validated.id === frameworkProbe.id, "Exact Harness rejected the framework probe manifest.");

const pluginsRoot = Path.resolve(import.meta.dirname, "..", "plugins");
for (const directory of await discoverPluginDirectories(pluginsRoot)) {
  const packageRoot = Path.join(pluginsRoot, directory);
  const manifestPath = Path.join(packageRoot, ".tritonai-plugin", "plugin.json");
  const manifest = JSON.parse(await Fs.readFile(manifestPath, "utf8"));
  const packageJson = JSON.parse(await Fs.readFile(Path.join(packageRoot, "package.json"), "utf8"));
  const harnessValidated = manifestModule.validateIntegrationManifest(manifest);
  assert(harnessValidated.id === directory, `${directory}: exact Harness rejected the plugin id.`);
  assertProviderRuntimeDependencies(directory, packageJson, harnessValidated);
  if (harnessValidated.provider !== undefined) {
    assert(
      isDeepStrictEqual(
        hostRuntimeModule.resolvePluginHostRuntimeDependencies(packageJson, harnessEffectVersion),
        [
          {
            name: "effect",
            version: harnessEffectVersion,
            declaration: "peer",
          },
        ],
      ),
      `${directory}: exact Harness rejected the provider runtime contract.`,
    );
    const providerModule = await import(
      pathToFileURL(Path.join(packageRoot, "dist", "index.js")).href
    );
    assert(
      isDeepStrictEqual(providerModule.manifest, harnessValidated),
      `${directory}: compiled provider must export its exact validated manifest as manifest.`,
    );
    assert(
      typeof providerModule.createIntegrationProvider === "function",
      `${directory}: compiled provider must export createIntegrationProvider.`,
    );
    const contract = spawnSync(
      "pnpm",
      ["--filter", packageJson.name, "--fail-if-no-match", "run", "contract:harness"],
      {
        cwd: Path.resolve(pluginsRoot, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          TRITONAI_HARNESS_ROOT: harness,
        },
      },
    );
    assert(
      contract.status === 0,
      `${directory}: provider contract proof failed.\n${contract.stderr || contract.stdout}`,
    );
  }
}

console.log(`exact Harness v2 framework checks passed at ${actualHead}`);
