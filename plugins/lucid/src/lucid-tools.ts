import type { PluginCapability } from "@tritonai/plugin-sdk";

import { type JsonSchema, manifestInputSchema } from "./remote-mcp/json-schema.js";
import type { RemoteMcpPolicy, RemoteMcpTool } from "./remote-mcp/RemoteMcpProvider.js";
import { UPSTREAM_TOOLS } from "./upstream-tools.js";

export const LUCID_ORIGIN = "https://mcp.lucid.app";

export const LUCID_CAPABILITIES: ReadonlyArray<PluginCapability> = [
  {
    id: "read",
    displayName: "Read",
    description:
      "Search and read Lucidchart and Lucidspark documents, folders, comments, and images the connected user can already see. Lucid offers its authoring guides, integration list, style reading, script reference, and diagram checking only when Create and edit is also on.",
    access: "default",
  },
  {
    id: "write",
    displayName: "Create and edit",
    description:
      "Create diagrams, org charts, mind maps, ERDs, sequence diagrams, and folders; change existing documents with Lucid scripts, including deleting shapes and lines; import Jira cards; rename or move documents and folders; post comments; and send feedback to Lucid. Turning this on signs in to Lucid again with edit access.",
    access: "opt-in",
  },
  {
    id: "share",
    displayName: "Share",
    description:
      "Create share links and grant other people access to Lucid documents. Sharing changes who can see a document, including people outside UC San Diego when Lucid allows it.",
    access: "opt-in",
  },
];

type Capability = "read" | "write" | "share";

const UPSTREAM_BY_NAME = new Map(UPSTREAM_TOOLS.map((tool) => [tool.name, tool]));

const nullable = (schema: JsonSchema): JsonSchema => ({
  anyOf: [schema, { type: "null" }],
  default: null,
});
const bounded = (maxLength: number, minLength = 1): JsonSchema => ({
  type: "string",
  minLength,
  maxLength,
});
const product = { type: "string", enum: ["lucidchart", "lucidspark"] };
const optionalProduct = { ...product, default: "lucidchart" };
const title = bounded(3_000);
const shareRole = { type: "string", enum: ["view", "comment", "edit", "editandshare"] };

interface ToolSpec {
  readonly name: string;
  readonly upstream: string;
  readonly displayName: string;
  readonly description: string;
  readonly capability: Capability;
  /** Local flags; writes default to non-destructive and non-idempotent. */
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  /** Tighter property schemas that replace the upstream property in the sealed manifest. */
  readonly refine?: Readonly<Record<string, JsonSchema>>;
  /** Optional upstream properties the agent must state explicitly instead of relying on defaults. */
  readonly require?: ReadonlyArray<string>;
}

function lucidTool(spec: ToolSpec): RemoteMcpTool {
  const upstream = UPSTREAM_BY_NAME.get(spec.upstream);
  if (!upstream) throw new Error(`Lucid upstream tool ${spec.upstream} is not pinned.`);
  const inputSchema = manifestInputSchema(upstream.inputSchema);
  const properties = { ...(inputSchema.properties as Record<string, unknown>) };
  for (const [property, schema] of Object.entries(spec.refine ?? {})) {
    if (!Object.hasOwn(properties, property)) {
      throw new Error(`Lucid tool ${spec.name} refines unknown property ${property}.`);
    }
    properties[property] = schema;
  }
  const required = [...((inputSchema.required as string[] | undefined) ?? [])];
  for (const property of spec.require ?? []) {
    if (!Object.hasOwn(properties, property)) {
      throw new Error(`Lucid tool ${spec.name} requires unknown property ${property}.`);
    }
    if (!required.includes(property)) required.push(property);
  }
  const read = spec.capability === "read";
  return {
    name: spec.name,
    upstreamName: spec.upstream,
    displayName: spec.displayName,
    description: spec.description,
    capability: spec.capability,
    effect: read ? "read" : "write",
    destructive: spec.destructive ?? false,
    idempotent: spec.idempotent ?? read,
    openWorld: true,
    inputSchema: { ...inputSchema, properties, ...(required.length > 0 ? { required } : {}) },
    upstream,
  };
}

