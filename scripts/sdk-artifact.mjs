import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import { builtinModules } from "node:module";
import * as Path from "node:path";
import { parse as parseModule } from "acorn";
import { init, parse as parseImports } from "es-module-lexer";
import { satisfies as satisfiesSemver } from "semver";

import {
  HOST_CONTRACT_LEVEL,
  SDK_API_MAJOR,
  canonicalJson,
  validateManifestV1,
} from "../packages/plugin-sdk/index.mjs";
import { parseSkillFrontmatter } from "./skill-frontmatter.mjs";

export const ARTIFACT_FORMAT = "tritonai.plugin-artifact/v1";
export const ARTIFACT_VERSION = 1;
export const ARTIFACT_LIMITS = Object.freeze({
  depth: 16,
  directories: 128,
  files: 128,
  fileBytes: 1_048_576,
  entryBytes: 524_288,
  manifestBytes: 262_144,
  totalBytes: 4_194_304,
});

const MANIFEST_PATH = ".tritonai-plugin/plugin.json";
const ARTIFACT_PATH = "artifact.json";
const ENTRY_PATH = "plugin.mjs";
const NODE_BUILTINS = new Set(
  builtinModules.map((specifier) =>
    specifier.startsWith("node:") ? specifier : `node:${specifier}`,
  ),
);
const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
]);
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu;
const WINDOWS_FORBIDDEN_CHARACTERS = '<>:"|?*';
const DESCRIPTOR_KEYS = new Set([
  "artifactVersion",
  "format",
  "plugin",
  "sdk",
  "target",
  "entry",
  "manifest",
  "configurationSchema",
  "schemas",
  "files",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value, keys) {
  return plainObject(value) && Object.keys(value).every((key) => keys.has(key));
}

function digest(bytes) {
  return Crypto.createHash("sha256").update(bytes).digest("hex");
}

function posixRelative(root, absolute) {
  return Path.relative(root, absolute).split(Path.sep).join("/");
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function assertSafeRelativePaths(paths) {
  assert(
    Array.isArray(paths) && paths.length <= ARTIFACT_LIMITS.files,
    "Artifact file count exceeds its limit.",
  );
  const exact = new Set();
  const folded = new Set();
  for (const path of paths) {
    assert(
      typeof path === "string" && path.length > 0 && path.length <= 512,
      "Artifact path is invalid.",
    );
    assert(path === path.normalize("NFC"), `Artifact path must use NFC: ${path}`);
    assert(
      !path.includes("\\") && !path.includes("\0"),
      `Artifact path contains a forbidden character: ${path}`,
    );
    assert(!Path.posix.isAbsolute(path), `Artifact path must be relative: ${path}`);
    const segments = path.split("/");
    assert(
      segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
      `Artifact path contains traversal or an empty segment: ${path}`,
    );
    assert(
      segments.every(
        (segment) =>
          ![...segment].some(
            (character) =>
              character.codePointAt(0) <= 0x1f || WINDOWS_FORBIDDEN_CHARACTERS.includes(character),
          ) &&
          !/[ .]$/u.test(segment) &&
          !WINDOWS_DEVICE_NAME.test(segment),
      ),
      `Artifact path is not portable: ${path}`,
    );
    assert(!exact.has(path), `Duplicate artifact path: ${path}`);
    exact.add(path);
    const caseKey = path.toLowerCase();
    assert(!folded.has(caseKey), `Case-colliding artifact path: ${path}`);
    folded.add(caseKey);
  }
}

async function scanRegularTree(root, { ignoreNodeModules = false } = {}) {
  const files = [];
  let directories = 0;
  let totalBytes = 0;
  async function walk(directory, depth) {
    directories += 1;
    assert(directories <= ARTIFACT_LIMITS.directories, "Plugin tree has too many directories.");
    assert(depth <= ARTIFACT_LIMITS.depth, "Plugin tree exceeds its depth limit.");
    const entries = await Fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = Path.join(directory, entry.name);
      const relative = posixRelative(root, absolute);
      if (entry.name === "node_modules" && entry.isDirectory()) {
        assert(ignoreNodeModules, `Plugin artifact contains forbidden dependencies: ${relative}`);
        continue;
      }
      assert(!entry.isSymbolicLink(), `Symlinks are forbidden in plugin source: ${relative}`);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      assert(entry.isFile(), `Special files are forbidden in plugin source: ${relative}`);
      assert(files.length < ARTIFACT_LIMITS.files, "Plugin tree has too many files.");
      const stat = await Fs.lstat(absolute);
      assert(
        stat.isFile() && !stat.isSymbolicLink(),
        `Plugin source changed during inspection: ${relative}`,
      );
      assert(
        stat.size <= ARTIFACT_LIMITS.fileBytes,
        `Plugin source file exceeds its size limit: ${relative}`,
      );
      totalBytes += stat.size;
      assert(
        totalBytes <= ARTIFACT_LIMITS.totalBytes,
        "Plugin source exceeds its total size limit.",
      );
      files.push(relative);
    }
  }
  await walk(root, 0);
  files.sort();
  assertSafeRelativePaths(files);
  return files;
}

function parseCanonicalJson(bytes, label, maximumBytes) {
  assert(bytes.length <= maximumBytes, `${label} exceeds its size limit.`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    Buffer.compare(bytes, canonicalBytes(value)) === 0,
    `${label} must be canonical JSON with one trailing newline.`,
  );
  return { bytes, value };
}

async function readCanonicalJson(path, label, maximumBytes) {
  return parseCanonicalJson(await Fs.readFile(path), label, maximumBytes);
}

function assertSafePackageJson(value) {
  assert(plainObject(value), "package.json must be an object.");
  const scripts = value.scripts ?? {};
  assert(plainObject(scripts), "package.json scripts must be an object.");
  for (const script of LIFECYCLE_SCRIPTS) {
    assert(!(script in scripts), `Plugin package lifecycle script is forbidden: ${script}`);
  }
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    const dependencies = value[field];
    assert(
      dependencies === undefined ||
        (plainObject(dependencies) && Object.keys(dependencies).length === 0),
      `Self-contained plugin package must omit ${field}.`,
    );
  }
  assert(
    value.gypfile !== true && value.binary === undefined,
    "Native addon package metadata is forbidden.",
  );
}

