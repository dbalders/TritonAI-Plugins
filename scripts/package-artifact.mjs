import { isDeepStrictEqual } from "node:util";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizedPackageJson(value) {
  const { _id: _ignoredId, gitHead: _ignoredGitHead, ...reviewed } = value;
  return reviewed;
}

export function assertPackedMetadata(
  directory,
  sourcePackageJson,
  sourceManifest,
  packedPackageJson,
  packedManifest,
) {
  assert(
    isDeepStrictEqual(normalizedPackageJson(packedPackageJson), sourcePackageJson),
    `${directory}: packed package.json differs from reviewed source metadata.`,
  );
  assert(
    isDeepStrictEqual(packedManifest, sourceManifest),
    `${directory}: packed plugin manifest differs from reviewed source metadata.`,
  );
}

export function assertSafePackageFiles(directory, inputFiles, manifest) {
  const files = inputFiles.filter((file) => file && !file.endsWith("/"));
  const declaredSkills = new Set(manifest.skills.map(({ name }) => name));
  const required = new Set([
    "package/.tritonai-plugin/plugin.json",
    "package/README.md",
    "package/SECURITY.md",
    "package/package.json",
    ...[...declaredSkills].map((name) => `package/skills/${name}/SKILL.md`),
    ...(manifest.tools.length > 0 ? ["package/dist/index.d.ts", "package/dist/index.js"] : []),
  ]);
  const allowedRootFiles = new Set([
    "package/LICENSE",
    "package/README.md",
    "package/SECURITY.md",
    "package/package.json",
  ]);
  const unsafe = files.filter((file) => {
    if (allowedRootFiles.has(file) || file === "package/.tritonai-plugin/plugin.json") return false;
    if (file.startsWith("package/.tritonai-plugin/")) return true;
    if (file.startsWith("package/skills/")) {
      const skill = file.slice("package/skills/".length).split("/", 1)[0];
      return !declaredSkills.has(skill);
    }
    if (file.startsWith("package/dist/")) {
      if (manifest.tools.length === 0) return true;
      const relative = file.slice("package/dist/".length);
      return (
        /(?:^|\/)(?:__tests__|fixtures?|specs?|tests?)(?:\/|$)/iu.test(relative) ||
        /(?:^|[./_-])(?:spec|test)(?:[./_-]|$)/iu.test(relative) ||
        (/\.tsx?$/iu.test(relative) && !/\.d\.ts$/iu.test(relative)) ||
        !/(?:\.d\.ts|\.js|\.json)$/iu.test(relative)
      );
    }
    return true;
  });
  assert(
    unsafe.length === 0,
    `${directory}: package contains unsafe or undeclared paths:\n${unsafe.join("\n")}`,
  );
  const missing = [...required].filter((file) => !files.includes(file));
  assert(
    missing.length === 0,
    `${directory}: package is missing required files:\n${missing.join("\n")}`,
  );
}

export function assertPackedStaticFiles(directory, packedFiles, sourceFiles) {
  const expectedSourceFiles = [...sourceFiles.keys()].filter(
    (file) =>
      file === "package/.tritonai-plugin/plugin.json" ||
      file === "package/README.md" ||
      file === "package/SECURITY.md" ||
      file === "package/LICENSE" ||
      file.startsWith("package/skills/") ||
      file.startsWith("package/dist/"),
  );
  for (const file of expectedSourceFiles) {
    assert(
      packedFiles.has(file),
      `${directory}: reviewed static file is missing from package: ${file}`,
    );
  }
  for (const [file, packed] of packedFiles) {
    const source = sourceFiles.get(file);
    assert(source, `${directory}: packed static file has no reviewed source: ${file}`);
    assert(
      Buffer.compare(packed, source) === 0,
      `${directory}: packed static file differs from reviewed source: ${file}`,
    );
  }
}

export function assertStaticSourceUnchanged(directory, before, after) {
  assert(
    before.size === after.size && [...before.keys()].every((file) => after.has(file)),
    `${directory}: package lifecycle changed the reviewed static file set.`,
  );
  for (const [file, source] of before) {
    assert(
      Buffer.compare(source, after.get(file)) === 0,
      `${directory}: package lifecycle changed reviewed source: ${file}`,
    );
  }
}