const READ_TOOLS: ReadonlyArray<ToolSpec> = [
  {
    name: "lucid.search_documents",
    upstream: "search",
    displayName: "Search documents",
    description:
      "Search the connected user's Lucid documents by title or keyword, optionally filtered by product, creation or modification time, or ownership. Returns titles, IDs, URLs, and parent folder IDs (up to 200, by relevance). Use lucid.search_document_text to find text inside one document.",
    capability: "read",
    refine: {
      query: bounded(400),
      product: nullable({
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { type: "string", enum: ["lucidchart", "lucidspark", "lucidscale"] },
      }),
    },
  },
  {
    name: "lucid.fetch_document",
    upstream: "fetch",
    displayName: "Read document",
    description:
      "Read the structured content of one Lucid document by its UUID, organized by page and spatial region. Call with metadata_only true first to learn page_count and page_region_counts, then read one page (page_index, 1-based) or specific regions (region_index list) to keep results small. The result includes item IDs used by the edit tools.",
    capability: "read",
    refine: {
      page_index: nullable({ type: "integer", minimum: 1 }),
      region_index: nullable({
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "integer", minimum: 1 },
      }),
    },
  },
  {
    name: "lucid.search_document_text",
    upstream: "lucid_search_document",
    displayName: "Search inside a document",
    description:
      "Find which pages and regions of one Lucid document contain given words (case-insensitive substring match over shape and sticky-note text). Returns 1-based pageIndex and regionIndex pairs to pass to lucid.fetch_document.",
    capability: "read",
    refine: {
      queries: { type: "array", minItems: 1, maxItems: 20, items: bounded(200) },
    },
  },
  {
    name: "lucid.get_document_metadata",
    upstream: "lucid_get_document_metadata",
    displayName: "Get document details",
    description:
      "Read a Lucid document's metadata: title, product, page count, last modified time, location, classification, access, and owner when the user may see it.",
    capability: "read",
  },
  {
    name: "lucid.list_folder_contents",
    upstream: "lucid_list_folder_contents",
    displayName: "List folder",
    description:
      "List the documents and subfolders in a Lucid folder, or in the user's root folder when folder_id is omitted. Pass nextPageToken back as page_token for more results.",
    capability: "read",
    refine: {
      page_size: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
  },
  {
    name: "lucid.fetch_item_image",
    upstream: "lucid_fetch_item_image",
    displayName: "Get item image",
    description:
      "Fetch the source image attached to one item in a Lucid document. Large images may exceed the tool result limit.",
    capability: "read",
  },
  {
    name: "lucid.export_page_png",
    upstream: "lucid_export_document_as_PNG",
    displayName: "Export page as PNG",
    description:
      "Export one page of a Lucid document as a PNG image. Optionally crop with a bounding_box whose x, y, w, and h match BoundingBox values from lucid.fetch_document. Large images may exceed the tool result limit; crop to a region when possible.",
    capability: "read",
    refine: { page: { type: "integer", minimum: 1, default: 1 } },
  },
  {
    name: "lucid.list_comment_threads",
    upstream: "list_document_threads",
    displayName: "List comment threads",
    description: "List the comment threads on a Lucid document.",
    capability: "read",
  },
  {
    name: "lucid.list_thread_comments",
    upstream: "list_document_thread_comments",
    displayName: "List thread comments",
    description: "List the comments in one comment thread of a Lucid document.",
    capability: "read",
  },
  {
    name: "lucid.read_resource",
    upstream: "get_mcp_resource",
    displayName: "Read Lucid guide",
    description:
      'Read one of Lucid\'s authoring guides by URI, or list them when resource_uri is omitted. Read "lucid://skills/diagram-specification" before lucid.create_diagram or lucid.validate_diagram, "lucid://skills/sequence-diagram-specification" before lucid.create_sequence_diagram, and "lucid://endpoint-styles" for line arrow names.',
    capability: "read",
    refine: {
      resource_uri: { type: "string", maxLength: 512, pattern: "^(lucid://.*)?$", default: "" },
    },
  },
  {
    name: "lucid.list_integrations",
    upstream: "lucid_list_integrations",
    displayName: "List card integrations",
    description:
      "List the user's Lucid card integrations, such as Jira, with each instance's instanceId and connection status. Required before lucid.import_integration_cards.",
    capability: "read",
  },
  {
    name: "lucid.validate_diagram",
    upstream: "lucid_validate_diagram_specification",
    displayName: "Check diagram specification",
    description:
      "Check Lucid Standard Import JSON for structural and layout problems before lucid.create_diagram. Creates nothing; returns findings with the page, item, and field to fix.",
    capability: "read",
    refine: { standard_import_json: bounded(2_000_000) },
  },
];

