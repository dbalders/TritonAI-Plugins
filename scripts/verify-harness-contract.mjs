import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import { discoverPluginDirectories } from "./plugin-directories.mjs";
import { REVIEWED_HARNESS_COMMIT } from "./reviewed-harness.mjs";

const harnessRoot = process.env.TRITONAI_HARNESS_ROOT;
const expectedHarnessCommit = process.env.TRITONAI_HARNESS_COMMIT;
if (!harnessRoot) {
  throw new Error(
    "TRITONAI_HARNESS_ROOT must identify a clean checkout at the exact reviewed Harness head.",
  );
}
if (!/^[a-f0-9]{40}$/u.test(expectedHarnessCommit ?? "")) {
  throw new Error("TRITONAI_HARNESS_COMMIT must be the full reviewed Harness commit SHA.");
}
if (expectedHarnessCommit !== REVIEWED_HARNESS_COMMIT) {
  throw new Error(
    `TRITONAI_HARNESS_COMMIT must match the repository-reviewed Harness commit ${REVIEWED_HARNESS_COMMIT}.`,
  );
}
const harness = Path.resolve(harnessRoot);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: harness, encoding: "utf8" });
assert(git.status === 0, `Harness checkout is unavailable at ${harness}.`);
const actualHead = git.stdout.trim();
assert(/^[a-f0-9]{40}$/u.test(actualHead), "Harness HEAD must be a full commit SHA.");
assert(
  actualHead === REVIEWED_HARNESS_COMMIT,
  `Harness checkout is at ${actualHead}, expected ${REVIEWED_HARNESS_COMMIT}.`,
);
const harnessStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  cwd: harness,
  encoding: "utf8",
});
assert(harnessStatus.status === 0, "Could not verify Harness working-tree state.");
assert(
  harnessStatus.stdout.trim() === "",
  "Harness worktree must be clean so the contract is proven against one immutable commit.",
);

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
const harnessPackage = JSON.parse(await Fs.readFile(Path.join(harness, "package.json"), "utf8"));

for (const fragment of [
  "beginCommit(): Promise<AbortSignal>",
  "status(context?: IntegrationInvocationContext)",
  "prepare?(context: IntegrationLifecycleContext)",
  "context?: IntegrationLifecycleContext",
  "context?: IntegrationInvocationContext",
  "readonly manifest: IntegrationManifest",
  "readonly sourceRoot?: string",
  "readonly bundledFiles?: Readonly<Record<string, string | Uint8Array>>",
  "close?(): Promise<void>",
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
assert(
  harnessPackage.workspaces?.catalog?.effect === "4.0.0-beta.78",
  "Harness Effect pin drifted.",
);

const manifestModule = await import(
  pathToFileURL(Path.join(harness, "apps/server/src/integrations/manifest.ts")).href
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
  if (harnessValidated.tools.length > 0) {
    const providerModule = await import(
      pathToFileURL(Path.join(packageRoot, "dist", "index.js")).href
    );
    assert(
      isDeepStrictEqual(providerModule.manifest, harnessValidated),
      `${directory}: compiled provider must export its exact validated manifest as manifest.`,
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
          TRITONAI_PLUGIN_MANIFEST: manifestPath,
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
