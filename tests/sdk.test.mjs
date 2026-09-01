import assert from "node:assert/strict";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  externalCommitOutcomeUnknown,
  validateManifestV1,
} from "../packages/plugin-sdk/index.mjs";
import {
  ARTIFACT_LIMITS,
  assertSafeRelativePaths,
  assertSelfContainedModule,
  buildPluginArtifact,
  instantiatePluginArtifact,
  loadPluginArtifact,
  verifyPluginArtifact,
} from "../scripts/sdk-artifact.mjs";

const repository = Path.resolve(import.meta.dirname, "..");
const conformancePlugin = Path.join(repository, "plugins", "synthetic-readonly");

async function artifactSnapshot(root) {
  const snapshot = new Map();
  async function walk(directory) {
    for (const entry of await Fs.readdir(directory, { withFileTypes: true })) {
      const path = Path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else snapshot.set(Path.relative(root, path), await Fs.readFile(path));
    }
  }
  await walk(root);
  return snapshot;
}

async function temporaryDirectory(t) {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "tritonai-sdk-test-"));
  t.after(() => Fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFixture(root, overrides = {}) {
  const manifest = {
    apiVersion: "tritonai.plugin/v1",
    kind: "IntegrationPlugin",
    manifestVersion: 1,
    id: "fixture-reader",
    name: "Fixture Reader",
    description: "A sealed artifact fixture.",
    version: "1.0.0",
    sdk: { apiMajor: 1, requiredHostContractLevel: 1 },
    entry: "dist/index.mjs",
    provider: "fixture-reader",
    configurationSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    capabilities: [
      {
        id: "fixture.read",
        displayName: "Read fixture",
        description: "Read fixture data.",
        access: "default",
      },
    ],
    tools: [
      {
        name: "fixture.read",
        displayName: "Read fixture",
        description: "Read fixture data.",
        capabilities: ["fixture.read"],
        effect: "read",
        destructive: false,
        idempotent: true,
        openWorld: false,
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ],
    skills: [],
    ...overrides.manifest,
  };
  const packageJson = {
    name: `@tritonai/plugin-${manifest.id}`,
    version: manifest.version,
    private: true,
    type: "module",
    ...overrides.packageJson,
  };
  const entry =
    overrides.entry ??
    'export function createIntegrationProvider() { return { id: "fixture-reader", async status() { return { state: "connected", accountLabel: null, grantedCapabilities: ["fixture.read"], message: null }; }, async invoke() { return null; } }; }\n';
  await Fs.mkdir(Path.join(root, ".tritonai-plugin"), { recursive: true });
  await Fs.mkdir(Path.join(root, "dist"), { recursive: true });
  await Fs.writeFile(Path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await Fs.writeFile(
    Path.join(root, ".tritonai-plugin", "plugin.json"),
    `${canonicalJson(manifest)}\n`,
  );
  await Fs.writeFile(Path.join(root, "dist", "index.mjs"), entry);
  return manifest;
}

test("SDK v1 validates strict data-only manifests and structural boundary errors", async () => {
  const value = JSON.parse(
    await Fs.readFile(Path.join(conformancePlugin, ".tritonai-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(validateManifestV1(value).tools[0].effect, "read");
  assert.throws(() => validateManifestV1({ ...value, extra: true }), /unsupported fields/u);
  assert.throws(
    () =>
      validateManifestV1({
        ...value,
        tools: [
          {
            ...value.tools[0],
            inputSchema: { ...value.tools[0].inputSchema, $ref: "https://example.test/schema" },
          },
        ],
      }),
    /only this schema document/u,
  );
  assert.throws(
    () =>
      validateManifestV1({
        ...value,
        tools: [
          {
            ...value.tools[0],
            inputSchema: {
              ...value.tools[0].inputSchema,
              $defs: { loop: { $ref: "#/$defs/loop" } },
            },
          },
        ],
      }),
    /recursive reference graph/u,
  );
  assert.throws(
    () =>
      validateManifestV1({
        ...value,
        tools: [
          {
            ...value.tools[0],
            inputSchema: { ...value.tools[0].inputSchema, $ref: "#/$defs/missing" },
          },
        ],
      }),
    /does not resolve/u,
  );
  assert.throws(
    () =>
      validateManifestV1({
        ...value,
        tools: [
          {
            ...value.tools[0],
            inputSchema: { ...value.tools[0].inputSchema, properties: [] },
          },
        ],
      }),
    /properties must be an object/u,
  );
  assert.deepEqual(externalCommitOutcomeUnknown(), {
    _tag: "ExternalCommitOutcomeUnknown",
    code: "external_commit_outcome_unknown",
    message: "The external commit outcome is unknown.",
    retryable: false,
  });
  const sdkRuntime = await Fs.readFile(
    Path.join(repository, "packages", "plugin-sdk", "index.mjs"),
    "utf8",
  );
  const sdkTypes = await Fs.readFile(
    Path.join(repository, "packages", "plugin-sdk", "index.d.ts"),
    "utf8",
  );
  assert.doesNotMatch(sdkRuntime, /(?:from|import\s*)["']effect(?:\/|["'])/u);
  assert.doesNotMatch(sdkTypes, /from\s*["']effect(?:\/|["'])/u);
});

test("sealed artifact output is byte-for-byte deterministic and executable", async (t) => {
  const temporary = await temporaryDirectory(t);
  const outputs = [Path.join(temporary, "one"), Path.join(temporary, "two")];
  await buildPluginArtifact(conformancePlugin, outputs[0]);
  await buildPluginArtifact(conformancePlugin, outputs[1]);
  const [left, right] = await Promise.all(outputs.map(artifactSnapshot));
  assert.deepEqual([...left.keys()], [...right.keys()]);
  for (const [path, bytes] of left) assert(bytes.equals(right.get(path)), `${path} differs`);
  assert(left.has("skills/synthetic-readonly/SKILL.md"));

  const descriptor = JSON.parse(left.get("artifact.json").toString("utf8"));
  assert.deepEqual(descriptor.target, {
    architecture: "any",
    environments: ["electron-main", "server"],
    module: "esm",
    node: ">=24.13.1 <25",
    nodeBuiltins: [],
    platform: "any",
    runtime: "node",
  });

  const beginCommit = () =>
    Promise.reject(new Error("read-only plugin crossed the write boundary"));
  const { provider, manifest } = await instantiatePluginArtifact(outputs[0], {
    configuration: {},
    secrets: {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
    },
  });
  assert.equal(manifest.id, "synthetic-readonly");
  const result = await provider.invoke(
    "synthetic.records.list",
    { topic: "alpha", limit: 2 },
    { signal: AbortSignal.timeout(5_000), writeApproved: false, beginCommit },
  );
  assert.deepEqual(result, {
    records: [
      { id: "alpha-1", topic: "alpha" },
      { id: "alpha-2", topic: "alpha" },
    ],
  });
});

test("artifact compatibility and byte integrity fail before module import", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = Path.join(temporary, "source");
  const output = Path.join(temporary, "artifact");
  await writeFixture(source, {
    entry:
      "globalThis.__tritonaiSdkImported = true; export async function createIntegrationProvider() { return {}; }\n",
  });
  await buildPluginArtifact(source, output);
  const descriptorPath = Path.join(output, "artifact.json");
  const descriptor = JSON.parse(await Fs.readFile(descriptorPath, "utf8"));
  descriptor.sdk.apiMajor = 99;
  await Fs.writeFile(descriptorPath, `${canonicalJson(descriptor)}\n`);
  delete globalThis.__tritonaiSdkImported;
  await assert.rejects(() => loadPluginArtifact(output), /API major/u);
  assert.equal(globalThis.__tritonaiSdkImported, undefined);

  descriptor.sdk.apiMajor = 1;
  await Fs.writeFile(descriptorPath, `${canonicalJson(descriptor)}\n`);
  await Fs.appendFile(Path.join(output, "plugin.mjs"), "// tampered\n");
  await assert.rejects(() => loadPluginArtifact(output), /(size|digest) mismatch/u);
  assert.equal(globalThis.__tritonaiSdkImported, undefined);
});

test("host contract levels are monotonic", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = Path.join(temporary, "source");
  const output = Path.join(temporary, "artifact");
  await writeFixture(source, { manifest: { sdk: { apiMajor: 1, requiredHostContractLevel: 2 } } });
  await buildPluginArtifact(source, output);
  await assert.rejects(() => verifyPluginArtifact(output), /newer host contract/u);
  await assert.doesNotReject(() =>
    verifyPluginArtifact(output, { sdkApiMajor: 1, hostContractLevel: 2 }),
  );
  await assert.doesNotReject(() =>
    verifyPluginArtifact(output, { sdkApiMajor: 1, hostContractLevel: 3 }),
  );
});

test("source inspection admits declared Node builtins and rejects unresolved dependencies", async (t) => {
  assert.deepEqual(await assertSelfContainedModule('import fs from "node:fs";\n'), ["node:fs"]);
  await assert.rejects(
    () => assertSelfContainedModule("export const url = import.meta.url;\n"),
    /import\.meta/u,
  );
  await assert.rejects(
    () => assertSelfContainedModule('const fs = require("node:fs");\n'),
    /CommonJS/u,
  );
  await assert.rejects(
    () => assertSelfContainedModule('export { x } from "./x.mjs";\n'),
    /unresolved/u,
  );

  for (const [name, mutation, expected] of [
    [
      "lifecycle",
      { packageJson: { scripts: { postinstall: "node install.mjs" } } },
      /postinstall/u,
    ],
    ["dependency", { packageJson: { dependencies: { undici: "1.0.0" } } }, /dependencies/u],
    [
      "import",
      { entry: 'import "missing-package"; export function createIntegrationProvider() {}\n' },
      /unresolved runtime dependency/u,
    ],
  ]) {
    const root = Path.join(await temporaryDirectory(t), name);
    await writeFixture(root, mutation);
    await assert.rejects(() => buildPluginArtifact(root, `${root}-artifact`), expected);
  }

  const nativeRoot = Path.join(await temporaryDirectory(t), "native");
  await writeFixture(nativeRoot);
  await Fs.writeFile(Path.join(nativeRoot, "binding.gyp"), "{}\n");
  await assert.rejects(
    () => buildPluginArtifact(nativeRoot, `${nativeRoot}-artifact`),
    /Native addon/u,
  );

  const linkRoot = Path.join(await temporaryDirectory(t), "link");
  await writeFixture(linkRoot);
  await Fs.symlink("package.json", Path.join(linkRoot, "package-link.json"));
  await assert.rejects(() => buildPluginArtifact(linkRoot, `${linkRoot}-artifact`), /Symlinks/u);
});

test("path and size guards reject adversarial inventories", async (t) => {
  for (const paths of [
    ["plugin.mjs", "plugin.mjs"],
    ["Plugin.mjs", "plugin.mjs"],
    ["../plugin.mjs"],
    ["dist//plugin.mjs"],
    ["/plugin.mjs"],
  ]) {
    assert.throws(
      () => assertSafeRelativePaths(paths),
      /(duplicate|colliding|traversal|relative)/iu,
    );
  }
  const root = Path.join(await temporaryDirectory(t), "large");
  await writeFixture(root);
  await Fs.writeFile(Path.join(root, "oversized.bin"), Buffer.alloc(ARTIFACT_LIMITS.fileBytes + 1));
  await assert.rejects(() => buildPluginArtifact(root, `${root}-artifact`), /size limit/u);
});
