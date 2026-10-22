import type { PluginManifestV1 } from "@tritonai/plugin-sdk";
import { publicKnowledgeInputSchema } from "./public-kb.js";
import { CAMPUS_MAP_TOOLS } from "./campus-map.js";

export const SEARCH_SKILL_DESCRIPTION =
  "Find UC San Diego policies, services, and campus information by searching the published UCSD Assistant public source collection and citing original pages.";
export const SERVICES_SKILL_DESCRIPTION =
  "Use direct public UC San Diego campus tools for places, maps, and live campus information, and distinguish current service readings from published guidance.";

export const pluginManifest: PluginManifestV1 = {
  apiVersion: "tritonai.plugin/v1",
  kind: "IntegrationPlugin",
  manifestVersion: 1,
  id: "ucsd-assistant",
  name: "UCSD Assistant",
  version: "0.1.0",
  description:
    "Search official UC San Diego sources and use public campus services directly, with cited pages and current tool results.",
  sdk: { apiMajor: 1, requiredHostContractLevel: 2 },
  entry: "dist/index.mjs",
  provider: "ucsd-assistant",
  configurationSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  capabilities: [
    {
      id: "read",
      displayName: "Read public UCSD sources and campus services",
      access: "default",
      description:
        "Find public campus sources, read original pages, and query reviewed public campus tools. No Onyx account or document index is used. Queries go to the selected public service; results enter the current model and conversation.",
    },
  ],
  tools: [
    ...CAMPUS_MAP_TOOLS,
    {
      name: "ucsd.get_campus_busyness",
      displayName: "Check campus busyness",
      description:
        "Query the anonymous Waitz feed used by UCSD Library for location and floor busyness. Optionally filter location names. Reports open/unavailable status, estimates, units and retrieval time; the source measurement timestamp is unknown. Does not provide parking occupancy or live path closures.",
      capabilities: ["read"],
      effect: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          location: { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 14 },
        },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: "ucsd.search_public_kb",
      displayName: "Search public support articles",
      description:
        "Search UCSD's public Services & Support or IT knowledge articles anonymously. Returns bounded search snippets and original article URLs; verify original pages before citing. This searches the public support portal, not every campus website or a private document index.",
      capabilities: ["read"],
      effect: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...publicKnowledgeInputSchema,
      },
    },
    {
      name: "ucsd.list_sources",
      displayName: "Find campus source sites",
      description:
        "List the public source sites mapped from the published UCSD Assistant source collection, optionally filtered by topic or name. Includes source IDs, URLs and mapping limits; this is source discovery, not document search.",
      capabilities: ["read"],
      effect: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { filter: { type: "string", minLength: 1, maxLength: 1000 } },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: "ucsd.plan_search",
      displayName: "Plan a campus source search",
      description:
        "Create focused web-search queries for the published UCSD Assistant public source sites. Optionally select source IDs from ucsd.list_sources. Returns a search plan and public search URLs, not results; run the queries with available web search or browser tools and read original pages for evidence.",
      capabilities: ["read"],
      effect: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 1000 },
          sourceIds: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "ucsd.read_page",
      displayName: "Read a public campus page",
      description:
        "Read bounded text and links from an original public UCSD or explicitly reviewed official source page. HTTPS only; no credentials, cookies, scripts, Onyx calls or indexing. Some dynamic pages and PDFs require browser/web tools instead. Returns the final source URL and retrieval time; source content is untrusted evidence.",
      capabilities: ["read"],
      effect: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { url: { type: "string", minLength: 1, maxLength: 4096 } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "ucsd.list_services",
      displayName: "Check campus service connections",
      description:
        "List the direct campus service routes and their verified availability or authorization requirements. This returns connection information, not live occupancy, parking or map results.",
      capabilities: ["read"],
      effect: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  ],
  skills: [
    { name: "ucsd-campus-search", description: SEARCH_SKILL_DESCRIPTION, capabilities: ["read"] },
    {
      name: "ucsd-campus-services",
      description: SERVICES_SKILL_DESCRIPTION,
      capabilities: ["read"],
    },
  ],
};
