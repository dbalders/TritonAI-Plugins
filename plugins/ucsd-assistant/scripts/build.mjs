import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { canonicalJson, validateManifestV1 } from "../../../packages/plugin-sdk/index.mjs";

const root = Path.resolve(import.meta.dirname, "..");
const temporary = Path.join(root, ".sdk-build");
await Fs.mkdir(temporary, { recursive: true });
try {
  await build({
    entryPoints: [Path.join(root, "src/manifest.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: Path.join(temporary, "manifest.mjs"),
  });
  const { pluginManifest } = await import(pathToFileURL(Path.join(temporary, "manifest.mjs")));
  const packageJson = JSON.parse(await Fs.readFile(Path.join(root, "package.json"), "utf8"));
  const manifest = validateManifestV1({ ...pluginManifest, version: packageJson.version });
  await Fs.mkdir(Path.join(root, ".tritonai-plugin"), { recursive: true });
  await Fs.writeFile(
    Path.join(root, ".tritonai-plugin/plugin.json"),
    `${canonicalJson(manifest)}\n`,
  );
  await build({
    entryPoints: [Path.join(root, "src/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: Path.join(root, "dist/index.mjs"),
  });
} finally {
  await Fs.rm(temporary, { recursive: true, force: true });
}
