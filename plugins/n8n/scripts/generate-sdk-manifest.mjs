import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { canonicalJson, validateManifestV1 } from "../../../packages/plugin-sdk/index.mjs";
import * as Schema from "effect/Schema";

import { N8N_TOOLS } from "../.sdk-build/N8nProvider.js";

const manifestPath = Path.resolve(import.meta.dirname, "..", ".tritonai-plugin", "plugin.json");
const current = JSON.parse(await Fs.readFile(manifestPath, "utf8"));
if (current.id !== "n8n" || !Array.isArray(current.tools)) {
  throw new Error("n8n manifest metadata is invalid.");
}
const metadata = new Map(current.tools.map((tool) => [tool.name, tool]));

function inputSchema(input) {
  const document = Schema.toJsonSchemaDocument(input);
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
  if (schema.type === "object" && schema.properties === undefined) schema.properties = {};
  return schema;
}

const tools = N8N_TOOLS.map((tool) => {
  const declared = metadata.get(tool.name);
  if (!declared) throw new Error(`n8n tool metadata is missing: ${tool.name}.`);
  return {
    name: tool.name,
    displayName: declared.displayName,
    description: declared.description,
    capabilities: declared.capabilities,
    effect: tool.readOnly ? "read" : "write",
    destructive: tool.destructive,
    idempotent: tool.idempotent,
    openWorld: tool.openWorld,
    inputSchema: inputSchema(tool.input),
  };
});
if (tools.length !== current.tools.length) {
  throw new Error("n8n tool metadata and reviewed runtime tools drifted.");
}

const manifest = validateManifestV1({
  apiVersion: "tritonai.plugin/v1",
  kind: "IntegrationPlugin",
  manifestVersion: 1,
  id: current.id,
  name: current.name,
  description: current.description,
  version: current.version,
  sdk: { apiMajor: 1, requiredHostContractLevel: 2 },
  entry: "dist/index.mjs",
  provider: current.provider,
  configurationSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      serverUrl: {
        type: "string",
        const: "https://n8n.tritonai.ucsd.edu/mcp-server/http",
      },
    },
    required: ["serverUrl"],
    additionalProperties: false,
  },
  capabilities: current.capabilities.map((capability) => ({
    ...capability,
    access: "authorization",
  })),
  tools,
  skills: current.skills,
});
await Fs.writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
