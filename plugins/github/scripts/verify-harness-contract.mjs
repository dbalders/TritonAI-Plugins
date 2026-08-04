import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { assertProviderRuntimeDependencies } from "../../../scripts/provider-runtime-dependencies.mjs";
import { REVIEWED_HARNESS_COMMIT } from "../../../scripts/reviewed-harness.mjs";

const packageRoot = Path.resolve(import.meta.dirname, "..");
const repositoryRoot = Path.resolve(packageRoot, "../..");
const harnessRoot = process.env.TRITONAI_HARNESS_ROOT;
const expectedHarnessCommit = process.env.TRITONAI_HARNESS_COMMIT;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const isPromiseLike = (value) =>
  ((typeof value === "object" && value !== null) || typeof value === "function") &&
  typeof value.then === "function";

assert(
  typeof harnessRoot === "string" && harnessRoot.length > 0,
  "TRITONAI_HARNESS_ROOT must identify the exact reviewed Harness checkout.",
);
assert(
  /^[a-f0-9]{40}$/u.test(expectedHarnessCommit ?? ""),
  "TRITONAI_HARNESS_COMMIT must be the full reviewed Harness commit SHA.",
);
assert(
  expectedHarnessCommit === REVIEWED_HARNESS_COMMIT,
  `TRITONAI_HARNESS_COMMIT must match the repository-reviewed Harness commit ${REVIEWED_HARNESS_COMMIT}.`,
);
const harness = Path.resolve(harnessRoot);
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: harness, encoding: "utf8" });
assert(
  git.status === 0 && git.stdout.trim() === REVIEWED_HARNESS_COMMIT,
  `Harness checkout must be at ${REVIEWED_HARNESS_COMMIT}.`,
);
const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  cwd: harness,
  encoding: "utf8",
});
assert(status.status === 0 && status.stdout.trim() === "", "Harness worktree must be clean.");

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
assert(
  isDeepStrictEqual(providerModule.manifest, validated),
  "Compiled provider manifest differs from exact Harness validation.",
);
const provider = providerModule.createIntegrationProvider({
  secrets: {
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    remove: () => Effect.void,
  },
  configuration: { clientId: "Ov23li1234567890abcd" },
});
assert(
  !isPromiseLike(provider) && provider.id === validated.provider,
  "Compiled provider factory is not synchronous or has the wrong id.",
);
const declared = validated.tools.map(({ name }) => name).toSorted();
const exported = providerModule.GITHUB_TOOLS.map(({ name }) => name).toSorted();
assert(
  isDeepStrictEqual(declared, exported),
  "Compiled GitHub tool set differs from the manifest.",
);
for (const providerTool of providerModule.GITHUB_TOOLS) {
  const manifestTool = validated.tools.find(({ name }) => name === providerTool.name);
  assert(
    manifestTool &&
      providerTool.readOnly === (manifestTool.effect !== "write") &&
      typeof providerTool.destructive === "boolean" &&
      typeof providerTool.idempotent === "boolean" &&
      providerTool.openWorld === true,
    `Tool ${providerTool.name} violates its Harness effect boundary.`,
  );
}

const probeDirectory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "tritonai-github-contract-"));
try {
  const probe = Path.join(probeDirectory, "provider-contract.ts");
  const harnessRegistry = Path.join(harness, "apps/server/src/integrations/IntegrationRegistry.ts");
  const harnessSecrets = Path.join(harness, "apps/server/src/auth/ServerSecretStore.ts");
  const providerTypes = Path.join(packageRoot, "dist/index.js");
  const compiler = Path.join(repositoryRoot, "node_modules/.bin/tsc");
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
    compiler,
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
    `Compiled provider is not structurally assignable to Harness v2:\n${compile.stdout}${compile.stderr}`,
  );
} finally {
  await Fs.rm(probeDirectory, { recursive: true, force: true });
}

console.log(`GitHub provider contract passed at Harness ${REVIEWED_HARNESS_COMMIT}`);