export async function assertSelfContainedModule(source) {
  assert(typeof source === "string", "Plugin entry must be UTF-8 source text.");
  try {
    parseModule(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new Error(
      `Plugin entry is not valid ECMAScript: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await init;
  const [imports, exports] = parseImports(source);
  const builtins = [];
  for (const request of imports) {
    assert(request.d !== -2, "Plugin entry cannot rely on import.meta from a data module.");
    assert(request.n !== undefined, "Plugin entry cannot compute a dynamic import specifier.");
    assert(request.d === -1, "Plugin entry cannot load modules dynamically.");
    assert(
      request.n.startsWith("node:") && NODE_BUILTINS.has(request.n),
      `Plugin entry has an unresolved runtime dependency: ${request.n}`,
    );
    builtins.push(request.n);
  }
  assert(
    canonicalJson(exports.map(({ n }) => n).sort()) ===
      canonicalJson(["createIntegrationProvider"]),
    "Plugin entry must export only createIntegrationProvider.",
  );
  return [...new Set(builtins)].sort();
}

function assertNoNativeSources(files) {
  for (const path of files) {
    assert(
      !/(?:^|\/)(?:binding\.gyp|[^/]+\.(?:gyp|node))$/iu.test(path),
      `Native addon file is forbidden: ${path}`,
    );
  }
}

function descriptorFor(manifest, payloads, nodeBuiltins) {
  const payload = [...payloads.entries()]
    .map(([path, bytes]) => ({ path, sha256: digest(bytes), size: bytes.length }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const schemas = manifest.tools
    .map((tool) => ({
      tool: tool.name,
      sha256: digest(Buffer.from(canonicalJson(tool.inputSchema), "utf8")),
    }))
    .sort((left, right) => (left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0));
  return {
    artifactVersion: ARTIFACT_VERSION,
    format: ARTIFACT_FORMAT,
    plugin: { id: manifest.id, version: manifest.version },
    sdk: {
      apiMajor: manifest.sdk.apiMajor,
      requiredHostContractLevel: manifest.sdk.requiredHostContractLevel,
    },
    target: {
      architecture: "any",
      environments: ["electron-main", "server"],
      module: "esm",
      node: ">=24.13.1 <25",
      platform: "any",
      runtime: "node",
      nodeBuiltins,
    },
    entry: ENTRY_PATH,
    manifest: MANIFEST_PATH,
    configurationSchema: digest(Buffer.from(canonicalJson(manifest.configurationSchema), "utf8")),
    schemas,
    files: payload,
  };
}

async function assertPayloadInvariants(manifest, payloads) {
  const entryBytes = payloads.get(ENTRY_PATH);
  assert(entryBytes, "Plugin entry payload is missing.");
  assert(entryBytes.length <= ARTIFACT_LIMITS.entryBytes, "Plugin entry exceeds its size limit.");
  const entrySource = entryBytes.toString("utf8");
  assert(Buffer.from(entrySource, "utf8").equals(entryBytes), "Plugin entry must be valid UTF-8.");
  const nodeBuiltins = await assertSelfContainedModule(entrySource);

  const declaredSkills = new Set(manifest.skills.map((skill) => skill.name));
  for (const path of payloads.keys()) {
    if (path === MANIFEST_PATH || path === ENTRY_PATH) continue;
    const [root, skill] = path.split("/");
    assert(
      root === "skills" && skill !== undefined && declaredSkills.has(skill),
      `Plugin contains an undeclared payload: ${path}`,
    );
  }
  for (const skill of manifest.skills) {
    const path = `skills/${skill.name}/SKILL.md`;
    const bytes = payloads.get(path);
    assert(bytes, `Plugin skill entrypoint is missing: ${path}`);
    const content = bytes.toString("utf8");
    assert(Buffer.from(content, "utf8").equals(bytes), `Plugin skill must be UTF-8: ${path}`);
    const frontmatter = parseSkillFrontmatter(content);
    assert(frontmatter.name === skill.name, `Plugin skill name does not match: ${path}`);
    assert(
      frontmatter.description === skill.description,
      `Plugin skill description does not match: ${path}`,
    );
  }
  return nodeBuiltins;
}

export async function buildPluginArtifact(sourceRoot, outputRoot) {
  const source = Path.resolve(sourceRoot);
  const output = Path.resolve(outputRoot);
  assert(source !== output, "Artifact output must differ from plugin source.");
  const outputStatus = await Fs.lstat(output).catch(() => undefined);
  assert(outputStatus === undefined, "Artifact output already exists.");

  const sourceStatus = await Fs.lstat(source);
  assert(
    sourceStatus.isDirectory() && !sourceStatus.isSymbolicLink(),
    "Plugin source must be a real directory.",
  );
  const files = await scanRegularTree(source, { ignoreNodeModules: true });
  assertNoNativeSources(files);
  assert(files.includes("package.json"), "Plugin source package.json is required.");
  assert(files.includes(MANIFEST_PATH), `Plugin source ${MANIFEST_PATH} is required.`);

  const packageJson = JSON.parse(await Fs.readFile(Path.join(source, "package.json"), "utf8"));
  assertSafePackageJson(packageJson);
  const manifestDocument = await readCanonicalJson(
    Path.join(source, MANIFEST_PATH),
    "Plugin manifest",
    ARTIFACT_LIMITS.manifestBytes,
  );
  const manifest = validateManifestV1(manifestDocument.value);
  assert(files.includes(manifest.entry), `Plugin entry is missing: ${manifest.entry}`);
  assert(
    packageJson.name === `@tritonai/plugin-${manifest.id}`,
    "Plugin package name does not match its manifest id.",
  );
  assert(
    packageJson.version === manifest.version,
    "Plugin package version does not match its manifest.",
  );

  const entryBytes = await Fs.readFile(Path.join(source, manifest.entry));
  const declaredSkills = new Set(manifest.skills.map((skill) => skill.name));
  const payloads = new Map([
    [MANIFEST_PATH, manifestDocument.bytes],
    [ENTRY_PATH, entryBytes],
  ]);
  for (const path of files.filter((candidate) => candidate.startsWith("skills/"))) {
    const skill = path.split("/")[1];
    assert(declaredSkills.has(skill), `Plugin contains undeclared skill files: ${path}`);
    payloads.set(path, await Fs.readFile(Path.join(source, path)));
  }
  const nodeBuiltins = await assertPayloadInvariants(manifest, payloads);
  const descriptor = descriptorFor(manifest, payloads, nodeBuiltins);
  const descriptorBytes = canonicalBytes(descriptor);
  assert(
    descriptorBytes.length <= ARTIFACT_LIMITS.manifestBytes,
    "Artifact descriptor exceeds its size limit.",
  );
  assert(
    [...payloads.values()].reduce((total, bytes) => total + bytes.length, descriptorBytes.length) <=
      ARTIFACT_LIMITS.totalBytes,
    "Generated artifact exceeds its total size limit.",
  );

  const temporary = await Fs.mkdtemp(`${output}.building-`);
  try {
    for (const [path, bytes] of payloads) {
      const target = Path.join(temporary, path);
      await Fs.mkdir(Path.dirname(target), { recursive: true });
      await Fs.writeFile(target, bytes, { flag: "wx", mode: 0o644 });
    }
    await Fs.writeFile(Path.join(temporary, ARTIFACT_PATH), descriptorBytes, {
      flag: "wx",
      mode: 0o644,
    });
    await Fs.rename(temporary, output);
  } catch (error) {
    await Fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return descriptor;
}

function assertDescriptorShape(value) {
  assert(onlyKeys(value, DESCRIPTOR_KEYS), "Artifact descriptor contains unsupported fields.");
  assert(
    value.format === ARTIFACT_FORMAT && value.artifactVersion === ARTIFACT_VERSION,
    "Artifact format is unsupported.",
  );
  assert(
    onlyKeys(value.plugin, new Set(["id", "version"])),
    "Artifact plugin identity is invalid.",
  );
  assert(
    onlyKeys(value.sdk, new Set(["apiMajor", "requiredHostContractLevel"])),
    "Artifact sdk contract is invalid.",
  );
  assert(
    onlyKeys(
      value.target,
      new Set([
        "architecture",
        "environments",
        "module",
        "node",
        "nodeBuiltins",
        "platform",
        "runtime",
      ]),
    ) &&
      value.target.architecture === "any" &&
      Array.isArray(value.target.environments) &&
      canonicalJson(value.target.environments) === canonicalJson(["electron-main", "server"]) &&
      value.target.module === "esm" &&
      value.target.node === ">=24.13.1 <25" &&
      value.target.platform === "any" &&
      value.target.runtime === "node" &&
      Array.isArray(value.target.nodeBuiltins) &&
      value.target.nodeBuiltins.every(
        (specifier) => typeof specifier === "string" && specifier.startsWith("node:"),
      ) &&
      new Set(value.target.nodeBuiltins).size === value.target.nodeBuiltins.length &&
      value.target.nodeBuiltins.every(
        (specifier, index) => index === 0 || value.target.nodeBuiltins[index - 1] < specifier,
      ),
    "Artifact target is unsupported.",
  );
  assert(
    value.entry === ENTRY_PATH && value.manifest === MANIFEST_PATH,
    "Artifact paths are unsupported.",
  );
  assert(
    Array.isArray(value.schemas) && Array.isArray(value.files),
    "Artifact schema and file inventories are required.",
  );
  assert(
    typeof value.configurationSchema === "string" &&
      /^[a-f0-9]{64}$/u.test(value.configurationSchema),
    "Artifact configuration schema digest is invalid.",
  );
}

export async function verifyPluginArtifact(
  artifactRoot,
  {
    sdkApiMajor = SDK_API_MAJOR,
    hostContractLevel = HOST_CONTRACT_LEVEL,
    hostNodeVersion = process.versions.node,
  } = {},
) {
  assert(Number.isSafeInteger(sdkApiMajor) && sdkApiMajor > 0, "Host sdkApiMajor is invalid.");
  assert(
    Number.isSafeInteger(hostContractLevel) && hostContractLevel > 0,
    "Host contract level is invalid.",
  );
  assert(typeof hostNodeVersion === "string", "Host Node.js version is invalid.");
  const root = Path.resolve(artifactRoot);
  const status = await Fs.lstat(root);
  assert(
    status.isDirectory() && !status.isSymbolicLink(),
    "Artifact root must be a real directory.",
  );
  const tree = await scanRegularTree(root);
  assertNoNativeSources(tree);
  assert(tree.includes(ARTIFACT_PATH), "Artifact descriptor is missing.");
  const descriptorDocument = await readCanonicalJson(
    Path.join(root, ARTIFACT_PATH),
    "Artifact descriptor",
    ARTIFACT_LIMITS.manifestBytes,
  );
  const descriptor = descriptorDocument.value;
  assertDescriptorShape(descriptor);
  assert(
    satisfiesSemver(hostNodeVersion, descriptor.target.node),
    `Plugin requires Node.js ${descriptor.target.node}; host is ${hostNodeVersion}.`,
  );
  assert(
    descriptor.sdk.apiMajor === sdkApiMajor,
    "Plugin SDK API major is incompatible with this host.",
  );
  assert(
    Number.isSafeInteger(descriptor.sdk.requiredHostContractLevel) &&
      descriptor.sdk.requiredHostContractLevel > 0 &&
      descriptor.sdk.requiredHostContractLevel <= hostContractLevel,
    "Plugin requires a newer host contract level.",
  );

  const listedPaths = descriptor.files.map((file) => file?.path);
  assertSafeRelativePaths(listedPaths);
  assert(
    listedPaths.every((path, index) => index === 0 || listedPaths[index - 1] < path),
    "Artifact files must be sorted.",
  );
  assert(
    tree.length === listedPaths.length + 1 &&
      tree.every((path) => path === ARTIFACT_PATH || listedPaths.includes(path)),
    "Artifact file inventory is incomplete.",
  );
  const payloads = new Map();
  for (const file of descriptor.files) {
    assert(
      onlyKeys(file, new Set(["path", "sha256", "size"])),
      `Artifact file record is invalid: ${String(file?.path)}`,
    );
    assert(
      Number.isSafeInteger(file.size) && file.size >= 0,
      `Artifact file size is invalid: ${file.path}`,
    );
    assert(
      typeof file.sha256 === "string" && /^[a-f0-9]{64}$/u.test(file.sha256),
      `Artifact file digest is invalid: ${file.path}`,
    );
    const bytes = await Fs.readFile(Path.join(root, file.path));
    assert(bytes.length === file.size, `Artifact file size mismatch: ${file.path}`);
    assert(digest(bytes) === file.sha256, `Artifact file digest mismatch: ${file.path}`);
    payloads.set(file.path, bytes);
  }

  const manifestBytes = payloads.get(MANIFEST_PATH);
  const entryBytes = payloads.get(ENTRY_PATH);
  assert(manifestBytes && entryBytes, "Artifact manifest or entry payload is missing.");
  const manifestDocument = parseCanonicalJson(
    manifestBytes,
    "Plugin manifest",
    ARTIFACT_LIMITS.manifestBytes,
  );
  const manifest = validateManifestV1(manifestDocument.value);
  assert(
    descriptor.plugin.id === manifest.id && descriptor.plugin.version === manifest.version,
    "Artifact plugin identity does not match its manifest.",
  );
  assert(
    descriptor.sdk.apiMajor === manifest.sdk.apiMajor &&
      descriptor.sdk.requiredHostContractLevel === manifest.sdk.requiredHostContractLevel,
    "Artifact sdk contract does not match its manifest.",
  );
  const nodeBuiltins = await assertPayloadInvariants(manifest, payloads);
  const expectedDescriptor = descriptorFor(manifest, payloads, nodeBuiltins);
  assert(
    canonicalJson(descriptor) === canonicalJson(expectedDescriptor),
    "Artifact descriptor does not match its verified payloads.",
  );
  return {
    descriptor,
    descriptorSha256: digest(descriptorDocument.bytes),
    manifest,
    entryBytes,
  };
}
