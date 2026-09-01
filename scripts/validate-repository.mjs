import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import { validateManifestV2 } from "./manifest-v2.mjs";
import { validateManifestV1 } from "../packages/plugin-sdk/index.mjs";
import { discoverPluginDirectories } from "./plugin-directories.mjs";
import { assertProviderRuntimeDependencies } from "./provider-runtime-dependencies.mjs";
import { parseSkillFrontmatter } from "./skill-frontmatter.mjs";
import { inspectPluginModule } from "./sdk-artifact.mjs";

const root = Path.resolve(import.meta.dirname, "..");
const pluginsRoot = Path.join(root, "plugins");
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const EXPECTED_MIT_LICENSE_SHA256 =
  "6203d12e65d7beeb8fda48ffffe22f7a0c545f2e40730f58eca9f98f8a7bbb0a";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path) {
  return JSON.parse(await Fs.readFile(path, "utf8"));
}

async function regularTree(path) {
  for (const entry of await Fs.readdir(path, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const child = Path.join(path, entry.name);
    assert(entry.name !== ".npmignore", `Nested .npmignore files are not allowed: ${child}`);
    assert(!entry.isSymbolicLink(), `Symlinks are not allowed in plugin packages: ${child}`);
    if (entry.isDirectory()) await regularTree(child);
    else assert(entry.isFile(), `Special files are not allowed in plugin packages: ${child}`);
  }
}

const rootPackageJson = await json(Path.join(root, "package.json"));
const rootLicense = await Fs.readFile(Path.join(root, "LICENSE"), "utf8");
assert(rootPackageJson.private === true, "Root package must remain private.");
assert(rootPackageJson.license === "MIT", "Root package license must be MIT.");
assert(
  Crypto.createHash("sha256").update(rootLicense).digest("hex") === EXPECTED_MIT_LICENSE_SHA256,
  "Root LICENSE must contain the approved MIT license text.",
);

const workspace = await Fs.readFile(Path.join(root, "pnpm-workspace.yaml"), "utf8");
assert(/^\s*- plugins\/\*\s*$/mu.test(workspace), "Workspace must include plugins/*.");
assert(!workspace.includes("integrations/"), "Workspace still references integrations/.");
await Fs.access(Path.join(root, "marketplace.json")).then(
  () => {
    throw new Error("marketplace.json is forbidden without a runtime marketplace consumer.");
  },
  () => undefined,
);

const entries = await discoverPluginDirectories(pluginsRoot);

for (const directory of entries) {
  assert(slug.test(directory), `Invalid plugin directory name: ${directory}`);
  const packageRoot = Path.join(pluginsRoot, directory);
  await regularTree(packageRoot);
  const packageJson = await json(Path.join(packageRoot, "package.json"));
  const manifestValue = await json(Path.join(packageRoot, ".tritonai-plugin", "plugin.json"));
  const sdkV1 = manifestValue.apiVersion === "tritonai.plugin/v1";
  const manifest = sdkV1 ? validateManifestV1(manifestValue) : validateManifestV2(manifestValue);
  assert(packageJson.name === `@tritonai/plugin-${directory}`, `${directory}: package name drift.`);
  assert(packageJson.private === true, `${directory}: package must remain private.`);
  assert(packageJson.license === "MIT", `${directory}: package license must be MIT.`);
  assert(
    (await Fs.readFile(Path.join(packageRoot, "LICENSE"), "utf8")) === rootLicense,
    `${directory}: package license must match the root MIT license.`,
  );
  assert(semver.test(packageJson.version), `${directory}: package version is not stable semver.`);
  assert(packageJson.version === manifest.version, `${directory}: package/manifest version drift.`);
  assert(manifest.id === directory, `${directory}: manifest id must equal its directory.`);
  for (const skill of manifest.skills ?? []) {
    const content = await Fs.readFile(
      Path.join(packageRoot, "skills", skill.name, "SKILL.md"),
      "utf8",
    );
    const frontmatter = parseSkillFrontmatter(content);
    assert(frontmatter.name === skill.name, `${directory}/${skill.name}: skill name drift.`);
    assert(
      frontmatter.description === skill.description,
      `${directory}/${skill.name}: skill description drift.`,
    );
  }
  assert(Array.isArray(packageJson.files), `${directory}: package files must be an array.`);
  for (const required of [
    ".tritonai-plugin",
    ...(sdkV1 ? ["dist", ...(manifest.skills.length > 0 ? ["skills"] : [])] : ["skills"]),
    "LICENSE",
    "README.md",
    "SECURITY.md",
  ]) {
    assert(packageJson.files.includes(required), `${directory}: package files omit ${required}.`);
  }
  assert(
    !packageJson.files.some(
      (path) => path === "src" || path.includes("test") || path.endsWith("harness.ts"),
    ),
    `${directory}: package file allowlist is unsafe.`,
  );
  if (!sdkV1) assertProviderRuntimeDependencies(directory, packageJson, manifest);
  if (sdkV1) {
    assert(
      packageJson.exports?.["."] === `./${manifest.entry}`,
      `${directory}: SDK v1 package must export its manifest entry.`,
    );
    assert(
      !packageJson.dependencies &&
        !packageJson.optionalDependencies &&
        !packageJson.peerDependencies &&
        !packageJson.bundledDependencies &&
        !packageJson.bundleDependencies,
      `${directory}: SDK v1 package must remain dependency-free.`,
    );
    const entry = await Fs.stat(Path.join(packageRoot, manifest.entry)).catch(() => undefined);
    assert(entry?.isFile(), `${directory}: SDK v1 entry is missing ${manifest.entry}.`);
    const source = await Fs.readFile(Path.join(packageRoot, manifest.entry), "utf8");
    await inspectPluginModule(source).catch((error) => {
      throw new Error(`${directory}: SDK v1 entry module is invalid.`, { cause: error });
    });
  } else if (manifest.provider !== undefined) {
    assert(
      packageJson.files.includes("dist") &&
        packageJson.exports?.["."]?.types === "./dist/index.d.ts" &&
        packageJson.exports?.["."]?.default === "./dist/index.js",
      `${directory}: provider package must export compiled dist/index files.`,
    );
    for (const script of ["build", "prepack", "typecheck", "contract:harness"]) {
      assert(
        typeof packageJson.scripts?.[script] === "string" && packageJson.scripts[script].trim(),
        `${directory}: provider package must define a ${script} script.`,
      );
    }
    for (const artifact of ["dist/index.js", "dist/index.d.ts"]) {
      const entry = await Fs.stat(Path.join(packageRoot, artifact)).catch(() => undefined);
      assert(entry?.isFile(), `${directory}: reviewed provider artifact is missing ${artifact}.`);
    }
    const providerModule = await import(
      pathToFileURL(Path.join(packageRoot, "dist", "index.js")).href
    );
    assert(
      isDeepStrictEqual(providerModule.manifest, manifest),
      `${directory}: compiled provider must export its exact manifest as manifest.`,
    );
    assert(
      typeof providerModule.createIntegrationProvider === "function",
      `${directory}: compiled provider must export createIntegrationProvider.`,
    );
  } else if (!sdkV1) {
    const hasSource = await Fs.stat(Path.join(packageRoot, "src")).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    assert(
      !hasSource ||
        (typeof packageJson.scripts?.typecheck === "string" &&
          packageJson.scripts.typecheck.trim()),
      `${directory}: packages with source must define a typecheck script.`,
    );
  }
  console.log(`validated plugin ${directory} (${packageJson.name}@${packageJson.version})`);
}

const trackedText = ["package.json", "pnpm-workspace.yaml", "tsconfig.json", "pnpm-lock.yaml"].map(
  async (relative) => [relative, await Fs.readFile(Path.join(root, relative), "utf8")],
);
for (const [relative, content] of await Promise.all(trackedText)) {
  assert(!content.includes("integrations/"), `${relative} still references integrations/.`);
  assert(!content.includes("@tritonai/integration-"), `${relative} uses an obsolete package name.`);
}

console.log(`repository validation passed for ${entries.length} plugin package(s)`);