const SCRIPT_READ_TOOLS: ReadonlyArray<ToolSpec> = [
  {
    name: "lucid.copy_document_style",
    upstream: "lucid_copy_document_style",
    displayName: "Read document style",
    description:
      "Read the visual style of an existing Lucid document (colors, typography, shapes, connectors, sizing, spacing) to match it when creating a new diagram. Accepts a document UUID or Lucid URL and an optional 1-based page_index. Changes nothing.",
    capability: "read",
    refine: { document: bounded(2_048) },
  },
  {
    name: "lucid.get_script_catalog",
    upstream: "lucid_get_script_catalog",
    displayName: "List document script APIs",
    description:
      "List the Lucid script APIs available for one document and whether each is preloaded or unavailable. Call before lucid.load_script_documentation when editing an existing document.",
    capability: "read",
  },
  {
    name: "lucid.load_script_documentation",
    upstream: "lucid_load_script_documentation",
    displayName: "Read script API documentation",
    description:
      'Read the documentation and examples for one Lucid script API on a document (exact lowercase name; use "basecanvasediting" for ordinary canvas edits), and make it available to later lucid.run_script calls on that document. Read it before writing a script.',
    capability: "read",
    refine: { name: bounded(128) },
  },
];

const WRITE_TOOLS: ReadonlyArray<ToolSpec> = [
  {
    name: "lucid.run_script",
    upstream: "lucid_run_script",
    displayName: "Edit document with a script",
    description:
      "Change an existing Lucid document by running JavaScript against it, for example to add, move, restyle, or delete shapes and lines. Use APIs from lucid.load_script_documentation as skills.<name>.<method>(...). The source runs as an async function with top-level await and may return a JSON value; it cannot use the network or DOM, must finish within 25 seconds, and its changes are atomic (all reverted if it fails). Read the document first and confirm deletions with the user.",
    capability: "write",
    destructive: true,
    refine: { source: bounded(200_000) },
  },
  {
    name: "lucid.create_diagram",
    upstream: "lucid_create_diagram_from_specification",
    displayName: "Create diagram",
    description:
      'Create a new Lucidchart or Lucidspark document from Lucid Standard Import JSON (passed as a string). Before every call, read "lucid://skills/diagram-specification" with lucid.read_resource and follow it exactly; optionally check the JSON with lucid.validate_diagram. Use lucid.create_diagram_from_mermaid for existing Mermaid, lucid.create_sequence_diagram, lucid.create_erd, lucid.create_org_chart, or lucid.create_mind_map when they fit better. Limit 2 MB.',
    capability: "write",
    refine: { title, product, standard_import_json: bounded(2_000_000) },
  },
  {
    name: "lucid.create_diagram_from_mermaid",
    upstream: "lucid_create_diagram_from_mermaid",
    displayName: "Create diagram from Mermaid",
    description:
      "Create a new Lucid document from Mermaid source the user already has. Do not write Mermaid only to call this tool; use lucid.create_diagram for new diagrams.",
    capability: "write",
    refine: { title, mermaid_markup: bounded(100_000), product: optionalProduct },
  },
  {
    name: "lucid.create_erd",
    upstream: "lucid_create_erd",
    displayName: "Create ERD",
    description:
      'Create a new Lucid document with an editable entity relationship diagram. entities: up to 200 objects with id, name, and attributes [{name, type?, key? such as "PK"}]. relationships: objects with from (entity holding the foreign key), to, and optional fromAttribute, toAttribute, fromCardinality, toCardinality (one, many, zeroOrOne, zeroOrMore, oneOrMore, exactlyOne), and label.',
    capability: "write",
    refine: {
      title,
      product: optionalProduct,
      entities: { type: "array", minItems: 1, maxItems: 200, items: { type: "object" } },
      relationships: { type: "array", maxItems: 2_000, items: { type: "object" } },
    },
  },
  {
    name: "lucid.create_mind_map",
    upstream: "lucid_create_mind_map",
    displayName: "Create mind map",
    description:
      "Create a new Lucid document with a mind map from a flat list of up to 1000 nodes, each {id, text, parentId}. Exactly one root node has a null or missing parentId.",
    capability: "write",
    refine: {
      title,
      product: optionalProduct,
      nodes: { type: "array", minItems: 1, maxItems: 1_000, items: { type: "object" } },
    },
  },
  {
    name: "lucid.create_org_chart",
    upstream: "lucid_create_org_chart",
    displayName: "Create org chart",
    description:
      "Create a new Lucidchart document with an org chart from a flat list of up to 1000 nodes, each {id, name, managerId, role?, imageUrl?}. Exactly one top node has a null or missing managerId.",
    capability: "write",
    refine: {
      title,
      nodes: { type: "array", minItems: 1, maxItems: 1_000, items: { type: "object" } },
    },
  },
  {
    name: "lucid.create_sequence_diagram",
    upstream: "lucid_create_sequence_diagram",
    displayName: "Create sequence diagram",
    description:
      'Create a new Lucid document with a UML sequence diagram from PlantUML sequence markup (max 50 KB). Read "lucid://skills/sequence-diagram-specification" with lucid.read_resource first.',
    capability: "write",
    refine: { title, product, markup: bounded(51_200) },
  },
  {
    name: "lucid.create_folder",
    upstream: "lucid_create_folder",
    displayName: "Create folder",
    description:
      'Create a Lucid folder (folder_type "folder", or "team" for a team folder). Pass a numeric parent folder ID to nest it; omit parent for the root.',
    capability: "write",
    refine: {
      name: { type: "string", minLength: 1, maxLength: 300, pattern: "^\\S(?:.*\\S)?$" },
      folder_type: { type: "string", enum: ["folder", "team"], default: "folder" },
    },
  },
  {
    name: "lucid.update_document",
    upstream: "lucid_update_document",
    displayName: "Rename or move document",
    description:
      'Rename a Lucid document, move it to another folder (numeric folder ID, or "root"), or replace its custom tags (an empty list clears them). Provide at least one change.',
    capability: "write",
    destructive: true,
    idempotent: true,
    refine: {
      title: nullable(bounded(3_000)),
      custom_tags: nullable({ type: "array", maxItems: 100, items: bounded(256) }),
    },
  },
  {
    name: "lucid.update_folder",
    upstream: "lucid_update_folder",
    displayName: "Rename or move folder",
    description:
      'Rename a Lucid folder or move it under another folder (numeric folder ID, or "root"). Provide at least one change.',
    capability: "write",
    destructive: true,
    idempotent: true,
    refine: { name: nullable(bounded(300)) },
  },
  {
    name: "lucid.import_integration_cards",
    upstream: "lucid_import_integration_cards",
    displayName: "Import Jira cards",
    description:
      'Import records, such as Jira issues by key, as linked cards on a Lucid document page. instance_id must be an instanceId from lucid.list_integrations. If the user is not connected, Lucid returns a connect_url; send the user there rather than signing in for them. layout is "grid", "row", or "column".',
    capability: "write",
    refine: {
      integration_id: { type: "string", enum: ["jira"] },
      record_keys: { type: "array", minItems: 1, maxItems: 200, items: bounded(128) },
      layout: { type: "string", enum: ["grid", "row", "column"], default: "grid" },
    },
  },
  {
    name: "lucid.post_comment",
    upstream: "post_document_thread_comment",
    displayName: "Reply to comment thread",
    description:
      "Post a comment to an existing comment thread on a Lucid document. Get thread IDs from lucid.list_comment_threads.",
    capability: "write",
    refine: { content: bounded(10_000) },
  },
  {
    name: "lucid.submit_feedback",
    upstream: "lucid_submit_feedback",
    displayName: "Send feedback to Lucid",
    description:
      "Send feedback about Lucid's MCP tools to Lucid's product team, with the user's Lucid user and account IDs. Use only when the user explicitly asks to send Lucid feedback, and show them the exact text first.",
    capability: "write",
    refine: { title: bounded(200), feedback: bounded(10_000) },
  },
];

