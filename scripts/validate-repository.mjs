import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { validateManifestV2 } from "./manifest-v2.mjs";
import { discoverPluginDirectories } from "./plugin-directories.mjs";
import { parseSkillFrontmatter } from "./skill-frontmatter.mjs";

const root = Path.resolve(import.meta.dirname, "..");
const pluginsRoot = Path.join(root, "plugins");
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

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
  const manifest = validateManifestV2(
    await json(Path.join(packageRoot, ".tritonai-plugin", "plugin.json")),
  );
  assert(packageJson.name === `@tritonai/plugin-${directory}`, `${directory}: package name drift.`);
  assert(semver.test(packageJson.version), `${directory}: package version is not stable semver.`);
  assert(packageJson.version === manifest.version, `${directory}: package/manifest version drift.`);
  assert(manifest.id === directory, `${directory}: manifest id must equal its directory.`);
  for (const skill of manifest.skills) {
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
  for (const required of [".tritonai-plugin", "skills", "README.md", "SECURITY.md"]) {
    assert(packageJson.files.includes(required), `${directory}: package files omit ${required}.`);
  }
  assert(
    !packageJson.files.some(
      (path) => path === "src" || path.includes("test") || path.endsWith("harness.ts"),
    ),
    `${directory}: package file allowlist is unsafe.`,
  );
  if (manifest.tools.length > 0) {
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
  } else {
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
