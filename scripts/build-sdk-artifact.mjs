#!/usr/bin/env node
import * as Path from "node:path";

import { buildPluginArtifact } from "./sdk-artifact.mjs";

const [source, output] = process.argv.slice(2);
if (!source || !output) {
  throw new Error(
    "Usage: node scripts/build-sdk-artifact.mjs <plugin-directory> <output-directory>",
  );
}
const descriptor = await buildPluginArtifact(Path.resolve(source), Path.resolve(output));
console.log(
  `built ${descriptor.plugin.id}@${descriptor.plugin.version} -> ${Path.resolve(output)}`,
);
