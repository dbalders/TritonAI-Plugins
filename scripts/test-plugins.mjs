import * as Path from "node:path";
import { spawnSync } from "node:child_process";

import { discoverPluginDirectories } from "./plugin-directories.mjs";

const root = Path.resolve(import.meta.dirname, "..");
const pluginsRoot = Path.join(root, "plugins");
const directories = await discoverPluginDirectories(pluginsRoot);

if (directories.length === 0) {
  console.log("plugin tests passed for empty framework");
} else {
  const result = spawnSync("pnpm", ["exec", "vp", "test", "run", "plugins", "--passWithNoTests"], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
