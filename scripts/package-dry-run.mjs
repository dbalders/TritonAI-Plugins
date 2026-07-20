import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";

import { validateManifestV2 } from "./manifest-v2.mjs";
import {
  assertPackedMetadata,
  assertPackedStaticFiles,
  assertSafePackageFiles,
  assertSourceMetadataUnchanged,
  assertStaticSourceUnchanged,
} from "./package-artifact.mjs";
import { discoverPluginDirectories } from "./plugin-directories.mjs";

const root = Path.resolve(import.meta.dirname, "..");
const pluginsRoot = Path.join(root, "plugins");
const pluginDirectories = await discoverPluginDirectories(pluginsRoot);

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout;
}

function runBuffer(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || result.stdout?.toString() || `${command} failed`);
  }
  return result.stdout;
}

async function snapshotStaticFiles(packageRoot) {
  const files = new Map();
  async function walk(current, relative) {
    for (const entry of await Fs.readdir(current, { withFileTypes: true })) {
      if (relative === "" && entry.name === "node_modules") continue;
      const child = Path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Static package files must not be symbolic links: ${child}`);
      }
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) files.set(`package/${childRelative}`, await Fs.readFile(child));
      else throw new Error(`Static package files must be regular files: ${child}`);
    }
  }
  await walk(packageRoot, "");
  return files;
}

async function snapshotRepository() {
  const files = new Map();
  async function walk(current, relative) {
    for (const entry of await Fs.readdir(current, { withFileTypes: true })) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const child = Path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Repository files must not be symbolic links: ${child}`);
      }
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) files.set(childRelative, await Fs.readFile(child));
      else throw new Error(`Repository files must be regular files: ${child}`);
    }
  }
  await walk(root, "");
  return files;
}

if (pluginDirectories.length === 0) {
  console.log("deterministic package dry-run passed for empty framework");
} else {
  const reviewedRepository = await snapshotRepository();
  const reviewedPackages = new Map(
    await Promise.all(
      pluginDirectories.map(async (directory) => [
        directory,
        await snapshotStaticFiles(Path.join(pluginsRoot, directory)),
      ]),
    ),
  );
  const temporary = await Fs.mkdtemp(Path.join(Os.tmpdir(), "tritonai-plugin-pack-"));
  try {
    for (const directory of pluginDirectories) {
      const packageRoot = Path.join(pluginsRoot, directory);
      const packagePath = Path.join(packageRoot, "package.json");
      const manifestPath = Path.join(packageRoot, ".tritonai-plugin", "plugin.json");
      const packageJson = JSON.parse(await Fs.readFile(packagePath, "utf8"));
      const manifest = validateManifestV2(JSON.parse(await Fs.readFile(manifestPath, "utf8")));
      const sourceStaticFiles = reviewedPackages.get(directory);
      if (!sourceStaticFiles)
        throw new Error(`${directory}: reviewed package snapshot is missing.`);
      const hashes = [];
      let firstTarball;
      for (const pass of ["one", "two"]) {
        const destination = Path.join(temporary, pass, directory);
        await Fs.mkdir(destination, { recursive: true });
        run("pnpm", ["pack", "--pack-destination", destination], packageRoot);
        const tarballs = (await Fs.readdir(destination)).filter((name) => name.endsWith(".tgz"));
        if (tarballs.length !== 1) throw new Error(`${directory}: expected exactly one tarball.`);
        const tarball = Path.join(destination, tarballs[0]);
        firstTarball ??= tarball;
        hashes.push(
          Crypto.createHash("sha256")
            .update(await Fs.readFile(tarball))
            .digest("hex"),
        );
      }
      if (hashes[0] !== hashes[1]) {
        throw new Error(`${directory}: repeated package output differs.`);
      }
      const packedPackageJson = JSON.parse(
        run("tar", ["-xOf", firstTarball, "package/package.json"]),
      );
      const packedManifest = validateManifestV2(
        JSON.parse(run("tar", ["-xOf", firstTarball, "package/.tritonai-plugin/plugin.json"])),
      );
      assertPackedMetadata(directory, packageJson, manifest, packedPackageJson, packedManifest);
      const currentPackageJson = JSON.parse(await Fs.readFile(packagePath, "utf8"));
      const currentManifest = validateManifestV2(
        JSON.parse(await Fs.readFile(manifestPath, "utf8")),
      );
      assertSourceMetadataUnchanged(
        directory,
        packageJson,
        manifest,
        currentPackageJson,
        currentManifest,
      );
      const files = run("tar", ["-tzf", firstTarball]).trim().split("\n").toSorted();
      assertSafePackageFiles(directory, files, manifest);
      const archiveTypes = run("tar", ["-tvzf", firstTarball])
        .trim()
        .split("\n")
        .filter((line) => line && !line.startsWith("-") && !line.startsWith("d"));
      if (archiveTypes.length > 0) {
        throw new Error(
          `${directory}: package contains links or special archive entries:\n${archiveTypes.join("\n")}`,
        );
      }
      const packedStaticFiles = new Map();
      for (const file of files) {
        if (!file.endsWith("/") && file !== "package/package.json") {
          packedStaticFiles.set(file, runBuffer("tar", ["-xOf", firstTarball, file]));
        }
      }
      assertPackedStaticFiles(directory, packedStaticFiles, sourceStaticFiles);
      assertStaticSourceUnchanged(
        directory,
        sourceStaticFiles,
        await snapshotStaticFiles(packageRoot),
      );
      console.log(
        `deterministic package dry-run passed for ${packageJson.name} (${files.length} files)`,
      );
    }
  } finally {
    await Fs.rm(temporary, { recursive: true, force: true });
    assertStaticSourceUnchanged("repository", reviewedRepository, await snapshotRepository());
  }
}
