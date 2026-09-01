import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { buildPluginArtifact, verifyPluginArtifact } from "./sdk-artifact.mjs";
import { discoverPluginDirectories } from "./plugin-directories.mjs";

const root = Path.resolve(import.meta.dirname, "..");
const pluginsRoot = Path.join(root, "plugins");
const artifactsRoot = Path.join(root, "artifacts");
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === "--check";

if (args.length > (check ? 1 : 0)) {
  throw new Error("Usage: node scripts/sync-sdk-artifacts.mjs [--check]");
}

async function snapshot(directory) {
  const files = new Map();
  async function walk(current, relative) {
    for (const entry of await Fs.readdir(current, { withFileTypes: true })) {
      const child = Path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Release artifacts cannot contain symbolic links: ${childRelative}`);
      }
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) files.set(childRelative, await Fs.readFile(child));
      else throw new Error(`Release artifacts must contain only regular files: ${childRelative}`);
    }
  }
  await walk(directory, "");
  return files;
}

function assertEqual(id, expected, actual) {
  if (expected.size !== actual.size) {
    throw new Error(`${id}: committed SDK artifact file inventory is stale.`);
  }
  for (const [path, bytes] of expected) {
    const committed = actual.get(path);
    if (!committed || !bytes.equals(committed)) {
      throw new Error(`${id}: committed SDK artifact differs at ${path}.`);
    }
  }
}

async function sdkPluginIds() {
  const result = [];
  for (const id of await discoverPluginDirectories(pluginsRoot)) {
    const manifest = JSON.parse(
      await Fs.readFile(Path.join(pluginsRoot, id, ".tritonai-plugin", "plugin.json"), "utf8"),
    );
    if (manifest.apiVersion === "tritonai.plugin/v1") result.push(id);
  }
  return result;
}

async function artifactIds() {
  const status = await Fs.lstat(artifactsRoot).catch(() => undefined);
  if (!status) return [];
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("artifacts/ must be a real directory.");
  }
  const result = [];
  for (const entry of await Fs.readdir(artifactsRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".building-")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Unexpected release artifact entry: artifacts/${entry.name}`);
    }
    result.push(entry.name);
  }
  return result.sort();
}

const ids = await sdkPluginIds();
const committedIds = await artifactIds();
const unexpectedIds = committedIds.filter((id) => !ids.includes(id));
if ((check && JSON.stringify(ids) !== JSON.stringify(committedIds)) || unexpectedIds.length > 0) {
  throw new Error(
    `Committed SDK artifact ids differ from SDK plugins: expected ${ids.join(", ") || "none"}; found ${committedIds.join(", ") || "none"}.`,
  );
}

await Fs.mkdir(artifactsRoot, { recursive: true });
const temporary = await Fs.mkdtemp(Path.join(artifactsRoot, ".building-"));
try {
  for (const id of ids) {
    const generated = Path.join(temporary, id);
    const committed = Path.join(artifactsRoot, id);
    await buildPluginArtifact(Path.join(pluginsRoot, id), generated);
    const generatedArtifact = await verifyPluginArtifact(generated, {
      hostNodeVersion: "24.13.1",
    });
    if (generatedArtifact.manifest.id !== id) {
      throw new Error(`${id}: SDK artifact manifest id does not match its directory.`);
    }
    if (check) {
      const committedArtifact = await verifyPluginArtifact(committed, {
        hostNodeVersion: "24.13.1",
      });
      if (committedArtifact.manifest.id !== id) {
        throw new Error(`${id}: committed SDK artifact manifest id does not match its directory.`);
      }
      assertEqual(id, await snapshot(generated), await snapshot(committed));
    } else {
      const backup = Path.join(temporary, `${id}.previous`);
      const hadCommitted = await Fs.lstat(committed).then(
        () => true,
        () => false,
      );
      if (hadCommitted) await Fs.rename(committed, backup);
      try {
        await Fs.rename(generated, committed);
        if (hadCommitted) await Fs.rm(backup, { recursive: true, force: true });
      } catch (error) {
        if (hadCommitted) await Fs.rename(backup, committed).catch(() => undefined);
        throw error;
      }
    }
    console.log(`${check ? "verified" : "updated"} sealed SDK artifact ${id}`);
  }
} finally {
  await Fs.rm(temporary, { recursive: true, force: true });
}
