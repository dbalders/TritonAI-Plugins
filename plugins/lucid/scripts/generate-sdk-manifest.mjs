import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { canonicalJson, validateManifestV1 } from "../../../packages/plugin-sdk/index.mjs";

import { LUCID_CAPABILITIES, LUCID_ORIGIN, LUCID_TOOLS } from "../.sdk-build/lucid-tools.js";

const root = Path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await Fs.readFile(Path.join(root, "package.json"), "utf8"));
const manifestPath = Path.join(root, ".tritonai-plugin", "plugin.json");

const manifest = validateManifestV1({
  apiVersion: "tritonai.plugin/v1",
  kind: "IntegrationPlugin",
  manifestVersion: 1,
  id: "lucid",
  name: "Lucid",
  description:
    "Search, read, create, and edit Lucidchart and Lucidspark documents through Lucid's official MCP server with the connected user's own Lucid access.",
  version: packageJson.version,
  sdk: { apiMajor: 1, requiredHostContractLevel: 2 },
  entry: "dist/index.mjs",
  provider: "lucid",
  configurationSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { serverOrigin: { type: "string", const: LUCID_ORIGIN } },
    required: ["serverOrigin"],
    additionalProperties: false,
  },
  capabilities: LUCID_CAPABILITIES,
  tools: LUCID_TOOLS.map((tool) => ({
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    capabilities: [tool.capability],
    effect: tool.effect,
    destructive: tool.destructive,
    idempotent: tool.idempotent,
    openWorld: tool.openWorld,
    inputSchema: tool.inputSchema,
  })),
  skills: [
    {
      name: "lucid-diagrams",
      description:
        "Find, read, create, edit, comment on, organize, or share Lucidchart and Lucidspark documents through TritonAI Harness using the connected user's Lucid access.",
      capabilities: LUCID_CAPABILITIES.map((capability) => capability.id),
    },
  ],
});
await Fs.mkdir(Path.dirname(manifestPath), { recursive: true });
await Fs.writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
