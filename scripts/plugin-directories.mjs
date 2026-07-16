import * as Fs from "node:fs/promises";
import * as Path from "node:path";

const allowedRootFiles = new Set(["README.md"]);

export async function discoverPluginDirectories(pluginsRoot) {
  const entries = await Fs.readdir(pluginsRoot, { withFileTypes: true });
  const symlinks = entries.filter((entry) => entry.isSymbolicLink());
  if (symlinks.length > 0) {
    throw new Error(
      `Plugin package entries must not be symbolic links: ${symlinks
        .map((entry) => entry.name)
        .toSorted()
        .join(", ")}`,
    );
  }
  const unexpected = entries.filter(
    (entry) => !entry.isDirectory() && !(entry.isFile() && allowedRootFiles.has(entry.name)),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected entries under plugins/: ${unexpected
        .map((entry) => entry.name)
        .toSorted()
        .join(", ")}`,
    );
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => Path.basename(entry.name))
    .toSorted();
}