const SHARE_TOOLS: ReadonlyArray<ToolSpec> = [
  {
    name: "lucid.create_share_link",
    upstream: "lucid_create_document_share_link",
    displayName: "Create share link",
    description:
      "Create a share link for a Lucid document with role view, comment, edit, or editandshare. Always state restrict_to_account (true keeps the link to the user's Lucid account) and allow_anonymous (false requires sign-in); set them to false and true only when the user explicitly asks. Optional expires is an ISO 8601 time.",
    capability: "share",
    refine: {
      role: shareRole,
      expires: nullable(bounded(64)),
      restrict_to_account: { type: "boolean" },
      allow_anonymous: { type: "boolean" },
    },
    require: ["restrict_to_account", "allow_anonymous"],
  },
  {
    name: "lucid.share_with_collaborators",
    upstream: "share_document_with_collaborators",
    displayName: "Share with people",
    description:
      "Grant people access to a Lucid document by email address (up to 100) with role view, comment, edit, or editandshare. Always state the role, choosing the narrowest one the user asked for. Results report success or failure per email.",
    capability: "share",
    idempotent: true,
    require: ["role"],
    refine: {
      emails: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        items: { type: "string", minLength: 3, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+$" },
      },
      role: shareRole,
    },
  },
];

/**
 * Lucid tools that are deliberately not exposed: internal MCP Apps embed helpers that mint embed
 * IDs and session tokens for widgets rather than doing user work.
 */
