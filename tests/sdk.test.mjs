import assert from "node:assert/strict";
import * as Crypto from "node:crypto";
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
  verifyPluginArtifact,
} from "../scripts/sdk-artifact.mjs";

const repository = Path.resolve(import.meta.dirname, "..");
const conformancePlugin = Path.join(repository, "plugins", "synthetic-readonly");

async function loadTestArtifact(artifactRoot, compatibility) {
  const verified = await verifyPluginArtifact(artifactRoot, compatibility);
  const url = `data:text/javascript;base64,${verified.entryBytes.toString("base64")}#artifact-sha256=${verified.descriptorSha256}`;
  const module = await import(url);
  assert.deepEqual(Object.keys(module), ["createIntegrationProvider"]);
  assert.equal(typeof module.createIntegrationProvider, "function");
  return { ...verified, createIntegrationProvider: module.createIntegrationProvider };
}

async function instantiateTestArtifact(artifactRoot, context, compatibility) {
  const loaded = await loadTestArtifact(artifactRoot, compatibility);
  const provider = loaded.createIntegrationProvider(context);
  assert(provider && typeof provider === "object");
  assert.equal(provider.id, loaded.manifest.provider);
  assert.equal(typeof provider.status, "function");
  assert.equal(typeof provider.invoke, "function");
  return { ...loaded, provider };
}

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

