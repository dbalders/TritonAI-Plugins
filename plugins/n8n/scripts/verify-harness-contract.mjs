import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { assertTrustedHarnessCheckout } from "../../../scripts/harness-contract.mjs";
import { assertProviderRuntimeDependencies } from "../../../scripts/provider-runtime-dependencies.mjs";

const packageRoot = Path.resolve(import.meta.dirname, "..");
const repositoryRoot = Path.resolve(packageRoot, "../..");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const isPromiseLike = (value) =>
  ((typeof value === "object" && value !== null) || typeof value === "function") &&
  typeof value.then === "function";

const { actualHead, harness } = assertTrustedHarnessCheckout(
  process.env.TRITONAI_HARNESS_ROOT,
  process.env.TRITONAI_HARNESS_COMMIT,
);
const manifest = JSON.parse(
  await Fs.readFile(Path.join(packageRoot, ".tritonai-plugin/plugin.json"), "utf8"),
);
const packageJson = JSON.parse(await Fs.readFile(Path.join(packageRoot, "package.json"), "utf8"));
const manifestModule = await import(
  pathToFileURL(Path.join(harness, "apps/server/src/integrations/manifest.ts")).href
);
const validated = manifestModule.validateIntegrationManifest(manifest);
assertProviderRuntimeDependencies(validated.id, packageJson, validated);
const providerModule = await import(pathToFileURL(Path.join(packageRoot, "dist/index.js")).href);
assert(isDeepStrictEqual(providerModule.manifest, validated), "Compiled n8n manifest differs.");
const provider = providerModule.createIntegrationProvider({
  secrets: {
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    remove: () => Effect.void,
  },
  configuration: { serverUrl: "https://n8n.tritonai.ucsd.edu/mcp-server/http" },
});
assert(
  !isPromiseLike(provider) && provider.id === validated.provider,
  "Invalid n8n provider factory.",
);
assert(
  isDeepStrictEqual(
    validated.tools.map(({ name }) => name).toSorted(),
    providerModule.N8N_TOOLS.map(({ name }) => name).toSorted(),
  ),
  "Compiled n8n tool set differs from the manifest.",
);
for (const providerTool of providerModule.N8N_TOOLS) {
  const manifestTool = validated.tools.find(({ name }) => name === providerTool.name);
  assert(
    manifestTool &&
      providerTool.readOnly === (manifestTool.effect !== "write") &&
      typeof providerTool.destructive === "boolean" &&
      typeof providerTool.idempotent === "boolean" &&
      typeof providerTool.openWorld === "boolean",
    `Tool ${providerTool.name} violates its Harness effect boundary.`,
  );
}

const probeDirectory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "tritonai-n8n-contract-"));
try {
  const probe = Path.join(probeDirectory, "provider-contract.ts");
  const harnessRegistry = Path.join(harness, "apps/server/src/integrations/IntegrationRegistry.ts");
  const harnessSecrets = Path.join(harness, "apps/server/src/auth/ServerSecretStore.ts");
  const providerTypes = Path.join(packageRoot, "dist/index.js");
  await Fs.writeFile(
    probe,
    [
      `import type { IntegrationProvider as HarnessProvider } from ${JSON.stringify(harnessRegistry)};`,
      `import type * as HarnessSecretStore from ${JSON.stringify(harnessSecrets)};`,
      `import { createIntegrationProvider, type IntegrationProviderFactoryContext, type IntegrationSecretStore as PluginSecretStore } from ${JSON.stringify(providerTypes)};`,
      "declare const secrets: HarnessSecretStore.ServerSecretStore['Service'];",
      "const secretCompatibility: PluginSecretStore = secrets;",
      "const factoryContext: IntegrationProviderFactoryContext = { secrets: secretCompatibility, configuration: {} };",
      "const providerCompatibility: HarnessProvider = createIntegrationProvider(factoryContext);",
      "void providerCompatibility; void secretCompatibility;",
    ].join("\n"),
  );
  const compile = spawnSync(
    Path.join(repositoryRoot, "node_modules/.bin/tsc"),
    [
      "--noEmit",
      "--ignoreConfig",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--types",
      "node",
      "--allowImportingTsExtensions",
      probe,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert(
    compile.status === 0,
    `Compiled n8n provider is not assignable to Harness v2:\n${compile.stdout}${compile.stderr}`,
  );
} finally {
  await Fs.rm(probeDirectory, { recursive: true, force: true });
}

console.log(`n8n provider contract passed at Harness ${actualHead}`);