export const EXCLUDED_UPSTREAM_TOOLS: ReadonlyArray<string> = [
  "_lucid_create_embed",
  "_lucid_create_embed_session_token",
];

export const LUCID_TOOLS: ReadonlyArray<RemoteMcpTool> = [
  ...READ_TOOLS,
  ...SCRIPT_READ_TOOLS,
  ...WRITE_TOOLS,
  ...SHARE_TOOLS,
].map(lucidTool);

export const LUCID_POLICY: RemoteMcpPolicy = {
  providerId: "lucid",
  serviceName: "Lucid",
  origin: LUCID_ORIGIN,
  endpoints: [
    // Lucid's revocation endpoint rejects every read-only grant ("Token not valid for this MCP
    // endpoint"), observed 2026-10-07.
    { path: "/mcp/readonly", capabilities: ["read"], label: "Read-only", revocable: false },
    { path: "/mcp", capabilities: ["read", "write", "share"], label: "Full" },
  ],
  oauth: {
    clientName: "TritonAI Harness",
    scopes: ["offline_access"],
    paths: {
      authorization: "/oauth/authorize",
      token: "/oauth/token",
      registration: "/oauth/register",
      revocation: "/oauth/revoke",
    },
    // Lucid's authorization server does not advertise RFC 9207 issuer identification.
    requireIssuerParameter: false,
    // Lucid's revocation endpoint requires a bearer access token from the grant being revoked.
    revocation: "bearer",
  },
  tools: LUCID_TOOLS,
  writeFailureNote:
    "Lucid reported that this change failed. Part of it may still have been applied; read the document again before retrying.",
};