async function resealPayload(root, relative, contents) {
  const target = Path.join(root, relative);
  await Fs.mkdir(Path.dirname(target), { recursive: true });
  await Fs.writeFile(target, contents);
  const descriptorPath = Path.join(root, "artifact.json");
  const descriptor = JSON.parse(await Fs.readFile(descriptorPath, "utf8"));
  let record = descriptor.files.find((file) => file.path === relative);
  if (!record) {
    record = { path: relative, sha256: "", size: 0 };
    descriptor.files.push(record);
  }
  record.sha256 = Crypto.createHash("sha256").update(contents).digest("hex");
  record.size = contents.length;
  descriptor.files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  await Fs.writeFile(descriptorPath, `${canonicalJson(descriptor)}\n`);
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
  assert.equal(
    validateManifestV1({
      ...value,
      tools: [{ ...value.tools[0], name: "n8n.search_workflows" }],
    }).tools[0].name,
    "n8n.search_workflows",
  );
  for (const name of ["_private", "n8n..read", "n8n._read", "n8n.read_"]) {
    assert.throws(
      () => validateManifestV1({ ...value, tools: [{ ...value.tools[0], name }] }),
      /tool name is invalid/iu,
    );
  }
  assert.throws(() => validateManifestV1({ ...value, extra: true }), /unsupported fields/u);
  assert.equal(validateManifestV1({ ...value, version: "1.0.0-alpha.1" }).version, "1.0.0-alpha.1");
  for (const version of ["1.0.0-01", "1.0.0-alpha.01"]) {
    assert.throws(() => validateManifestV1({ ...value, version }), /version must be semver/u);
  }
  assert.doesNotThrow(() =>
    validateManifestV1({
      ...value,
      configurationSchema: {
        ...value.configurationSchema,
        $defs: { label: { type: "string" } },
        properties: {
          pattern: { $ref: "#/%24defs/label" },
          metadata: { type: "object", default: { $id: "instance-data", $ref: "not-a-schema" } },
        },
      },
    }),
  );
  assert.throws(
    () =>
      validateManifestV1({
        ...value,
        configurationSchema: {
          ...value.configurationSchema,
          $defs: { item: { type: "object" } },
          properties: { item: { $ref: "#/$defs/item/" } },
        },
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
  assert.match(
    sdkTypes,
    /poll\?\([\s\S]*?context: IntegrationLifecycleContext,[\s\S]*?\): Promise<IntegrationProviderPollResult>/u,
  );
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
  const { provider, manifest } = await instantiateTestArtifact(outputs[0], {
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

test("module namespaces are isolated by the complete artifact descriptor", async (t) => {
  const temporary = await temporaryDirectory(t);
  const entry = `
let instanceCount = 0;
export function createIntegrationProvider() {
  const accountLabel = String(++instanceCount);
  return {
    id: "fixture-reader",
    async status() { return { state: "connected", accountLabel, grantedCapabilities: ["fixture.read"], message: null }; },
    async invoke() { return null; }
  };
}
`;
  const configurationSchema = (description) => ({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    description,
    properties: {},
    required: [],
    additionalProperties: false,
  });
  const sources = [Path.join(temporary, "source-one"), Path.join(temporary, "source-two")];
  await writeFixture(sources[0], {
    entry,
    manifest: { configurationSchema: configurationSchema("First reviewed artifact.") },
  });
  await writeFixture(sources[1], {
    entry,
    manifest: { configurationSchema: configurationSchema("Second reviewed artifact.") },
  });
  const outputs = [Path.join(temporary, "artifact-one"), Path.join(temporary, "artifact-two")];
  await buildPluginArtifact(sources[0], outputs[0]);
  await buildPluginArtifact(sources[1], outputs[1]);
  const context = {
    configuration: {},
    secrets: { get: async () => null, set: async () => undefined, remove: async () => undefined },
  };
  const first = await instantiateTestArtifact(outputs[0], context);
  const second = await instantiateTestArtifact(outputs[1], context);
  const operation = { signal: new AbortController().signal };

  assert.equal((await first.provider.status(operation)).accountLabel, "1");
  assert.equal((await second.provider.status(operation)).accountLabel, "1");
});

test("verification reapplies entry and skill payload invariants", async (t) => {
  const temporary = await temporaryDirectory(t);
  const outputs = ["entry", "skill", "undeclared"].map((name) => Path.join(temporary, name));
  for (const output of outputs) await buildPluginArtifact(conformancePlugin, output);

  const entryPath = Path.join(outputs[0], "plugin.mjs");
  const entry = await Fs.readFile(entryPath);
  const oversized = Buffer.concat([
    entry,
    Buffer.alloc(ARTIFACT_LIMITS.entryBytes + 1 - entry.length, 0x20),
  ]);
  await resealPayload(outputs[0], "plugin.mjs", oversized);
  await assert.rejects(() => verifyPluginArtifact(outputs[0]), /entry exceeds its size limit/u);

  const skillPath = "skills/synthetic-readonly/SKILL.md";
  const skill = await Fs.readFile(Path.join(outputs[1], skillPath), "utf8");
  await resealPayload(
    outputs[1],
    skillPath,
    Buffer.from(
      skill.replace(
        "Exercise the deterministic read-only TritonAI SDK conformance tool.",
        "Drifted description.",
      ),
    ),
  );
  await assert.rejects(() => verifyPluginArtifact(outputs[1]), /skill description does not match/u);

  const undeclaredPath = "skills/undeclared/SKILL.md";
  await resealPayload(
    outputs[2],
    undeclaredPath,
    Buffer.from("---\nname: undeclared\ndescription: Undeclared skill.\n---\n"),
  );
  await assert.rejects(() => verifyPluginArtifact(outputs[2]), /undeclared payload/u);
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
  await assert.rejects(() => loadTestArtifact(output), /API major/u);
  assert.equal(globalThis.__tritonaiSdkImported, undefined);

  descriptor.sdk.apiMajor = 1;
  await Fs.writeFile(descriptorPath, `${canonicalJson(descriptor)}\n`);
  await Fs.appendFile(Path.join(output, "plugin.mjs"), "// tampered\n");
  await assert.rejects(() => loadTestArtifact(output), /(size|digest) mismatch/u);
  assert.equal(globalThis.__tritonaiSdkImported, undefined);
});

test("runtime compatibility fails before module import", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = Path.join(temporary, "source");
  const output = Path.join(temporary, "artifact");
  await writeFixture(source, {
    entry:
      "globalThis.__tritonaiSdkImported = true; export function createIntegrationProvider() { return {}; }\n",
  });
  await buildPluginArtifact(source, output);
  delete globalThis.__tritonaiSdkImported;
  await assert.rejects(
    () => loadTestArtifact(output, { hostNodeVersion: "22.23.1" }),
    /requires Node\.js/u,
  );
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
  assert.deepEqual(
    await assertSelfContainedModule(
      'import fs from "node:fs"; export function createIntegrationProvider() {}\n',
    ),
    ["node:fs"],
  );
  await assert.rejects(
    () => assertSelfContainedModule("export const url = import.meta.url;\n"),
    /import\.meta/u,
  );
  await assert.doesNotReject(() =>
    assertSelfContainedModule(
      'const help = "call require("; export function createIntegrationProvider() { return help; }\n',
    ),
  );
  await assert.rejects(
    () => assertSelfContainedModule('export const runtime = import("effect");\n'),
    /dynamically/u,
  );
  await assert.rejects(
    () => assertSelfContainedModule('export { x } from "./x.mjs";\n'),
    /unresolved/u,
  );
  await assert.rejects(
    () =>
      assertSelfContainedModule(
        'import "node:not-a-real-module"; export function createIntegrationProvider() {}\n',
      ),
    /unresolved/u,
  );
  await assert.rejects(
    () => assertSelfContainedModule("export const unrelated = true;\n"),
    /export only createIntegrationProvider/u,
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

  const wideRoot = Path.join(await temporaryDirectory(t), "wide");
  await writeFixture(wideRoot);
  await Promise.all(
    Array.from({ length: ARTIFACT_LIMITS.directories }, (_, index) =>
      Fs.mkdir(Path.join(wideRoot, `empty-${index}`)),
    ),
  );
  await assert.rejects(
    () => buildPluginArtifact(wideRoot, `${wideRoot}-artifact`),
    /too many directories/u,
  );

  const deepRoot = Path.join(await temporaryDirectory(t), "deep");
  await writeFixture(deepRoot);
  let deepest = deepRoot;
  for (let depth = 0; depth <= ARTIFACT_LIMITS.depth; depth += 1) {
    deepest = Path.join(deepest, "nested");
    await Fs.mkdir(deepest);
  }
  await assert.rejects(() => buildPluginArtifact(deepRoot, `${deepRoot}-artifact`), /depth limit/u);

  const totalRoot = Path.join(await temporaryDirectory(t), "total");
  await writeFixture(totalRoot, {
    manifest: {
      skills: [
        {
          name: "fixture-reader",
          description: "Read deterministic fixture records.",
          capabilities: ["fixture.read"],
        },
      ],
    },
  });
  const skillRoot = Path.join(totalRoot, "skills", "fixture-reader");
  await Fs.mkdir(skillRoot, { recursive: true });
  await Fs.writeFile(
    Path.join(skillRoot, "SKILL.md"),
    "---\nname: fixture-reader\ndescription: Read deterministic fixture records.\n---\n",
  );
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      Fs.writeFile(Path.join(skillRoot, `empty-${index}.txt`), ""),
    ),
  );
  const paddingPaths = Array.from({ length: 4 }, (_, index) =>
    Path.join(skillRoot, `padding-${index}.bin`),
  );
  await Promise.all(paddingPaths.map((path) => Fs.writeFile(path, "")));
  const sourceBytes = [...(await artifactSnapshot(totalRoot)).values()].reduce(
    (total, bytes) => total + bytes.length,
    0,
  );
  let remaining = ARTIFACT_LIMITS.totalBytes - sourceBytes;
  for (const path of paddingPaths) {
    const size = Math.min(ARTIFACT_LIMITS.fileBytes, remaining);
    await Fs.writeFile(path, Buffer.alloc(size));
    remaining -= size;
  }
  assert.equal(remaining, 0);
  await assert.rejects(
    () => buildPluginArtifact(totalRoot, `${totalRoot}-artifact`),
    /Generated artifact exceeds its total size limit/u,
  );
});

test("artifact construction ignores the workspace dependency directory", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = Path.join(temporary, "source");
  await writeFixture(source);
  await Fs.mkdir(Path.join(source, "node_modules", "dev-only"), { recursive: true });
  await Fs.writeFile(Path.join(source, "node_modules", "dev-only", "index.js"), "throw 1;\n");
  const output = Path.join(temporary, "artifact");
  await buildPluginArtifact(source, output);
  const snapshot = await artifactSnapshot(output);
  assert(![...snapshot.keys()].some((path) => path.includes("node_modules")));

  const injected = Path.join(output, "node_modules", "rogue", "index.mjs");
  await Fs.mkdir(Path.dirname(injected), { recursive: true });
  await Fs.writeFile(injected, "throw new Error('unsealed');\n");
  await assert.rejects(
    () => verifyPluginArtifact(output),
    /artifact contains forbidden dependencies/u,
  );
});
