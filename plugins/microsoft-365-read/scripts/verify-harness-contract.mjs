import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const expectedHead = "a8ea487eaa506a2013f3b32dd3098e37ade1e359";
const packageRoot = Path.resolve(import.meta.dirname, "..");
const repositoryRoot = Path.resolve(packageRoot, "../..");
const harnessRoot = process.env.TRITONAI_HARNESS_ROOT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  typeof harnessRoot === "string" && harnessRoot.length > 0,
  "TRITONAI_HARNESS_ROOT must identify the exact reviewed Harness checkout.",
);
const harness = Path.resolve(harnessRoot);
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: harness, encoding: "utf8" });
assert(git.status === 0, `Harness checkout is unavailable at ${harness}.`);
assert(git.stdout.trim() === expectedHead, `Harness HEAD must be ${expectedHead}.`);
const harnessStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  cwd: harness,
  encoding: "utf8",
});
assert(harnessStatus.status === 0, "Could not verify the Harness working-tree state.");
assert(
  harnessStatus.stdout.trim() === "",
  "Harness worktree must be clean so provider compatibility uses only reviewed contents.",
);

const manifest = JSON.parse(
  await Fs.readFile(Path.join(packageRoot, ".tritonai-plugin", "plugin.json"), "utf8"),
);
const manifestModule = await import(
  pathToFileURL(Path.join(harness, "apps/server/src/integrations/manifest.ts")).href
);
const validatedManifest = manifestModule.validateIntegrationManifest(manifest);
assert(
  manifestModule.manifestCompatibility(validatedManifest).compatible === true,
  "Exact Harness rejected the Microsoft 365 compatibility range.",
);

const providerModule = await import(pathToFileURL(Path.join(packageRoot, "dist/index.js")).href);
assert(
  isDeepStrictEqual(providerModule.manifest, validatedManifest),
  "Compiled provider manifest differs from the exact Harness-validated manifest.",
);
assert(
  providerModule.MICROSOFT_GRAPH_PROVIDER_ID === validatedManifest.provider,
  "Compiled provider ID differs from the manifest provider ID.",
);
assert(
  typeof providerModule.MicrosoftGraphProvider === "function",
  "Compiled provider constructor is missing.",
);
assert(
  Array.isArray(providerModule.MICROSOFT_GRAPH_TOOLS),
  "Compiled tool definitions are missing.",
);
const declaredToolNames = validatedManifest.tools.map(({ name }) => name).toSorted();
const exportedToolNames = providerModule.MICROSOFT_GRAPH_TOOLS.map(({ name }) => name).toSorted();
assert(
  isDeepStrictEqual(exportedToolNames, declaredToolNames),
  "Compiled provider tool set differs from the manifest tool set.",
);
for (const tool of providerModule.MICROSOFT_GRAPH_TOOLS) {
  assert(
    typeof tool.description === "string" &&
      typeof tool.input === "object" &&
      tool.input !== null &&
      tool.readOnly === true &&
      tool.destructive === false &&
      tool.openWorld === true,
    `Compiled tool ${String(tool.name)} does not satisfy the read-only Harness boundary.`,
  );
}

const probeDirectory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "tritonai-graph-contract-"));
try {
  const probe = Path.join(probeDirectory, "provider-compatibility.ts");
  const consumerProbe = Path.join(probeDirectory, "package-consumer.ts");
  const harnessRegistry = Path.join(harness, "apps/server/src/integrations/IntegrationRegistry.ts");
  const harnessSecrets = Path.join(harness, "apps/server/src/auth/ServerSecretStore.ts");
  const providerTypes = Path.join(packageRoot, "dist/index.d.ts");
  const compiler = Path.join(repositoryRoot, "node_modules/.bin/tsc");
  const compilerOptions = [
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
  ];
  await Fs.writeFile(
    consumerProbe,
    [
      `import type { IntegrationProvider, MicrosoftGraphProvider } from ${JSON.stringify(providerTypes)};`,
      "declare const provider: MicrosoftGraphProvider;",
      "const packageConsumer: IntegrationProvider = provider;",
      "void packageConsumer;",
      "",
    ].join("\n"),
  );
  const consumerCompile = spawnSync(compiler, [...compilerOptions, consumerProbe], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert(
    consumerCompile.status === 0,
    `Published declarations do not resolve for an ordinary TypeScript consumer:\n${consumerCompile.stdout}${consumerCompile.stderr}`,
  );
  await Fs.writeFile(
    probe,
    [
      `import type { IntegrationProvider as HarnessProvider } from ${JSON.stringify(harnessRegistry)};`,
      `import type * as HarnessSecretStore from ${JSON.stringify(harnessSecrets)};`,
      `import type { IntegrationSecretStore as PluginSecretStore, MicrosoftGraphProvider } from ${JSON.stringify(providerTypes)};`,
      "declare const provider: MicrosoftGraphProvider;",
      "declare const secrets: HarnessSecretStore.ServerSecretStore['Service'];",
      "const providerCompatibility: HarnessProvider = provider;",
      "const secretCompatibility: PluginSecretStore = secrets;",
      "void providerCompatibility;",
      "void secretCompatibility;",
      "",
    ].join("\n"),
  );
  const compile = spawnSync(compiler, [...compilerOptions, "--allowImportingTsExtensions", probe], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert(
    compile.status === 0,
    `Compiled provider is not structurally assignable to exact Harness v1:\n${compile.stdout}${compile.stderr}`,
  );
} finally {
  await Fs.rm(probeDirectory, { recursive: true, force: true });
}

console.log(`Microsoft 365 provider compatibility passed at Harness ${expectedHead}`);
