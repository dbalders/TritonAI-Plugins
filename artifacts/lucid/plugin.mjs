// src/remote-mcp/json-schema.ts
import * as NodeUtil from "node:util";
function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var VALIDATED_KEYWORDS = /* @__PURE__ */ new Set([
  "$defs",
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type",
  "uniqueItems"
]);
var IGNORED_KEYWORDS = /* @__PURE__ */ new Set([
  "$comment",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "format",
  "readOnly",
  "title",
  "writeOnly"
]);
var SCHEMA_TYPES = /* @__PURE__ */ new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
function resolveReference(root, reference, path) {
  if (!reference.startsWith("#/")) {
    throw new Error(`Schema at ${path} uses a non-local reference.`);
  }
  let current = root;
  for (const encoded of reference.slice(2).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!plainRecord(current) || !Object.hasOwn(current, segment)) {
      throw new Error(`Schema at ${path} has an unresolved reference ${reference}.`);
    }
    current = current[segment];
  }
  if (!plainRecord(current)) throw new Error(`Schema at ${path} references a non-schema.`);
  return current;
}
function assertSupported(schema, path) {
  for (const key of Object.keys(schema)) {
    if (!VALIDATED_KEYWORDS.has(key) && !IGNORED_KEYWORDS.has(key)) {
      throw new Error(`Schema at ${path} uses unsupported keyword ${key}.`);
    }
  }
  const type = schema.type;
  if (type !== void 0) {
    const types = Array.isArray(type) ? type : [type];
    if (types.length === 0 || types.some((entry) => !SCHEMA_TYPES.has(entry))) {
      throw new Error(`Schema at ${path} has an unsupported type.`);
    }
  }
  const numeric = [
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maxItems",
    "maxLength",
    "maximum",
    "minItems",
    "minLength",
    "minimum"
  ];
  for (const key of numeric) {
    if (schema[key] !== void 0 && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      throw new Error(`Schema at ${path}.${key} must be a finite number.`);
    }
  }
  if (schema.pattern !== void 0) {
    if (typeof schema.pattern !== "string")
      throw new Error(`Schema at ${path}.pattern is invalid.`);
    new RegExp(schema.pattern, "u");
  }
  if (schema.required !== void 0 && (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string"))) {
    throw new Error(`Schema at ${path}.required is invalid.`);
  }
  if (schema.enum !== void 0 && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`Schema at ${path}.enum is invalid.`);
  }
  if (schema.uniqueItems !== void 0 && typeof schema.uniqueItems !== "boolean") {
    throw new Error(`Schema at ${path}.uniqueItems is invalid.`);
  }
  if (schema.properties !== void 0 && !plainRecord(schema.properties)) {
    throw new Error(`Schema at ${path}.properties is invalid.`);
  }
  if (schema.items !== void 0 && schema.items !== true && !plainRecord(schema.items)) {
    throw new Error(`Schema at ${path}.items uses an unsupported form.`);
  }
  if (schema.additionalProperties !== void 0 && typeof schema.additionalProperties !== "boolean" && !plainRecord(schema.additionalProperties)) {
    throw new Error(`Schema at ${path}.additionalProperties is invalid.`);
  }
}
function typeMatches(type, value) {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return plainRecord(value);
    default:
      return false;
  }
}
function codePointLength(value) {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}
function compileSchema(root) {
  const patterns = /* @__PURE__ */ new Map();
  const visit = (schema, path, seen) => {
    assertSupported(schema, path);
    if (typeof schema.$ref === "string") {
      if (seen.has(schema.$ref)) throw new Error(`Schema at ${path} has a recursive reference.`);
      visit(resolveReference(root, schema.$ref, path), path, /* @__PURE__ */ new Set([...seen, schema.$ref]));
    }
    if (typeof schema.pattern === "string" && !patterns.has(schema.pattern)) {
      patterns.set(schema.pattern, new RegExp(schema.pattern, "u"));
    }
    if (plainRecord(schema.properties)) {
      for (const [name, child] of Object.entries(schema.properties)) {
        if (!plainRecord(child)) throw new Error(`Schema at ${path}.${name} is not an object.`);
        visit(child, `${path}.${name}`, seen);
      }
    }
    if (plainRecord(schema.$defs)) {
      for (const [name, child] of Object.entries(schema.$defs)) {
        if (!plainRecord(child)) throw new Error(`Schema at ${path}.$defs.${name} is invalid.`);
      }
    }
    if (plainRecord(schema.items)) visit(schema.items, `${path}[]`, seen);
    if (plainRecord(schema.additionalProperties)) {
      visit(schema.additionalProperties, `${path}.*`, seen);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      const members = schema[keyword];
      if (members === void 0) continue;
      if (!Array.isArray(members) || members.length === 0) {
        throw new Error(`Schema at ${path}.${keyword} is invalid.`);
      }
      members.forEach((member, index) => {
        if (!plainRecord(member)) throw new Error(`Schema at ${path}.${keyword} is invalid.`);
        visit(member, `${path}.${keyword}[${index}]`, seen);
      });
    }
  };
  visit(root, "$", /* @__PURE__ */ new Set());
  const check = (schema, value, path) => {
    if (typeof schema.$ref === "string") {
      const failure = check(resolveReference(root, schema.$ref, path), value, path);
      if (failure) return failure;
    }
    if (schema.type !== void 0) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((type) => typeMatches(type, value))) {
        return `${path} must be ${types.join(" or ")}`;
      }
    }
    if ("const" in schema && !NodeUtil.isDeepStrictEqual(schema.const, value)) {
      return `${path} must equal ${JSON.stringify(schema.const)}`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((entry) => NodeUtil.isDeepStrictEqual(entry, value))) {
      return `${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`;
    }
    if (typeof value === "string") {
      const length = codePointLength(value);
      if (typeof schema.minLength === "number" && length < schema.minLength) {
        return `${path} must have at least ${schema.minLength} characters`;
      }
      if (typeof schema.maxLength === "number" && length > schema.maxLength) {
        return `${path} must have at most ${schema.maxLength} characters`;
      }
      if (typeof schema.pattern === "string" && !patterns.get(schema.pattern).test(value)) {
        return `${path} does not match the required pattern`;
      }
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        return `${path} must be at least ${schema.minimum}`;
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        return `${path} must be at most ${schema.maximum}`;
      }
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
        return `${path} must be greater than ${schema.exclusiveMinimum}`;
      }
      if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
        return `${path} must be less than ${schema.exclusiveMaximum}`;
      }
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        return `${path} must have at least ${schema.minItems} items`;
      }
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        return `${path} must have at most ${schema.maxItems} items`;
      }
      if (schema.uniqueItems === true) {
        for (let left = 0; left < value.length; left += 1) {
          for (let right = left + 1; right < value.length; right += 1) {
            if (NodeUtil.isDeepStrictEqual(value[left], value[right])) {
              return `${path} must not repeat items`;
            }
          }
        }
      }
      if (plainRecord(schema.items)) {
        for (let index = 0; index < value.length; index += 1) {
          const failure = check(schema.items, value[index], `${path}[${index}]`);
          if (failure) return failure;
        }
      }
    }
    if (plainRecord(value)) {
      const properties = plainRecord(schema.properties) ? schema.properties : {};
      if (Array.isArray(schema.required)) {
        for (const name of schema.required) {
          if (!Object.hasOwn(value, name)) return `${path}.${name} is required`;
        }
      }
      for (const [name, member] of Object.entries(value)) {
        if (Object.hasOwn(properties, name)) {
          const failure = check(properties[name], member, `${path}.${name}`);
          if (failure) return failure;
        } else if (schema.additionalProperties === false) {
          return `${path}.${name} is not allowed`;
        } else if (plainRecord(schema.additionalProperties)) {
          const failure = check(schema.additionalProperties, member, `${path}.${name}`);
          if (failure) return failure;
        }
      }
    }
    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) {
        const failure = check(member, value, path);
        if (failure) return failure;
      }
    }
    if (Array.isArray(schema.anyOf)) {
      const members = schema.anyOf;
      if (!members.some((member) => check(member, value, path) === null)) {
        return `${path} does not match any allowed shape`;
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const matches = schema.oneOf.filter(
        (member) => check(member, value, path) === null
      ).length;
      if (matches !== 1) return `${path} must match exactly one allowed shape`;
    }
    return null;
  };
  return { validate: (value) => check(root, value, "$") };
}
var STRUCTURAL_SCHEMA_KEYS = /* @__PURE__ */ new Set([
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "default",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "enum",
  "if",
  "items",
  "not",
  "oneOf",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "required",
  "then",
  "type"
]);
function schemaContract(value, root = value, activeReferences = /* @__PURE__ */ new Set()) {
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => schemaContract(entry, root, activeReferences));
    return mapped.every((entry) => typeof entry === "string") ? mapped.toSorted() : mapped;
  }
  if (!plainRecord(value)) return value;
  if (typeof value.$ref === "string" && !activeReferences.has(value.$ref) && plainRecord(root)) {
    let resolved = null;
    try {
      resolved = resolveReference(root, value.$ref, "$");
    } catch {
      resolved = null;
    }
    if (resolved) {
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
      return schemaContract(
        { ...resolved, ...siblings },
        root,
        /* @__PURE__ */ new Set([...activeReferences, value.$ref])
      );
    }
  }
  if (Array.isArray(value.type) && !("anyOf" in value)) {
    const { type, ...rest } = value;
    if (type.length === 1)
      return schemaContract({ ...rest, type: type[0] }, root, activeReferences);
    return schemaContract(
      { ...rest, anyOf: type.map((entry) => ({ type: entry })) },
      root,
      activeReferences
    );
  }
  const normalized = {};
  for (const key of Object.keys(value).filter((entry) => STRUCTURAL_SCHEMA_KEYS.has(entry)).toSorted()) {
    if (key === "properties") {
      if (!plainRecord(value.properties)) continue;
      const properties = value.properties;
      normalized.properties = Object.fromEntries(
        Object.keys(properties).toSorted().map((name) => [name, schemaContract(properties[name], root, activeReferences)])
      );
      continue;
    }
    if (key === "additionalProperties") {
      if (value.additionalProperties === true) continue;
    }
    normalized[key] = schemaContract(value[key], root, activeReferences);
  }
  if ("const" in value && !("enum" in value)) {
    normalized.enum = [schemaContract(value.const, root, activeReferences)];
  }
  if (plainRecord(normalized.properties) && Object.keys(normalized.properties).length === 0) {
    delete normalized.properties;
  }
  if (plainRecord(normalized.items) && Object.keys(normalized.items).length === 0) {
    delete normalized.items;
  }
  if (Array.isArray(normalized.required) && normalized.required.length === 0) {
    delete normalized.required;
  }
  return normalized;
}
function compatibleUpstreamSchema(live, pinned) {
  const liveContract = schemaContract(live);
  const pinnedContract = schemaContract(pinned);
  if (NodeUtil.isDeepStrictEqual(liveContract, pinnedContract)) return true;
  if (!plainRecord(liveContract) || !plainRecord(pinnedContract)) return false;
  if (liveContract.type !== "object" || pinnedContract.type !== "object") return false;
  const liveProperties = plainRecord(liveContract.properties) ? liveContract.properties : {};
  const pinnedProperties = plainRecord(pinnedContract.properties) ? pinnedContract.properties : {};
  const liveRequired = new Set(
    Array.isArray(liveContract.required) ? liveContract.required : []
  );
  const pinnedRequired = new Set(
    Array.isArray(pinnedContract.required) ? pinnedContract.required : []
  );
  for (const name of liveRequired) {
    if (!pinnedRequired.has(name)) return false;
  }
  for (const [name, schema] of Object.entries(pinnedProperties)) {
    if (!Object.hasOwn(liveProperties, name)) return false;
    if (!NodeUtil.isDeepStrictEqual(liveProperties[name], schema)) return false;
  }
  const { properties: _liveProperties, required: _liveRequired, ...liveRest } = liveContract;
  const {
    properties: _pinnedProperties,
    required: _pinnedRequired,
    ...pinnedRest
  } = pinnedContract;
  return NodeUtil.isDeepStrictEqual(liveRest, pinnedRest);
}
function manifestInputSchema(upstream) {
  const rewrite = (value) => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!plainRecord(value)) return value;
    const result = {};
    for (const [key, member] of Object.entries(value)) {
      if (key === "$ref" && typeof member === "string" && member.startsWith("#/definitions/")) {
        result.$ref = `#/$defs/${member.slice("#/definitions/".length)}`;
        continue;
      }
      if (key === "definitions") {
        result.$defs = rewrite(member);
        continue;
      }
      if (key === "$schema") continue;
      result[key] = rewrite(member);
    }
    return result;
  };
  const body = rewrite(upstream);
  if (body.type !== "object") throw new Error("Upstream tool input schema must be an object.");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...body,
    properties: plainRecord(body.properties) ? body.properties : {},
    additionalProperties: false
  };
}

// src/upstream-tools.ts
var UPSTREAM_TOOLS = [
  {
    name: "_lucid_create_embed",
    title: "Create Lucid Embed",
    description: "Internal tool for MCP Apps extension only. Creates an embed for a Lucid document, returning an embed ID.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        }
      },
      required: ["document_id"],
      title: "_lucid_create_embedArguments",
      type: "object"
    }
  },
  {
    name: "_lucid_create_embed_session_token",
    title: "Create Lucid Embed Session Token",
    description: "Internal tool for MCP Apps extension only. Creates a session token for an existing embed, returning a token and embed URL.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        embed_id: {
          title: "Embed Id",
          type: "string"
        },
        origin: {
          title: "Origin",
          type: "string"
        },
        page_id: {
          anyOf: [
            {
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Page Id"
        }
      },
      required: ["embed_id", "origin"],
      title: "_lucid_create_embed_session_tokenArguments",
      type: "object"
    }
  },
  {
    name: "fetch",
    title: "Fetch Lucid Document Content",
    description: "Retrieves the structured content of a specific Lucid document by its ID.\n\n        Returns document content organized by pages, each containing spatial regions\n        of diagram elements (flowcharts, ERDs, mind maps, etc.) with their properties.\n\n        By default, returns the first page of the document. Use page_index to fetch\n        a specific page. The response metadata includes page_count and\n        page_region_counts so you know what pages and regions are available.\n\n        For large pages with many regions, use region_index to fetch specific\n        spatial regions instead of the entire page.\n\n        Call with metadata_only=True first when you don't know the document's\n        size \u2014 that returns page_count, page_region_counts, title, and edit_url\n        without the content payload, so you can decide whether to fetch by page\n        or by region before paying the size cost.\n\n        If the response is too large, you MUST ask the user if they would like to\n        fetch the document contents region by region.\n\n        Args:\n            id: Valid UUID of the document\n            page_index: Optional 1-based page index. Defaults to 1 (first page).\n            region_index: Optional list of 1-based indices selecting spatial regions\n                            within the requested page. Each page is independently\n                            chunked, so the valid range is 1 through the value in\n                            page_region_counts for that page. Pass multiple values\n                            (e.g. [1, 3, 5]) to fetch several regions in one call.\n                            Omit to fetch all regions on the page.\n            metadata_only: When True, skip fetching content and return only\n                            document metadata (page_count, page_region_counts,\n                            title, edit_url). Use this to size up a document\n                            before deciding how to fetch it.\n        ",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        id: {
          title: "Id",
          type: "string"
        },
        page_index: {
          anyOf: [
            {
              type: "integer"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Page Index"
        },
        region_index: {
          anyOf: [
            {
              items: {
                type: "integer"
              },
              type: "array"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Region Index"
        },
        metadata_only: {
          anyOf: [
            {
              type: "boolean"
            },
            {
              type: "null"
            }
          ],
          default: false,
          title: "Metadata Only"
        }
      },
      required: ["id"],
      title: "fetchArguments",
      type: "object"
    }
  },
  {
    name: "get_mcp_resource",
    title: "Get MCP Resource",
    description: 'Reads a resource from this MCP server by URI.\n\n        When a tool description says to read a resource (e.g. "read lucid://skills/diagram-specification"),\n        use this tool with that URI to retrieve the full content.\n\n        Call with no arguments to list all available resources and their URIs. The "lucid://skills" resource lists all available skills.\n\n        Args:\n            resource_uri: The URI of the resource to read (e.g. "lucid://skills/diagram-specification").\n                Leave empty to list available resources.\n        ',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: false
    },
    inputSchema: {
      properties: {
        resource_uri: {
          default: "",
          title: "Resource Uri",
          type: "string"
        }
      },
      title: "get_mcp_resourceArguments",
      type: "object"
    }
  },
  {
    name: "list_document_thread_comments",
    title: "List Lucid Document Thread Comments",
    description: "List comments on a specific collaboration thread of a Lucid document.\n\n        Args:\n            document_id: The UUID of the document.\n            thread_id: The ID of the thread whose comments to fetch.\n\n        Returns:\n            JSON string of the Lucid API response (array of comment objects).\n        ",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        thread_id: {
          title: "Thread Id",
          type: "string"
        }
      },
      required: ["document_id", "thread_id"],
      title: "list_document_thread_commentsArguments",
      type: "object"
    }
  },
  {
    name: "list_document_threads",
    title: "List Lucid Document Threads",
    description: "List collaboration threads on a Lucid document.\n\n        Args:\n            document_id: The UUID of the document.\n\n        Returns:\n            JSON string of the Lucid API response (array of thread objects).\n        ",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        }
      },
      required: ["document_id"],
      title: "list_document_threadsArguments",
      type: "object"
    }
  },
  {
    name: "lucid_copy_document_style",
    title: "Copy Lucid Document Style",
    description: "Read a Lucid document's visual style to use when creating diagrams.\n\n            Use when the user asks to match or copy the style of an existing\n            document. Returns a compact style profile and guidance for applying\n            its colors, typography, shapes, connectors, sizing, and spacing.\n            Does not create or modify documents or copy their prose.\n            If the source document is not identified, search for it first.\n\n            Args:\n                document: Source document UUID or HTTPS Lucid document URL.\n                page_index: Optional one-based page number; omit to analyze all pages.\n            ",
    annotations: {
      readOnlyHint: true,
      destructiveHint: null,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document: {
          title: "Document",
          type: "string"
        },
        page_index: {
          anyOf: [
            {
              type: "integer"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Page Index"
        }
      },
      required: ["document"],
      title: "lucid_copy_document_styleArguments",
      type: "object"
    }
  },
  {
    name: "lucid_create_diagram_from_mermaid",
    title: "Create Lucid Diagram from Mermaid",
    description: `Creates a Lucid document from existing Mermaid code at the user's request.

        STOP. Read this ENTIRE description before calling. The rules below are
        load-bearing \u2014 skipping them produces broken documents or wastes the
        user's tokens. Re-read on every call; don't rely on memory.

        Use this tool with Mermaid source code already present in the conversation
        or a user-provided file, including previously shared assistant-generated Mermaid that the
        user now wants to import.

        When the user asks to create, render, visualize, or share a diagram from
        that code, use this tool. The user does not need to explicitly name Lucid
        or request a conversion.

        Do not generate Mermaid solely as an intermediate step to call this tool.

        When the user requests a diagram without asking for Mermaid or a diagram
        from existing Mermaid source code, prefer creating the diagram directly in Lucid using
        lucid_create_diagram_from_specification over generating Mermaid code in
        the conversation. Follow that tool's prerequisites and intent rules.
        If the user explicitly requests Mermaid source code as the output,
        honor that request; you should then offer to import it into Lucid.

        If the user asks only to explain, review, or debug Mermaid code, answer
        that request without creating a document unless they also ask to see
        the diagram.

        For sequence diagrams, use lucid_create_sequence_diagram.
        For ERDs, use lucid_create_erd.

        Args:
            title: The title for the new document.
            mermaid_markup: Mermaid source code the user wants to import (must contain a valid Mermaid diagram).
            product: Target product - "lucidchart" or "lucidspark". Defaults to
                "lucidchart".
        `,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        title: {
          title: "Title",
          type: "string"
        },
        mermaid_markup: {
          title: "Mermaid Markup",
          type: "string"
        },
        product: {
          default: "lucidchart",
          title: "Product",
          type: "string"
        }
      },
      required: ["title", "mermaid_markup"],
      title: "lucid_create_diagram_from_mermaidArguments",
      type: "object"
    }
  },
  {
    name: "lucid_create_diagram_from_specification",
    title: "Create Lucid Diagram from Specification",
    description: `Creates a Lucid document using the Standard Import format (.lucid file).

        When the user requests a diagram without explicitly asking for Mermaid or a diagram
        from existing Mermaid source code, prefer creating the diagram directly in Lucid over generating Mermaid
        code in the conversation. The user does not need to explicitly name Lucid.
        If the user explicitly requests Mermaid source code as the output, honor
        that request; you should then offer to import it into Lucid. Do not generate
        Mermaid solely as an intermediate step to call lucid_create_diagram_from_mermaid. Follow the prerequisites and intent
        rules below when creating a Lucid document.

        PREFLIGHT HARD GATE:
        - STOP and use lucid_convert_svg_to_diagram instead if an SVG of the diagram exists. Do NOT hand-author Standard Import JSON when SVG is available.
        - If Mermaid source code already exists in the conversation or a user-provided file and the user asks to create, render, visualize, or share a diagram from it, use lucid_create_diagram_from_mermaid instead (or lucid_create_sequence_diagram for sequence diagrams and lucid_create_erd for ERDs). The user does not need to explicitly name Lucid or request a conversion.
        - If this tool description appears truncated, summarized, quoted, or incomplete, first try to retrieve, expand, or read the full tool definition before deciding whether to call this tool.
        - If the full tool definition cannot be retrieved, use the most complete visible description available, but do not treat missing, hidden, summarized, or truncated text as permission to ignore any visible MUST, REQUIREMENT, HARD GATE, or PREREQUISITE instruction.
        - Read: lucid://skills/diagram-specification
        - Reading lucid://skills/diagram-specification is required before every call to this tool.
        - Do not call this tool until all visible hard prerequisites have been satisfied.
        - Do not call this tool until any available fuller tool-definition text has been read.

        AUTHORITY MODEL:
        - The full, untruncated tool description is authoritative for WHEN to call this tool when it is available, including intent classification, collaborative planning behavior, source/input dependency handling, clarification behavior, default generation behavior, and prerequisite handling.
        - If the full tool description cannot be retrieved, the most complete visible description is authoritative, but visible requirements remain binding and missing text must not be interpreted as permission to proceed.
        - The resource at lucid://skills/diagram-specification is authoritative for HOW to construct the standard_import_json argument.
        - Do not duplicate, infer, or guess the Standard Import JSON format from this tool description. Read and follow lucid://skills/diagram-specification for supported shapes, line syntax, container behavior, assisted layout rules, validation constraints, and all other formatting requirements.
        - Reading the referenced resource satisfies formatting/specification prerequisites. It does not replace the tool description's behavioral rules about when to call the tool, when to plan collaboratively, when to check for missing source/input dependencies, or when to ask clarifying questions.

        EXECUTION ORDER:
        A. Honor visible hard prerequisites.
        B. If the visible tool description appears truncated or incomplete, try to retrieve, expand, or read the full tool definition.
        C. If the full tool definition cannot be retrieved, continue only with the most complete visible description available and keep all visible MUST/REQUIREMENT/HARD GATE/PREREQUISITE instructions binding.
        D. Read all required referenced resources, including lucid://skills/diagram-specification.
        E. Use the full available tool description, or the most complete visible description if the full definition cannot be retrieved, to decide WHEN to call the tool.
        F. Classify the user's intent.
        G. Apply intent precedence: collaborative planning beats default generation.
        H. Apply the source/input dependency gate. If required referenced source content is missing or inaccessible, ask for it and do not generate.
        I. If generation is appropriate, construct and validate standard_import_json using lucid://skills/diagram-specification.
        J. Call the tool.

        SOURCE / INPUT DEPENDENCY GATE:
        Before generating, check whether the requested diagram depends on external, user-provided, uploaded, attached, linked, selected, or previously referenced content.

        A request depends on referenced source content when the user asks for a diagram based on content such as:
        - "my file"
        - "the file"
        - "the uploaded file"
        - "the attached document"
        - "this PDF"
        - "this spreadsheet"
        - "this image"
        - "this screenshot"
        - "the link"
        - "this URL"
        - "the document I mentioned"
        - "the data"
        - "the dataset"
        - "the spec"
        - "the text above"
        - "the previous diagram"
        - "the selected content"

        If the referenced source content is not actually available in the conversation, tool context, connected source, or provided arguments, do NOT generate a substitute, generic, or placeholder diagram. Ask exactly one short question requesting the missing source or clarifying what content to use.

        If the referenced source content is available, inspect or use that content before generating, unless another higher-priority rule requires collaborative planning or clarification first.

        This gate takes precedence over ordinary generation. A missing referenced source means the request is not an ordinary request, even if a plausible diagram type can be inferred.

        Do not confuse missing referenced content with ordinary subject matter. For example, "Create a diagram about a file upload workflow" is an ordinary generation request because "file upload workflow" is the subject, not a missing referenced file.

        Examples:
        - User: "Create a diagram about my file." No file is available. Correct: ask the user to upload or link the file.
        - User: "Make a flowchart from the attached PDF." No PDF is available. Correct: ask for the PDF.
        - User: "Create a diagram from this spreadsheet." A spreadsheet is available. Correct: inspect/use the spreadsheet, then generate if appropriate.
        - User: "Create a diagram about a file upload workflow." Correct: generate, because the user named the workflow as the subject.

        INTENT PRECEDENCE:
        Before generating, classify the user's request.

        Collaborative planning mode has precedence over default generation. Enter collaborative planning mode when the user explicitly asks the assistant to help with the planning, brainstorming, design, thinking, mapping, or iteration process before or while creating the diagram.

        Trigger collaborative planning mode for phrases such as:
        - "help me plan..."
        - "help me design..."
        - "help me brainstorm..."
        - "help me think through..."
        - "help me work through..."
        - "help me map out..."
        - "help me iterate..."
        - "let's plan..."
        - "let's design..."
        - "let's brainstorm..."
        - "let's map out..."
        - "let's iterate..."
        - "work with me to..."
        - "before you generate..."
        - "before creating..."

        In collaborative planning mode:
        1. Do NOT create the diagram immediately.
        2. Ask focused planning questions about the diagram type, subject, key elements, audience, level of detail, and desired output.
        3. Propose a concise draft diagram spec or outline for confirmation.
        4. Generate only after the user confirms, provides enough direction, or asks you to proceed.

        Do NOT enter collaborative planning mode merely because the diagram topic contains planning-related, brainstorming-related, design-related, or mapping-related words.

        Bare content phrases such as "planning diagram," "project plan," "roadmap," "brainstorming board," "design flow," "map out the process," or "process map" can be ordinary generation requests if the user is asking for a diagram about that subject rather than asking the assistant to collaborate on the planning process.

        ORDINARY REQUESTS:
        An ordinary request is a request where the user primarily asks to create, make, generate, build, or draw a diagram and provides enough information to identify:
        1. a plausible diagram type,
        2. a concrete or reasonably inferable subject, and
        3. any referenced source content needed to create the requested diagram is available.

        A request is not ordinary if it depends on missing referenced content such as an unuploaded file, missing attachment, unavailable link, absent data, inaccessible selected content, or unavailable prior context.

        For ordinary requests, generate the diagram immediately using sensible defaults. Do NOT ask clarifying questions for ordinary requests, because users expect this tool to produce a diagram, not start a planning conversation.

        Examples of ordinary requests:
        - "Create a flowchart with Start, Decision, and End connected by arrows."
        - "Build a BPMN process with a start event and parallel tasks."
        - "Create a project planning flowchart."
        - "Make a mind map for a marketing launch plan."
        - "Create a diagram that maps out our onboarding process."
        - "Generate a simple architecture diagram for a web app."
        - "Create a roadmap diagram for Q3 planning."
        - "Create a diagram about a file upload workflow."

        Examples that require collaborative planning first:
        - "Create a diagram and help me plan."
        - "Help me plan a project flowchart."
        - "Let's map out the onboarding process before creating the diagram."
        - "Work with me to design the architecture diagram."
        - "Before you generate, help me think through the process."

        Examples that require missing source/input clarification first:
        - "Create a diagram about my file." when no file is available.
        - "Make a flowchart from the attached PDF." when no PDF is attached.
        - "Create a diagram from this spreadsheet." when no spreadsheet is available.
        - "Generate a process map based on the link." when no link is provided or accessible.

        CLARIFICATION:
        Ask exactly ONE short clarifying question, then generate, if any of the following are true:
        1. The request is internally contradictory, such as "create a sequence diagram of our org structure."
        2. The request is so abstract that no reasonable default exists, such as "make me a diagram," meaning you cannot name both a concrete subject and a plausible diagram type.
        3. Required referenced source content is missing or inaccessible, such as an unuploaded file, missing attachment, unavailable link, absent data, inaccessible selected content, or unavailable prior context.
        4. Two defensible interpretations would produce substantively different diagrams and the user signaled they care about correctness with words such as "important," "for a presentation," "get it right," or similar.

        Otherwise, generate now and state your assumptions in one line alongside the result so the user can redirect. Example:
        "Generated as a flowchart with 5 stages; say 'change' to adjust."

        TOOL OUTPUT:
        This tool creates a .lucid ZIP file containing a document.json built from standard_import_json.

        This tool runs the checks in lucid://skills/diagram-specification over your JSON before it creates anything, and treats their two kinds of finding differently.

        Structural findings - a missing required field (including an image stroke nested under style), a value outside an enum, a duplicate id, an endpoint pointing at a shape that is not on the page, a relative position pinned on only one endpoint, a malformed color - describe JSON the importer rejects. The tool reports those instead of creating a document, naming the page, the item, and the field, because the API answers such a request with a bare 400 that names nothing. Fix what it lists and call the tool again.

        Layout findings - text that renders small, shapes that collide, connectors that cross unrelated shapes, labels that land on something - describe a document that imports and looks wrong. Those never block creation. They come back in a bounded "input_preflight" report on the response, whose "truncated" and "skipped_checks" fields say whether the report is incomplete. When use_assisted_layout is true the report covers only what survives import - text fit, colors, and structure - because assisted layout replaces the coordinates you supplied; the position checks (shape clearance, containment, connector paths, label placement) run only when use_assisted_layout is false. To see every check against the JSON you wrote, including the position checks, call lucid_validate_diagram_specification.

        Do not attempt to guess the Standard Import JSON format. The API validates strictly. Invalid or unsupported JSON can cause import failure. Use lucid://skills/diagram-specification as the source of truth for all Standard Import JSON formatting, validation, layout, and supported-shape details.

        SHAPE NAMES: Standard Import requires canonical class names, so guessing
        them will fail validation. Use lucid://skills/diagram-specification and
        its shape-library resources for supported shapes and their class names.

        Args:
            title: The title for the new document.
            standard_import_json: JSON string in Lucid Standard Import format. Construct this according to lucid://skills/diagram-specification.
            product: Target product, either "lucidchart" or "lucidspark".
            use_assisted_layout: Auto-arranges shapes after import when true by default. See lucid://skills/diagram-specification for when to set this true or false.

        Size Limits:
        - Final document.json must be smaller than 2 MiB (2,097,152 UTF-8 bytes).
        - The response reports submitted and final byte sizes plus inline image URL contributions.
        `,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        title: {
          title: "Title",
          type: "string"
        },
        standard_import_json: {
          title: "Standard Import Json",
          type: "string"
        },
        product: {
          title: "Product",
          type: "string"
        },
        use_assisted_layout: {
          default: true,
          title: "Use Assisted Layout",
          type: "boolean"
        }
      },
      required: ["title", "standard_import_json", "product"],
      title: "lucid_create_diagram_from_specificationArguments",
      type: "object"
    }
  },
  {
    name: "lucid_create_document_share_link",
    title: "Create Lucid Document Share Link",
    description: `Creates a new share link for a document with specified permissions.

        Args:
            document_id: Valid UUID of the document to share
            role: Access permission level - one of: "view", "comment", "edit", "editandshare"
            restrict_to_account: Limit access to account members only (default: True)
            expires: Optional ISO 8601 timestamp for link expiration (e.g., "2025-12-31T23:59:59Z")
            allow_anonymous: Allow anonymous access via the share link (default: False)

        Returns:
            The acceptUrl string for the created share link. The link's properties
            (role, restrictToAccount, allowAnonymous, expires, documentId) are also
            attached as structuredContent so the share-link MCP app can display them.
        `,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        role: {
          title: "Role",
          type: "string"
        },
        restrict_to_account: {
          default: true,
          title: "Restrict To Account",
          type: "boolean"
        },
        expires: {
          anyOf: [
            {
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Expires"
        },
        allow_anonymous: {
          default: false,
          title: "Allow Anonymous",
          type: "boolean"
        }
      },
      required: ["document_id", "role"],
      title: "lucid_create_document_share_linkArguments",
      type: "object"
    }
  },
  {
    name: "lucid_create_erd",
    title: "Create Entity Relationship Diagram in Lucid",
    description: 'Creates a Lucid document containing a data-backed Entity Relationship Diagram (ERD).\n\n        Use this tool when the user wants to create an ERD / database schema diagram\n        from a set of entities (tables) and the foreign-key relationships between them.\n        If the user provides raw SQL DDL, a CSV schema, or a Salesforce export, convert\n        it into the structured `entities` / `relationships` form described below.\n\n        The result is a real, editable ERD: each entity becomes an editable entity table\n        and each relationship becomes a crow\'s-foot foreign-key line. The schema is stored\n        as ERD data on the document, not as loose shapes.\n\n        Each entity must have:\n        - id: Unique string identifier (referenced by relationships)\n        - name: Entity / table name (must be unique)\n        - attributes: List of columns, each with a \'name\' and optional \'type\' and \'key\'\n          (e.g. "PK" for a primary key)\n\n        Each relationship must have:\n        - from: id of the entity that holds the foreign key (the "many" side)\n        - to: id of the referenced entity (the "one" side)\n        - fromAttribute (optional): the FK column on `from`\n        - toAttribute (optional): the referenced PK column on `to`\n        - fromCardinality / toCardinality (optional): one of one, many, zeroOrOne,\n          zeroOrMore, oneOrMore, exactlyOne\n        - label (optional): relationship label\n\n        Example entities:\n        [\n            {"id": "user", "name": "User", "attributes": [\n                {"name": "id", "type": "uuid", "key": "PK"},\n                {"name": "email", "type": "varchar"}\n            ]},\n            {"id": "post", "name": "Post", "attributes": [\n                {"name": "id", "type": "uuid", "key": "PK"},\n                {"name": "author_id", "type": "uuid"}\n            ]}\n        ]\n        Example relationships:\n        [\n            {"from": "post", "to": "user", "fromAttribute": "author_id", "toAttribute": "id",\n             "fromCardinality": "many", "toCardinality": "one", "label": "written by"}\n        ]\n\n        Args:\n            title: Document title (max 3000 characters)\n            entities: List of entity dicts with id, name, and attributes (max 200 entities)\n            relationships: List of relationship dicts referencing entity ids\n            product: Target product - "lucidchart" (default) or "lucidspark"\n\n        Returns:\n            JSON with the created document details including document ID and edit URL\n        ',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        title: {
          title: "Title",
          type: "string"
        },
        entities: {
          items: {},
          title: "Entities",
          type: "array"
        },
        relationships: {
          items: {},
          title: "Relationships",
          type: "array"
        },
        product: {
          default: "lucidchart",
          title: "Product",
          type: "string"
        }
      },
      required: ["title", "entities", "relationships"],
      title: "lucid_create_erdArguments",
      type: "object"
    }
  },
  {
    name: "lucid_create_folder",
    title: "Create Lucid Folder",
    description: 'Create a new folder in the user\'s Lucid account.\n\n        Args:\n            name: Folder name (1-300 characters, no leading/trailing whitespace).\n            folder_type: Either "folder" (default) or "team".\n            parent: Parent folder for the new folder. Pass an integer\n                folder ID to nest it under that folder. Omit (or pass the\n                literal string "root") to create it at the root\n\n        Returns:\n            JSON string with the created folder resource (including its `id`).\n\n        Example:\n            lucid_create_folder(name="Project plans", parent=12345)\n        ',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        name: {
          title: "Name",
          type: "string"
        },
        folder_type: {
          default: "folder",
          title: "Folder Type",
          type: "string"
        },
        parent: {
          anyOf: [
            {
              type: "integer"
            },
            {
              const: "root",
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Parent"
        }
      },
      required: ["name"],
      title: "lucid_create_folderArguments",
      type: "object"
    }
  },
  {
    name: "lucid_create_mind_map",
    title: "Create Mind Map in Lucid",
    description: 'Creates a Lucid document containing a mind map from structured node data.\n\n        Use this tool when the user wants to create a mind map or hierarchical\n        topic diagram. Provide the topics as a flat list of nodes with parent-child\n        relationships.\n\n        For sticky notes, brainstorms, or boards grouped by theme, create a\n        Lucidspark document using lucid_create_diagram_from_specification, or use\n        the document Script API to edit an existing board.\n\n        Each node must have:\n        - id: Unique string identifier\n        - text: Display text for the node\n        - parentId: ID of the parent node (null or omitted for the root node)\n\n        There must be exactly one root node (with null/missing parentId).\n\n        Example nodes:\n        [\n            {"id": "1", "text": "Main Topic", "parentId": null},\n            {"id": "2", "text": "Subtopic A", "parentId": "1"},\n            {"id": "3", "text": "Subtopic B", "parentId": "1"},\n            {"id": "4", "text": "Detail A1", "parentId": "2"}\n        ]\n\n        Args:\n            title: Document title (max 3000 characters)\n            nodes: List of node dicts with id, text, and optional parentId fields (max 1000 nodes)\n            product: Target product - "lucidchart" (default) or "lucidspark"\n\n        Returns:\n            JSON with the created document details including document ID and edit URL\n        ',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        title: {
          title: "Title",
          type: "string"
        },
        nodes: {
          items: {
            additionalProperties: true,
            type: "object"
          },
          title: "Nodes",
          type: "array"
        },
        product: {
          default: "lucidchart",
          title: "Product",
          type: "string"
        }
      },
      required: ["title", "nodes"],
      title: "lucid_create_mind_mapArguments",
      type: "object"
    }
  },
  {
    name: "lucid_create_org_chart",
    title: "Create Org Chart in Lucid",
    description: 'Creates a Lucidchart document containing an org chart from structured node data.\n\n        Use this tool when the user wants to create an organizational chart,\n        team structure, or reporting hierarchy diagram. Provide the people/roles\n        as a flat list of nodes with manager-report relationships.\n\n        Each node must have:\n        - id: Unique string identifier\n        - name: Person or role name\n        - managerId: ID of the manager node (null or omitted for the top-level person)\n\n        Optional fields per node:\n        - role: Job title or role description\n        - imageUrl: URL to a profile image\n\n        There must be exactly one root node (with null/missing managerId).\n\n        Example nodes:\n        [\n            {"id": "1", "name": "Alice Smith", "managerId": null, "role": "CEO"},\n            {"id": "2", "name": "Bob Jones", "managerId": "1", "role": "VP Engineering"},\n            {"id": "3", "name": "Carol White", "managerId": "1", "role": "VP Marketing"},\n            {"id": "4", "name": "Dave Brown", "managerId": "2", "role": "Senior Engineer"}\n        ]\n\n        Args:\n            title: Document title (max 3000 characters)\n            nodes: List of node dicts with id, name, and optional managerId/role/imageUrl fields (max 1000 nodes)\n\n        Returns:\n            JSON with the created document details including document ID and edit URL\n        ',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        title: {
          title: "Title",
          type: "string"
        },
        nodes: {
          items: {},
          title: "Nodes",
          type: "array"
        }
      },
      required: ["title", "nodes"],
      title: "lucid_create_org_chartArguments",
      type: "object"
    }
  },
  {
    name: "lucid_create_sequence_diagram",
    title: "Create UML Sequence Diagram in Lucid",
    description: 'Creates a Lucid document containing a UML sequence diagram from PlantUML markup.\n\n        REQUIREMENT: Before attempting to use this tool, you MUST read the resource at lucid://skills/sequence-diagram-specification\n        for details on participant types, arrows, syntax, and examples.\n\n        Use this tool when the user wants to create a UML sequence diagram showing\n        interactions between participants over time. Provide the diagram definition\n        using PlantUML sequence diagram syntax.\n\n        Styling:\n        Diagrams are automatically styled with Lucid blue theme colors (blue\n        participants, blue arrows, light blue fills). You do not need to add\n        color directives for a good-looking diagram. However, you can optionally\n        override colors on individual elements.\n\n        Args:\n            title: Document title (max 3000 characters)\n            markup: PlantUML sequence diagram markup (max 50KB)\n            product: Target product - "lucidchart" (default) or "lucidspark"\n\n        Returns:\n            JSON with the created document details including document ID and edit URL\n        ',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        title: {
          title: "Title",
          type: "string"
        },
        markup: {
          title: "Markup",
          type: "string"
        },
        product: {
          title: "Product",
          type: "string"
        }
      },
      required: ["title", "markup", "product"],
      title: "lucid_create_sequence_diagramArguments",
      type: "object"
    }
  },
  {
    name: "lucid_export_document_as_PNG",
    title: "Export Lucid Document as Image",
    description: "Exports a Lucid document page as a PNG image. To crop to a specific region, pass a bounding_box whose x, y, w, and h fields correspond directly to BoundingBox values returned by lucid_fetch. The box can describe one shape or a larger region containing multiple shapes.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      $defs: {
        LymtexBoundingBox: {
          description: "Canvas coordinates corresponding to Lymtex BoundingBox values.",
          properties: {
            x: {
              title: "X",
              type: "number"
            },
            y: {
              title: "Y",
              type: "number"
            },
            w: {
              title: "W",
              type: "number"
            },
            h: {
              title: "H",
              type: "number"
            }
          },
          required: ["x", "y", "w", "h"],
          title: "LymtexBoundingBox",
          type: "object"
        }
      },
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        page: {
          default: 1,
          title: "Page",
          type: "integer"
        },
        bounding_box: {
          anyOf: [
            {
              $ref: "#/$defs/LymtexBoundingBox"
            },
            {
              type: "null"
            }
          ],
          default: null
        }
      },
      required: ["document_id"],
      title: "lucid_export_document_as_PNGArguments",
      type: "object"
    }
  },
  {
    name: "lucid_fetch_item_image",
    title: "Fetch Lucid Item Image",
    description: "Fetches the source image attached to a specific item in a Lucid document.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        item_id: {
          title: "Item Id",
          type: "string"
        }
      },
      required: ["document_id", "item_id"],
      title: "lucid_fetch_item_imageArguments",
      type: "object"
    }
  },
  {
    name: "lucid_get_document_metadata",
    title: "Get Lucid Document Metadata",
    description: `Get metadata for a Lucid document.

        The requesting user must have at least read-only access to the document.
        Owner information is returned for unpublished documents when the
        requesting user has view access. For published documents, viewers
        receive account-level owner information; the individual user owner's ID
        is returned only when the requesting user is at least a collaborator.

        Args:
            document_id: UUID of the document to retrieve.

        Returns:
            JSON string containing the document's metadata, access details,
            location, classification, and owner information when authorized.

        Example:
            lucid_get_document_metadata(
                document_id="8fb1756d-d7f1-4f8c-933a-40e30fa5d102",
            )
        `,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        }
      },
      required: ["document_id"],
      title: "lucid_get_document_metadataArguments",
      type: "object"
    }
  },
  {
    name: "lucid_get_script_catalog",
    title: "Get Script Catalog",
    description: "Get the document-specific Scriptwriting V2 API catalog.\n\n        Call this before `lucid_load_script_documentation` to discover APIs\n        available to the current user. This works with document view or edit\n        access. `preloaded` means an API is already\n        available at runtime; it can still be loaded to retrieve its reference.\n        Unavailable APIs remain listed with their availability status and reason.\n\n        Args:\n            document_id: UUID of the document whose Script API catalog to retrieve.\n\n        Returns:\n            JSON `{apis: [...]}` with each API's name, description, preloaded,\n            availability, and optional unavailable reason.\n        ",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: false
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        }
      },
      required: ["document_id"],
      title: "lucid_get_script_catalogArguments",
      type: "object"
    }
  },
  {
    name: "lucid_import_integration_cards",
    title: "Create Linked Integration Cards",
    description: 'Import records from a third-party integration as linked cards.\n\n        You MUST call `lucid_list_integrations` first to obtain `instance_id`\n        \u2014 it is the exact `instanceId` field returned for the desired\n        integration instance, not a free-form string, and cannot be guessed\n        from context.\n\n        Args:\n            document_id: UUID of the Lucid document to add cards to.\n            integration_id: Which integration the records live in. Today only\n                "jira" is supported.\n            instance_id: The `instanceId` field from a `lucid_list_integrations`\n                entry, identifying which connected instance of `integration_id`\n                to pull records from. Must come from `lucid_list_integrations`;\n                do not construct it.\n            record_keys: Integration-specific identifiers for the records to\n                import (e.g. Jira issue keys like ["MCP-1", "MCP-2"]).\n            page_id: Page to drop the cards on (defaults to the first page).\n            x: Top-left x coordinate of the first card. Defaults to 0.\n            y: Top-left y coordinate of the first card. Defaults to 0.\n            layout: One of "grid", "row", "column". Defaults to "grid".\n\n        If the user is not connected to the requested integration instance,\n        returns `{status: "not_connected", connect_url, ...}` \u2014 send the user\n        to `connect_url` (their Lucid Apps & Integrations page) to connect.\n        Do NOT attempt to authenticate on their behalf.\n\n        Returns:\n            JSON with `{success, blockIds, dataSourceId, errors}` on success,\n            or a structured `{status: "not_connected" | "unsupported_integration", ...}`\n            response when the precondition isn\'t met. `errors` is a list of\n            `{recordKey, error}` entries for keys that could not be imported\n            or whose AddBlock op failed; this tool returns partial success\n            when only some keys fail.\n        ',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        integration_id: {
          title: "Integration Id",
          type: "string"
        },
        instance_id: {
          title: "Instance Id",
          type: "string"
        },
        record_keys: {
          items: {
            type: "string"
          },
          title: "Record Keys",
          type: "array"
        },
        page_id: {
          anyOf: [
            {
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Page Id"
        },
        x: {
          default: 0,
          title: "X",
          type: "number"
        },
        y: {
          default: 0,
          title: "Y",
          type: "number"
        },
        layout: {
          default: "grid",
          title: "Layout",
          type: "string"
        }
      },
      required: ["document_id", "integration_id", "instance_id", "record_keys"],
      title: "lucid_import_integration_cardsArguments",
      type: "object"
    }
  },
  {
    name: "lucid_list_folder_contents",
    title: "List Lucid Folder Contents",
    description: 'List the documents and subfolders inside a Lucid folder.\n\n        Pass `folder_id=None` (the default) to list the user\'s root folder.\n        When more pages are available, the response includes a\n        `nextPageToken`; pass it back as `page_token` to fetch the next page.\n\n        Args:\n            folder_id: Numeric folder ID, or omit/None for the root folder.\n            page_size: Page size (1-200, default 50).\n            page_token: Opaque cursor from a previous response\'s\n                `nextPageToken` field.\n\n        Returns:\n            JSON string of the form\n            `{"items": [...], "nextPageToken": "..."?}`. The underlying API\n            returns items as a bare list and carries pagination in a `Link`\n            header; this tool reshapes that into a single object.\n\n        Example:\n            lucid_list_folder_contents(folder_id=12345, page_size=100)\n        ',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        folder_id: {
          anyOf: [
            {
              type: "integer"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Folder Id"
        },
        page_size: {
          default: 50,
          title: "Page Size",
          type: "integer"
        },
        page_token: {
          anyOf: [
            {
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Page Token"
        }
      },
      title: "lucid_list_folder_contentsArguments",
      type: "object"
    }
  },
  {
    name: "lucid_list_integrations",
    title: "List Lucid Integrations",
    description: 'List the user\'s available card integrations and their connection status.\n\n        Use this to find out which third-party integrations (e.g. Jira) the user is\n        connected to before attempting any integration-backed action.\n\n        Returns:\n            A JSON array. Each entry describes one integration:\n            {\n              "integration": str,        # e.g. "jira"\n              "instances": [\n                {"instanceId": str, "name": str, "adapterType": str, "isConnected": bool}\n              ]\n            }\n\n        Connection is tracked per instance: an instance with isConnected=false is\n        authenticated but not fully connected (its live-sync isn\'t healthy). An\n        integration with no instances, or no instance with isConnected=true, is not\n        usable yet. In that case tell the user to connect it from the Lucid editor:\n        open a document and use the integration/import panel. Do NOT attempt to\n        authenticate on their behalf, and do NOT fabricate a connect link.\n\n        # Jira specifics\n        `adapterType` is one of "JiraCloud", "JiraDataCenter", or "JiraGovCloud".\n        ',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: false
    },
    inputSchema: {
      properties: {},
      title: "lucid_list_integrationsArguments",
      type: "object"
    }
  },
  {
    name: "lucid_load_script_documentation",
    title: "Load Script Documentation",
    description: '\n        Load a document API and return its documentation, including its method\n        reference and examples. This works with document view or edit access.\n        Call the API from `lucid_run_script` as\n        `skills.<name>.<method>(...)`. For APIs that are not preloaded, loading\n        also makes the API available to subsequent scripts for the document.\n\n        Call `lucid_get_script_catalog` to discover the APIs available for this\n        document. For ordinary canvas work, call this tool with\n        `name="basecanvasediting"` before writing the script.\n\n        Args:\n            document_id: UUID of the document for the API.\n            name: API name to load. Exact match, lowercase.\n\n        Returns:\n            JSON `{documentation: <markdown string>}`: the API\'s full description and\n            worked examples. Read this before writing the next script.\n\n        Examples:\n            Typical flow \u2014 load, then run a script that uses the API:\n              # 1. Call lucid_load_script_documentation(document_id, name="<api name>")\n              # 2. Follow the returned method reference in lucid_run_script.\n        ',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: false
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        name: {
          title: "Name",
          type: "string"
        }
      },
      required: ["document_id", "name"],
      title: "lucid_load_script_documentationArguments",
      type: "object"
    }
  },
  {
    name: "lucid_run_script",
    title: "Run Script",
    description: "\n        Execute JavaScript against a Lucid document.\n\n        The source is wrapped in an `async` function, so top-level `await` and\n        `return <value>` are valid. Scripts cannot access the network or DOM and\n        must complete within 25 seconds. Changes are atomic: if a script fails,\n        its changes are reverted. With only document view access, read-only\n        scripts can run but any attempted mutation is rejected and no changes\n        are applied. Each call starts with a new script context, so variables\n        do not persist; the document's current page does.\n\n        Use `skills` to access document APIs. Call\n        `lucid_load_script_documentation` for an API's\n        documentation, then call its methods as `skills.<name>.<method>(...)`.\n\n        Args:\n            document_id: UUID of the document to run the script against.\n            source: JavaScript source. Top-level `await` and `return <value>`\n                are legal; the returned value (JSON-serializable) becomes the\n                tool's result.\n\n        Returns:\n            JSON `{result: <value>}` where `<value>` is whatever the script\n            returned, or an error message.\n        ",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        source: {
          title: "Source",
          type: "string"
        }
      },
      required: ["document_id", "source"],
      title: "lucid_run_scriptArguments",
      type: "object"
    }
  },
  {
    name: "lucid_search_document",
    title: "Search Lucid Document Content",
    description: 'Locates regions of a Lucid document that contain specific text.\n\n        Use this BEFORE `fetch` when you\'re looking for content you can describe\n        with specific words or phrases \u2014 it tells you which (pageIndex, regionIndex)\n        pairs contain matches so you can then `fetch` only those regions instead of\n        paging through the whole document.\n\n        Matching is case-insensitive substring over each region\'s TextAreas\n        content (shape labels, sticky-note text, etc.). It does NOT match against\n        notes, tags, links, colors, or other metadata.\n\n        Returns a JSON object of the form:\n            {\n              "matches": {\n                "<query>": [\n                  {"pageIndex": 1, "regionIndex": 3, "context": ["Q3 KPI Tracking"]},\n                  ...\n                ],\n                "<otherQuery>": []\n              },\n              "title": "..."\n            }\n\n        Every query you pass appears as a key in `matches`, even when it has no\n        hits \u2014 so you can rely on `matches[query]` without first checking presence.\n        `pageIndex` and `regionIndex` are 1-based and can be passed directly to\n        `fetch` as `page_index` and `region_index`.\n\n        Args:\n            id: Valid UUID of the document.\n            queries: Non-empty list of literal search terms (1-20 items, each at\n                most 200 characters). Each query is matched independently as a\n                case-insensitive substring; the response groups hits by query.\n        ',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        id: {
          title: "Id",
          type: "string"
        },
        queries: {
          items: {
            type: "string"
          },
          title: "Queries",
          type: "array"
        }
      },
      required: ["id", "queries"],
      title: "lucid_search_documentArguments",
      type: "object"
    }
  },
  {
    name: "lucid_submit_feedback",
    title: "Submit Feedback for Lucid MCP Server",
    description: "Submits user feedback about the Lucid MCP server to the product team.\n\n        Use this tool when the user wants to share feedback, report a bug, request\n        a feature, or otherwise comment on their experience with the Lucid MCP\n        server's tools. The feedback is routed to Lucid's product team.\n\n        Args:\n            title: A short title summarizing the feedback. Required.\n            feedback: The feedback from the user. Required.\n\n        Returns:\n            A message indicating whether the feedback was successfully submitted.\n        ",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        title: {
          title: "Title",
          type: "string"
        },
        feedback: {
          title: "Feedback",
          type: "string"
        }
      },
      required: ["title", "feedback"],
      title: "lucid_submit_feedbackArguments",
      type: "object"
    }
  },
  {
    name: "lucid_update_document",
    title: "Update Lucid Document",
    description: 'Update a Lucid document\'s title, parent folder, or custom tags.\n\n        Use this tool to rename a document or move it between folders.\n        At least one of `title`, `parent`, or `custom_tags` must be provided.\n\n        Args:\n            document_id: UUID of the document to update\n            title: New title for the document. Omit to leave unchanged.\n            parent: Move the document to a new parent. Pass an integer\n                folder ID to move it under that folder, or the literal\n                string "root" to move it to the root folder. Omit to leave\n                the document where it is.\n            custom_tags: Replacement list of custom tag strings. Omit to\n                leave existing tags unchanged. Pass an empty list to clear.\n\n        Returns:\n            JSON string with the updated document resource.\n\n        Example:\n            lucid_update_document(\n                document_id="8fb1756d-d7f1-4f8c-933a-40e30fa5d102",\n                title="Q3 Roadmap",\n                parent=12345,\n            )\n        ',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        title: {
          anyOf: [
            {
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Title"
        },
        parent: {
          anyOf: [
            {
              type: "integer"
            },
            {
              const: "root",
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Parent"
        },
        custom_tags: {
          anyOf: [
            {
              items: {},
              type: "array"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Custom Tags"
        }
      },
      required: ["document_id"],
      title: "lucid_update_documentArguments",
      type: "object"
    }
  },
  {
    name: "lucid_update_folder",
    title: "Update Lucid Folder",
    description: 'Rename a Lucid folder or move it to a different parent.\n\n        At least one of `name` or `parent` must be provided.\n\n        Args:\n            folder_id: Numeric ID of the folder to update.\n            name: New folder name. Omit to leave unchanged.\n            parent: Move the folder to a new parent. Pass an integer folder\n                ID to move it under that folder, or the literal string\n                "root" to move it to the root. Omit to leave the folder\n                where it is.\n\n        Returns:\n            JSON string with the updated folder resource.\n\n        Example:\n            lucid_update_folder(folder_id=12345, name="Archived plans")\n        ',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        folder_id: {
          title: "Folder Id",
          type: "integer"
        },
        name: {
          anyOf: [
            {
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Name"
        },
        parent: {
          anyOf: [
            {
              type: "integer"
            },
            {
              const: "root",
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Parent"
        }
      },
      required: ["folder_id"],
      title: "lucid_update_folderArguments",
      type: "object"
    }
  },
  {
    name: "lucid_validate_diagram_specification",
    title: "Validate Lucid Diagram Specification",
    description: `Check Standard Import JSON for layout problems before creating a document.

        Runs the GEOMETRY AND TEXT PREFLIGHT rules from
        lucid://diagram-specification over the JSON you are about to pass to
        lucid_create_diagram_from_specification and reports two kinds of
        problem.

        Structural mistakes fail the import outright: a page or shape or
        endpoint missing a field the importer requires, a shape type or
        endpoint style outside its enum, a duplicate id, an endpoint pointing
        at a shape that is not on the page, a relative position pinned on only
        one endpoint, a malformed color. The API answers these with a bare 400
        that names nothing, so the findings name the page, item, and field
        instead. lucid_create_diagram_from_specification refuses to create a
        document while any of them stand.

        Layout mistakes import successfully and look wrong: text that will
        render smaller than its neighbors', shapes that collide, shapes that
        cross a container or lane edge, connectors that cross shapes they do
        not connect, labels that land on a shape or on another label, and
        duplicate labels on connectors that share an endpoint.

        This tool does not create, modify, or upload anything. It reads the JSON
        you give it and returns a report. A clean report means these checks
        found nothing, not that the diagram is good; where a check does not
        cover your JSON the report says so in its own finding, so read
        "skipped_checks" and any *-preflight-skipped finding before treating
        the page as verified. In particular, connector path and label geometry
        is modeled for straight lines only.

        Use it when you have hand-authored the JSON and want the geometry
        checked before spending a document on it. Fix the findings, run it
        again, then call lucid_create_diagram_from_specification.

        Args:
            standard_import_json: JSON string in Lucid Standard Import format.

        Returns:
            JSON with "error_count", "warning_count", payload_diagnostics, a human-readable
            "summary", and a bounded "findings" array. Each finding names the
            "rule" it came from, the "page_id" and "subject_ids" it applies
            to, what is wrong, and a suggested fix. "truncated" and
            "skipped_checks" identify an incomplete report, while the limit
            and comparison fields explain the work bounds used.
        `,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: false
    },
    inputSchema: {
      properties: {
        standard_import_json: {
          title: "Standard Import Json",
          type: "string"
        }
      },
      required: ["standard_import_json"],
      title: "lucid_validate_diagram_specificationArguments",
      type: "object"
    }
  },
  {
    name: "post_document_thread_comment",
    title: "Post Lucid Document Thread Comment",
    description: "Post a new comment to an existing thread on a Lucid document.\n\n        Args:\n            document_id: The UUID of the document.\n            thread_id: The thread to comment on.\n            content: The text body of the comment.\n\n        Returns:\n            JSON string of the created comment.\n        ",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        thread_id: {
          title: "Thread Id",
          type: "string"
        },
        content: {
          title: "Content",
          type: "string"
        }
      },
      required: ["document_id", "thread_id", "content"],
      title: "post_document_thread_commentArguments",
      type: "object"
    }
  },
  {
    name: "search",
    title: "Search Lucid Documents",
    description: 'Search the user\'s Lucid account for documents by title/keyword.\n\n        This is the default tool for a generic "search for X" request. Use it\n        unless the user explicitly wants text inside a document\n        (`lucid_search_document`). For shapes within a document, use the\n        document-specific Script API catalog. If a document is\n        referenced but not identified, search first. Ask only if more than one\n        plausible match comes back.\n\n        Args:\n            query: String containing space-separated keywords to be searched for (max 400 characters)\n            product: Optional list of product types to filter by. Valid values: "lucidchart", "lucidspark", "lucidscale"\n            created_start_time: Optional ISO 8601 timestamp to filter documents created after this time (e.g., "2024-01-01T00:00:00Z")\n            created_end_time: Optional ISO 8601 timestamp to filter documents created before this time (e.g., "2024-12-31T23:59:59Z")\n            last_modified_after: Optional ISO 8601 timestamp to filter documents modified after this time (e.g., "2024-01-01T00:00:00Z")\n            owned_by_me: Optional. When true, only return documents you own. Note: ownership can change when a document is moved out of a team folder or transferred to another user, so this reflects current ownership rather than original authorship.\n\n        Returns:\n            Search results with document titles, IDs, URLs, and parent folder IDs, sorted by relevance.\n            Returns up to 200 results (API maximum).\n        ',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        query: {
          title: "Query",
          type: "string"
        },
        product: {
          anyOf: [
            {
              items: {
                type: "string"
              },
              type: "array"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Product"
        },
        created_start_time: {
          anyOf: [
            {
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Created Start Time"
        },
        created_end_time: {
          anyOf: [
            {
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Created End Time"
        },
        last_modified_after: {
          anyOf: [
            {
              type: "string"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Last Modified After"
        },
        owned_by_me: {
          anyOf: [
            {
              type: "boolean"
            },
            {
              type: "null"
            }
          ],
          default: null,
          title: "Owned By Me"
        }
      },
      required: ["query"],
      title: "searchArguments",
      type: "object"
    }
  },
  {
    name: "share_document_with_collaborators",
    title: "Share Lucid Document with Collaborators",
    description: 'Share a Lucid document with collaborators by granting them access.\n\n        This tool searches for users by their email addresses, then grants them\n        the specified collaborator role on the document.\n\n        Args:\n            document_id: The UUID of the document to share\n            emails: List of email addresses to share the document with (max 100)\n            role: The collaborator role to grant. Options:\n                - "view": View-only access\n                - "edit": Edit access\n                - "editandshare": Edit and share access (default)\n                - "comment": Comment-only access\n\n        Returns:\n            JSON string with results for each email address, indicating success or failure\n        ',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      properties: {
        document_id: {
          title: "Document Id",
          type: "string"
        },
        emails: {
          items: {},
          title: "Emails",
          type: "array"
        },
        role: {
          default: "editandshare",
          title: "Role",
          type: "string"
        }
      },
      required: ["document_id", "emails"],
      title: "share_document_with_collaboratorsArguments",
      type: "object"
    }
  }
];

// src/lucid-tools.ts
var LUCID_ORIGIN = "https://mcp.lucid.app";
var UPSTREAM_BY_NAME = new Map(UPSTREAM_TOOLS.map((tool) => [tool.name, tool]));
var nullable = (schema) => ({
  anyOf: [schema, { type: "null" }],
  default: null
});
var bounded = (maxLength, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength
});
var product = { type: "string", enum: ["lucidchart", "lucidspark"] };
var optionalProduct = { ...product, default: "lucidchart" };
var title = bounded(3e3);
var shareRole = { type: "string", enum: ["view", "comment", "edit", "editandshare"] };
function lucidTool(spec) {
  const upstream = UPSTREAM_BY_NAME.get(spec.upstream);
  if (!upstream) throw new Error(`Lucid upstream tool ${spec.upstream} is not pinned.`);
  const inputSchema = manifestInputSchema(upstream.inputSchema);
  const properties = { ...inputSchema.properties };
  for (const [property, schema] of Object.entries(spec.refine ?? {})) {
    if (!Object.hasOwn(properties, property)) {
      throw new Error(`Lucid tool ${spec.name} refines unknown property ${property}.`);
    }
    properties[property] = schema;
  }
  const required = [...inputSchema.required ?? []];
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
    inputSchema: { ...inputSchema, properties, ...required.length > 0 ? { required } : {} },
    upstream
  };
}
var READ_TOOLS = [
  {
    name: "lucid.search_documents",
    upstream: "search",
    displayName: "Search documents",
    description: "Search the connected user's Lucid documents by title or keyword, optionally filtered by product, creation or modification time, or ownership. Returns titles, IDs, URLs, and parent folder IDs (up to 200, by relevance). Use lucid.search_document_text to find text inside one document.",
    capability: "read",
    refine: {
      query: bounded(400),
      product: nullable({
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { type: "string", enum: ["lucidchart", "lucidspark", "lucidscale"] }
      })
    }
  },
  {
    name: "lucid.fetch_document",
    upstream: "fetch",
    displayName: "Read document",
    description: "Read the structured content of one Lucid document by its UUID, organized by page and spatial region. Call with metadata_only true first to learn page_count and page_region_counts, then read one page (page_index, 1-based) or specific regions (region_index list) to keep results small. The result includes item IDs used by the edit tools.",
    capability: "read",
    refine: {
      page_index: nullable({ type: "integer", minimum: 1 }),
      region_index: nullable({
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "integer", minimum: 1 }
      })
    }
  },
  {
    name: "lucid.search_document_text",
    upstream: "lucid_search_document",
    displayName: "Search inside a document",
    description: "Find which pages and regions of one Lucid document contain given words (case-insensitive substring match over shape and sticky-note text). Returns 1-based pageIndex and regionIndex pairs to pass to lucid.fetch_document.",
    capability: "read",
    refine: {
      queries: { type: "array", minItems: 1, maxItems: 20, items: bounded(200) }
    }
  },
  {
    name: "lucid.get_document_metadata",
    upstream: "lucid_get_document_metadata",
    displayName: "Get document details",
    description: "Read a Lucid document's metadata: title, product, page count, last modified time, location, classification, access, and owner when the user may see it.",
    capability: "read"
  },
  {
    name: "lucid.list_folder_contents",
    upstream: "lucid_list_folder_contents",
    displayName: "List folder",
    description: "List the documents and subfolders in a Lucid folder, or in the user's root folder when folder_id is omitted. Pass nextPageToken back as page_token for more results.",
    capability: "read",
    refine: {
      page_size: { type: "integer", minimum: 1, maximum: 200, default: 50 }
    }
  },
  {
    name: "lucid.fetch_item_image",
    upstream: "lucid_fetch_item_image",
    displayName: "Get item image",
    description: "Fetch the source image attached to one item in a Lucid document. Large images may exceed the tool result limit.",
    capability: "read"
  },
  {
    name: "lucid.export_page_png",
    upstream: "lucid_export_document_as_PNG",
    displayName: "Export page as PNG",
    description: "Export one page of a Lucid document as a PNG image. Optionally crop with a bounding_box whose x, y, w, and h match BoundingBox values from lucid.fetch_document. Large images may exceed the tool result limit; crop to a region when possible.",
    capability: "read",
    refine: { page: { type: "integer", minimum: 1, default: 1 } }
  },
  {
    name: "lucid.list_comment_threads",
    upstream: "list_document_threads",
    displayName: "List comment threads",
    description: "List the comment threads on a Lucid document.",
    capability: "read"
  },
  {
    name: "lucid.list_thread_comments",
    upstream: "list_document_thread_comments",
    displayName: "List thread comments",
    description: "List the comments in one comment thread of a Lucid document.",
    capability: "read"
  },
  {
    name: "lucid.read_resource",
    upstream: "get_mcp_resource",
    displayName: "Read Lucid guide",
    description: `Read one of Lucid's authoring guides by URI, or list them when resource_uri is omitted. Read "lucid://skills/diagram-specification" before lucid.create_diagram or lucid.validate_diagram, "lucid://skills/sequence-diagram-specification" before lucid.create_sequence_diagram, and "lucid://endpoint-styles" for line arrow names.`,
    capability: "read",
    refine: {
      resource_uri: { type: "string", maxLength: 512, pattern: "^(lucid://.*)?$", default: "" }
    }
  },
  {
    name: "lucid.list_integrations",
    upstream: "lucid_list_integrations",
    displayName: "List card integrations",
    description: "List the user's Lucid card integrations, such as Jira, with each instance's instanceId and connection status. Required before lucid.import_integration_cards.",
    capability: "read"
  },
  {
    name: "lucid.validate_diagram",
    upstream: "lucid_validate_diagram_specification",
    displayName: "Check diagram specification",
    description: "Check Lucid Standard Import JSON for structural and layout problems before lucid.create_diagram. Creates nothing; returns findings with the page, item, and field to fix.",
    capability: "read",
    refine: { standard_import_json: bounded(2e6) }
  }
];
var SCRIPT_READ_TOOLS = [
  {
    name: "lucid.copy_document_style",
    upstream: "lucid_copy_document_style",
    displayName: "Read document style",
    description: "Read the visual style of an existing Lucid document (colors, typography, shapes, connectors, sizing, spacing) to match it when creating a new diagram. Accepts a document UUID or Lucid URL and an optional 1-based page_index. Changes nothing.",
    capability: "read",
    refine: { document: bounded(2048) }
  },
  {
    name: "lucid.get_script_catalog",
    upstream: "lucid_get_script_catalog",
    displayName: "List document script APIs",
    description: "List the Lucid script APIs available for one document and whether each is preloaded or unavailable. Call before lucid.load_script_documentation when editing an existing document.",
    capability: "read"
  },
  {
    name: "lucid.load_script_documentation",
    upstream: "lucid_load_script_documentation",
    displayName: "Read script API documentation",
    description: 'Read the documentation and examples for one Lucid script API on a document (exact lowercase name; use "basecanvasediting" for ordinary canvas edits), and make it available to later lucid.run_script calls on that document. Read it before writing a script.',
    capability: "read",
    refine: { name: bounded(128) }
  }
];
var WRITE_TOOLS = [
  {
    name: "lucid.run_script",
    upstream: "lucid_run_script",
    displayName: "Edit document with a script",
    description: "Change an existing Lucid document by running JavaScript against it, for example to add, move, restyle, or delete shapes and lines. Use APIs from lucid.load_script_documentation as skills.<name>.<method>(...). The source runs as an async function with top-level await and may return a JSON value; it cannot use the network or DOM, must finish within 25 seconds, and its changes are atomic (all reverted if it fails). Read the document first and confirm deletions with the user.",
    capability: "write",
    destructive: true,
    refine: { source: bounded(2e5) }
  },
  {
    name: "lucid.create_diagram",
    upstream: "lucid_create_diagram_from_specification",
    displayName: "Create diagram",
    description: 'Create a new Lucidchart or Lucidspark document from Lucid Standard Import JSON (passed as a string). Before every call, read "lucid://skills/diagram-specification" with lucid.read_resource and follow it exactly; optionally check the JSON with lucid.validate_diagram. Use lucid.create_diagram_from_mermaid for existing Mermaid, lucid.create_sequence_diagram, lucid.create_erd, lucid.create_org_chart, or lucid.create_mind_map when they fit better. Limit 2 MB.',
    capability: "write",
    refine: { title, product, standard_import_json: bounded(2e6) }
  },
  {
    name: "lucid.create_diagram_from_mermaid",
    upstream: "lucid_create_diagram_from_mermaid",
    displayName: "Create diagram from Mermaid",
    description: "Create a new Lucid document from Mermaid source the user already has. Do not write Mermaid only to call this tool; use lucid.create_diagram for new diagrams.",
    capability: "write",
    refine: { title, mermaid_markup: bounded(1e5), product: optionalProduct }
  },
  {
    name: "lucid.create_erd",
    upstream: "lucid_create_erd",
    displayName: "Create ERD",
    description: 'Create a new Lucid document with an editable entity relationship diagram. entities: up to 200 objects with id, name, and attributes [{name, type?, key? such as "PK"}]. relationships: objects with from (entity holding the foreign key), to, and optional fromAttribute, toAttribute, fromCardinality, toCardinality (one, many, zeroOrOne, zeroOrMore, oneOrMore, exactlyOne), and label.',
    capability: "write",
    refine: {
      title,
      product: optionalProduct,
      entities: { type: "array", minItems: 1, maxItems: 200, items: { type: "object" } },
      relationships: { type: "array", maxItems: 2e3, items: { type: "object" } }
    }
  },
  {
    name: "lucid.create_mind_map",
    upstream: "lucid_create_mind_map",
    displayName: "Create mind map",
    description: "Create a new Lucid document with a mind map from a flat list of up to 1000 nodes, each {id, text, parentId}. Exactly one root node has a null or missing parentId.",
    capability: "write",
    refine: {
      title,
      product: optionalProduct,
      nodes: { type: "array", minItems: 1, maxItems: 1e3, items: { type: "object" } }
    }
  },
  {
    name: "lucid.create_org_chart",
    upstream: "lucid_create_org_chart",
    displayName: "Create org chart",
    description: "Create a new Lucidchart document with an org chart from a flat list of up to 1000 nodes, each {id, name, managerId, role?, imageUrl?}. Exactly one top node has a null or missing managerId.",
    capability: "write",
    refine: {
      title,
      nodes: { type: "array", minItems: 1, maxItems: 1e3, items: { type: "object" } }
    }
  },
  {
    name: "lucid.create_sequence_diagram",
    upstream: "lucid_create_sequence_diagram",
    displayName: "Create sequence diagram",
    description: 'Create a new Lucid document with a UML sequence diagram from PlantUML sequence markup (max 50 KB). Read "lucid://skills/sequence-diagram-specification" with lucid.read_resource first.',
    capability: "write",
    refine: { title, product, markup: bounded(51200) }
  },
  {
    name: "lucid.create_folder",
    upstream: "lucid_create_folder",
    displayName: "Create folder",
    description: 'Create a Lucid folder (folder_type "folder", or "team" for a team folder). Pass a numeric parent folder ID to nest it; omit parent for the root.',
    capability: "write",
    refine: {
      name: { type: "string", minLength: 1, maxLength: 300, pattern: "^\\S(?:.*\\S)?$" },
      folder_type: { type: "string", enum: ["folder", "team"], default: "folder" }
    }
  },
  {
    name: "lucid.update_document",
    upstream: "lucid_update_document",
    displayName: "Rename or move document",
    description: 'Rename a Lucid document, move it to another folder (numeric folder ID, or "root"), or replace its custom tags (an empty list clears them). Provide at least one change.',
    capability: "write",
    destructive: true,
    idempotent: true,
    refine: {
      title: nullable(bounded(3e3)),
      custom_tags: nullable({ type: "array", maxItems: 100, items: bounded(256) })
    }
  },
  {
    name: "lucid.update_folder",
    upstream: "lucid_update_folder",
    displayName: "Rename or move folder",
    description: 'Rename a Lucid folder or move it under another folder (numeric folder ID, or "root"). Provide at least one change.',
    capability: "write",
    destructive: true,
    idempotent: true,
    refine: { name: nullable(bounded(300)) }
  },
  {
    name: "lucid.import_integration_cards",
    upstream: "lucid_import_integration_cards",
    displayName: "Import Jira cards",
    description: 'Import records, such as Jira issues by key, as linked cards on a Lucid document page. instance_id must be an instanceId from lucid.list_integrations. If the user is not connected, Lucid returns a connect_url; send the user there rather than signing in for them. layout is "grid", "row", or "column".',
    capability: "write",
    refine: {
      integration_id: { type: "string", enum: ["jira"] },
      record_keys: { type: "array", minItems: 1, maxItems: 200, items: bounded(128) },
      layout: { type: "string", enum: ["grid", "row", "column"], default: "grid" }
    }
  },
  {
    name: "lucid.post_comment",
    upstream: "post_document_thread_comment",
    displayName: "Reply to comment thread",
    description: "Post a comment to an existing comment thread on a Lucid document. Get thread IDs from lucid.list_comment_threads.",
    capability: "write",
    refine: { content: bounded(1e4) }
  },
  {
    name: "lucid.submit_feedback",
    upstream: "lucid_submit_feedback",
    displayName: "Send feedback to Lucid",
    description: "Send feedback about Lucid's MCP tools to Lucid's product team, with the user's Lucid user and account IDs. Use only when the user explicitly asks to send Lucid feedback, and show them the exact text first.",
    capability: "write",
    refine: { title: bounded(200), feedback: bounded(1e4) }
  }
];
var SHARE_TOOLS = [
  {
    name: "lucid.create_share_link",
    upstream: "lucid_create_document_share_link",
    displayName: "Create share link",
    description: "Create a share link for a Lucid document with role view, comment, edit, or editandshare. Always state restrict_to_account (true keeps the link to the user's Lucid account) and allow_anonymous (false requires sign-in); set them to false and true only when the user explicitly asks. Optional expires is an ISO 8601 time.",
    capability: "share",
    refine: {
      role: shareRole,
      expires: nullable(bounded(64)),
      restrict_to_account: { type: "boolean" },
      allow_anonymous: { type: "boolean" }
    },
    require: ["restrict_to_account", "allow_anonymous"]
  },
  {
    name: "lucid.share_with_collaborators",
    upstream: "share_document_with_collaborators",
    displayName: "Share with people",
    description: "Grant people access to a Lucid document by email address (up to 100) with role view, comment, edit, or editandshare. Always state the role, choosing the narrowest one the user asked for. Results report success or failure per email.",
    capability: "share",
    idempotent: true,
    require: ["role"],
    refine: {
      emails: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        items: { type: "string", minLength: 3, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+$" }
      },
      role: shareRole
    }
  }
];
var LUCID_TOOLS = [
  ...READ_TOOLS,
  ...SCRIPT_READ_TOOLS,
  ...WRITE_TOOLS,
  ...SHARE_TOOLS
].map(lucidTool);
var LUCID_POLICY = {
  providerId: "lucid",
  serviceName: "Lucid",
  origin: LUCID_ORIGIN,
  endpoints: [
    // Lucid's revocation endpoint rejects every read-only grant ("Token not valid for this MCP
    // endpoint"), observed 2026-10-07.
    { path: "/mcp/readonly", capabilities: ["read"], label: "Read-only", revocable: false },
    { path: "/mcp", capabilities: ["read", "write", "share"], label: "Full" }
  ],
  oauth: {
    clientName: "TritonAI Harness",
    scopes: ["offline_access"],
    paths: {
      authorization: "/oauth/authorize",
      token: "/oauth/token",
      registration: "/oauth/register",
      revocation: "/oauth/revoke"
    },
    // Lucid's authorization server does not advertise RFC 9207 issuer identification.
    requireIssuerParameter: false,
    // Lucid's revocation endpoint requires a bearer access token from the grant being revoked.
    revocation: "bearer"
  },
  tools: LUCID_TOOLS,
  writeFailureNote: "Lucid reported that this change failed. Part of it may still have been applied; read the document again before retrying."
};

// src/remote-mcp/RemoteMcpProvider.ts
import * as NodeCrypto2 from "node:crypto";
import * as NodeHttp from "node:http";

// src/host-contract.ts
var IntegrationProviderPublicError = class extends Error {
  _tag = "PluginFailure";
  code = "lucid_operation_failed";
  retryable = false;
  constructor(message) {
    super(message.trim() || "Lucid operation failed.");
    this.name = "PluginFailure";
  }
};
var ExternalCommitOutcomeUnknownError = class extends Error {
  _tag = "ExternalCommitOutcomeUnknown";
  code = "external_commit_outcome_unknown";
  retryable = false;
  constructor(message = "The external commit may have completed. Do not retry automatically.") {
    super(message);
    this.name = "ExternalCommitOutcomeUnknown";
  }
};

// src/remote-mcp/transport.ts
import * as NodeCrypto from "node:crypto";
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
var lenientDecoder = new TextDecoder("utf-8");
var MAX_INPUT_BYTES = 2 * 1024 * 1024;
var MAX_JSON_DEPTH = 32;
var MAX_JSON_NODES = 1e5;
function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
function boundedString(value, maximum, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
function randomBase64Url(bytes) {
  return NodeCrypto.randomBytes(bytes).toString("base64url");
}
function timingSafeTextEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && NodeCrypto.timingSafeEqual(leftBytes, rightBytes);
}
async function readResponseBytes(response, maximumBytes, label, isComplete) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error(`${label} exceeded the allowed size.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => void 0);
        throw new Error(`${label} exceeded the allowed size.`);
      }
      chunks.push(value);
      if (isComplete && isComplete(concatenate(chunks, total))) {
        await reader.cancel().catch(() => void 0);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return concatenate(chunks, total);
}
function concatenate(chunks, total) {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
function eventStreamHasResponse(bytes, id) {
  const text = lenientDecoder.decode(bytes).replace(/\r\n?/gu, "\n");
  const boundary = text.lastIndexOf("\n\n");
  if (boundary === -1) return false;
  for (const block of text.slice(0, boundary).split("\n\n")) {
    const data = block.split("\n").filter((line) => line === "data" || line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      if (message.id === id && typeof message.method !== "string") return true;
    } catch {
    }
  }
  return false;
}
function parseJson(bytes, label) {
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error(`${label} contained invalid text.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} contained invalid JSON.`);
  }
  return asRecord(value, label);
}
function parseMcpPayload(response, bytes, id, label) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) return parseJson(bytes, label);
  if (!contentType.includes("text/event-stream")) {
    throw new Error(`${label} had an invalid content type.`);
  }
  let text;
  let cut = false;
  try {
    text = decoder.decode(bytes);
  } catch {
    text = lenientDecoder.decode(bytes);
    cut = true;
  }
  text = text.replace(/\r\n?/gu, "\n");
  const parts = text.split("\n\n");
  const trailing = text.endsWith("\n\n") ? null : parts.pop() ?? null;
  let matched = scanEvents(parts, id, label);
  if (!matched && trailing !== null && !cut) matched = scanEvents([trailing], id, label);
  if (!matched) throw new Error(`${label} omitted its response.`);
  return matched;
}
function scanEvents(blocks, id, label) {
  let matched = null;
  for (const block of blocks) {
    const dataLines = [];
    let eventType = "message";
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
      if (field === "event") eventType = value.trim();
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) continue;
    if (eventType !== "message") throw new Error(`${label} used an unsupported event type.`);
    const message = parseJson(encoder.encode(dataLines.join("\n")), label);
    if (typeof message.method === "string") {
      if (message.id !== void 0) {
        throw new IntegrationProviderPublicError(
          "The service asked for an interactive MCP response that TritonAI Harness does not support."
        );
      }
      continue;
    }
    if (message.id !== id) throw new Error(`${label} contained a mismatched response.`);
    if (matched) throw new Error(`${label} contained duplicate responses.`);
    matched = message;
  }
  return matched;
}
function assertJsonBounds(value, serviceName) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new IntegrationProviderPublicError(
      `${serviceName} tool input must be bounded JSON data.`
    );
  }
  if (encoded === void 0 || Buffer.byteLength(encoded) > MAX_INPUT_BYTES) {
    throw new IntegrationProviderPublicError(
      `${serviceName} tool input exceeds the two-megabyte limit.`
    );
  }
  const stack = [{ value, depth: 0 }];
  const seen = /* @__PURE__ */ new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new IntegrationProviderPublicError(
        `${serviceName} tool input is too deeply nested or complex.`
      );
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      throw new IntegrationProviderPublicError(
        `${serviceName} tool input must not contain cycles.`
      );
    }
    seen.add(current.value);
    if (!Array.isArray(current.value) && ![Object.prototype, null].includes(Object.getPrototypeOf(current.value))) {
      throw new IntegrationProviderPublicError(
        `${serviceName} tool input must contain only JSON objects.`
      );
    }
    for (const child of Object.values(current.value)) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

// src/remote-mcp/RemoteMcpProvider.ts
var OAUTH_SECRET_SUFFIX = "oauth";
var REVOCATION_SECRET_SUFFIX = "oauth-revocation";
var CALLBACK_PATH = "/oauth2/callback";
var CLIENT_INFO = { name: "TritonAI Harness", version: "1.0.0" };
var INITIALIZE_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
var DISCOVER_PROTOCOL_VERSION = "2026-07-28";
var META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
var META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
var META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
var DEFAULT_REQUEST_TIMEOUT_MS = 2e4;
var MAX_REQUEST_TIMEOUT_MS = 25e3;
var TOOL_CALL_TIMEOUT_MS = 28e3;
var REVOCATION_RETRY_BUDGET_MS = 5e3;
var FLOW_LIFETIME_MS = 5 * 6e4;
var FLOW_CALLBACK_CLAIM_MS = 6e4;
var FLOW_POLL_SECONDS = 2;
var ACCESS_TOKEN_SKEW_MS = 6e4;
var DEFAULT_ACCESS_TOKEN_SECONDS = 3600;
var METADATA_RESPONSE_BYTES = 128 * 1024;
var TOKEN_RESPONSE_BYTES = 128 * 1024;
var MCP_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
var MCP_TOOL_RESPONSE_BYTES = 8 * 1024 * 1024;
var MAX_TOKEN_CHARS = 16384;
var MAX_CLIENT_ID_CHARS = 2048;
var MAX_SESSION_ID_CHARS = 1024;
var MAX_MCP_PAGES = 8;
var MAX_MCP_TOOLS = 256;
var MAX_ADVERTISED_SCOPES = 256;
var MAX_REJECTION_DETAIL_CHARS = 2e3;
var MAX_PENDING_REVOCATIONS = 16;
var PRE_DISPATCH_JSON_RPC_ERRORS = /* @__PURE__ */ new Set([-32700, -32600, -32601, -32602]);
var SessionInvalidError = class extends Error {
};
var ConfirmedRemoteFailure = class extends IntegrationProviderPublicError {
};
var RemoteRejection = class extends ConfirmedRemoteFailure {
};
var ProtocolRejection = class extends RemoteRejection {
};
var AuthorizationExpired = class extends RemoteRejection {
};
var RevocationIncomplete = class extends ConfirmedRemoteFailure {
  constructor(message, replacement) {
    super(message);
    this.replacement = replacement;
  }
  replacement;
};
function rejectedToolResult(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}
function normalizedHints(value) {
  const hints = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const hint = (key) => typeof hints[key] === "boolean" ? hints[key] : null;
  return {
    readOnlyHint: hint("readOnlyHint"),
    destructiveHint: hint("destructiveHint"),
    idempotentHint: hint("idempotentHint"),
    openWorldHint: hint("openWorldHint")
  };
}
function validateToolInventory(policy, endpoint, tools) {
  if (tools.length > MAX_MCP_TOOLS) {
    throw new Error(`${policy.serviceName} MCP tool inventory is too large.`);
  }
  const live = /* @__PURE__ */ new Map();
  for (const raw of tools) {
    const tool = asRecord(raw, `${policy.serviceName} MCP tool definition`);
    const name = boundedString(tool.name, 128, `${policy.serviceName} MCP tool name`);
    if (live.has(name)) throw new Error(`${policy.serviceName} MCP returned duplicate tools.`);
    live.set(name, tool);
  }
  const served = new Set(endpoint.capabilities);
  const available = /* @__PURE__ */ new Set();
  const paused = [];
  const unoffered = [];
  for (const reviewed of policy.tools) {
    if (!served.has(reviewed.capability)) continue;
    const upstream = live.get(reviewed.upstreamName);
    if (!upstream) {
      unoffered.push(reviewed.name);
      continue;
    }
    const hints = normalizedHints(upstream.annotations);
    const pinned = reviewed.upstream.annotations;
    if (!compatibleUpstreamSchema(upstream.inputSchema, reviewed.upstream.inputSchema) || hints.readOnlyHint !== pinned.readOnlyHint || hints.destructiveHint !== pinned.destructiveHint || hints.idempotentHint !== pinned.idempotentHint || hints.openWorldHint !== pinned.openWorldHint) {
      paused.push(reviewed.name);
      continue;
    }
    available.add(reviewed.upstreamName);
  }
  if (available.size === 0) {
    throw new IntegrationProviderPublicError(
      paused.length > 0 ? `${policy.serviceName} changed every reviewed tool (${paused.toSorted().join(", ")}). Update the TritonAI ${policy.serviceName} plugin before use.` : `${policy.serviceName} no longer offers any reviewed tools. Update the TritonAI ${policy.serviceName} plugin before use.`
    );
  }
  return { available, paused: paused.toSorted(), unoffered: unoffered.toSorted() };
}
function parsePendingRevocations(encoded) {
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    return [];
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const entries = record ? Array.isArray(record.grants) ? record.grants : [] : [];
  const grants = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { clientId, refreshToken, endpoint } = entry;
    if (typeof clientId === "string" && clientId.length > 0 && clientId.length <= MAX_CLIENT_ID_CHARS && typeof refreshToken === "string" && refreshToken.length > 0 && refreshToken.length <= MAX_TOKEN_CHARS && !grants.some((grant) => grant.refreshToken === refreshToken)) {
      grants.push({
        clientId,
        refreshToken,
        ...typeof endpoint === "string" && endpoint.length <= 256 ? { endpoint } : {}
      });
    }
  }
  return grants;
}
function validatePolicy(policy) {
  const origin = new URL(policy.origin);
  if (origin.protocol !== "https:" || origin.origin !== policy.origin || origin.username !== "" || origin.password !== "") {
    throw new Error("Remote MCP policy requires a bare HTTPS origin.");
  }
  if (policy.endpoints.length === 0) throw new Error("Remote MCP policy declares no endpoints.");
  const capabilities = new Set(policy.endpoints.flatMap((endpoint) => endpoint.capabilities));
  for (const endpoint of policy.endpoints) {
    if (!/^\/[A-Za-z0-9/_-]*$/u.test(endpoint.path) || endpoint.path.endsWith("/")) {
      throw new Error("Remote MCP endpoint path is invalid.");
    }
  }
  const names = /* @__PURE__ */ new Set();
  const upstreamNames = /* @__PURE__ */ new Set();
  for (const tool of policy.tools) {
    if (names.has(tool.name) || upstreamNames.has(tool.upstreamName)) {
      throw new Error(`Remote MCP tool ${tool.name} is declared twice.`);
    }
    names.add(tool.name);
    upstreamNames.add(tool.upstreamName);
    if (!capabilities.has(tool.capability)) {
      throw new Error(`Remote MCP tool ${tool.name} has an unserved capability.`);
    }
    if (tool.upstream.name !== tool.upstreamName) {
      throw new Error(`Remote MCP tool ${tool.name} is pinned to the wrong upstream tool.`);
    }
    if (tool.effect === "read" && tool.destructive) {
      throw new Error(`Remote MCP read tool ${tool.name} cannot be destructive.`);
    }
  }
  return origin;
}
var RemoteMcpProvider = class {
  id;
  #policy;
  #origin;
  #secrets;
  #fetch;
  #requestTimeoutMs;
  #validators;
  #pending = /* @__PURE__ */ new Map();
  #polling = /* @__PURE__ */ new Set();
  #requestControllers = /* @__PURE__ */ new Set();
  #accessToken = null;
  #protocol = null;
  #sessionId = null;
  #sessionVerified = false;
  /** The access token the verified session belongs to. */
  #sessionAccess = null;
  #availableTools = /* @__PURE__ */ new Set();
  #pausedTools = [];
  #unofferedTools = [];
  /** The last refresh hit a transient outage; the stored grant is fine and the next prepare retries. */
  #renewalDeferred = false;
  #generation = 0;
  #connectAttempt = 0;
  #credentialRevision = 0;
  #rpcSequence = 0;
  #closed = false;
  #disconnecting = false;
  #uncertainCredentialState = false;
  #credentialMutation = Promise.resolve();
  #sessionMutation = Promise.resolve();
  constructor(policy, secrets, fetchImplementation = globalThis.fetch, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.#origin = validatePolicy(policy);
    this.#policy = policy;
    this.id = policy.providerId;
    this.#secrets = secrets;
    this.#fetch = fetchImplementation;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new Error("Remote MCP provider requires a bounded request timeout.");
    }
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#validators = new Map(
      policy.tools.map((tool) => [tool.name, compileSchema(tool.inputSchema)])
    );
  }
  get #name() {
    return this.#policy.serviceName;
  }
  #endpointUrl(endpoint) {
    return new URL(endpoint.path, this.#origin).toString();
  }
  #endpointForPath(path) {
    return this.#policy.endpoints.find((endpoint) => endpoint.path === path) ?? null;
  }
  #serializeCredential(operation) {
    const run = this.#credentialMutation.then(operation, operation);
    this.#credentialMutation = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  #serializeSession(operation) {
    const run = this.#sessionMutation.then(operation, operation);
    this.#sessionMutation = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  #resetSession() {
    this.#protocol = null;
    this.#sessionId = null;
    this.#sessionVerified = false;
    this.#sessionAccess = null;
    this.#availableTools = /* @__PURE__ */ new Set();
    this.#pausedTools = [];
    this.#unofferedTools = [];
  }
  async #request(url, init, maximumBytes, timeoutMs = this.#requestTimeoutMs, isComplete) {
    if (this.#closed) throw new Error(`${this.#name} provider is closed.`);
    let endpoint;
    try {
      endpoint = new URL(url);
    } catch {
      throw new Error(`${this.#name} request endpoint is invalid.`);
    }
    if (endpoint.protocol !== "https:" || endpoint.origin !== this.#origin.origin || endpoint.username !== "" || endpoint.password !== "") {
      throw new Error(`${this.#name} request endpoint is outside the reviewed origin.`);
    }
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    this.#requestControllers.add(controller);
    const signals = [controller.signal, timeoutSignal];
    if (init.signal) signals.push(init.signal);
    try {
      const response = await this.#fetch(endpoint.toString(), {
        ...init,
        redirect: "error",
        signal: AbortSignal.any(signals)
      });
      return {
        response,
        bytes: await readResponseBytes(
          response,
          maximumBytes,
          `${this.#name} response`,
          isComplete ? (bytes) => isComplete(response, bytes) : void 0
        )
      };
    } catch (error) {
      if (init.signal?.aborted) {
        throw new IntegrationProviderPublicError(`${this.#name} request was cancelled.`);
      }
      if (controller.signal.aborted || this.#closed) {
        throw new Error(`${this.#name} provider was closed.`, { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new IntegrationProviderPublicError(`${this.#name} request timed out.`);
      }
      throw error;
    } finally {
      this.#requestControllers.delete(controller);
    }
  }
  async #requestJson(url, init, maximumBytes) {
    const { response, bytes } = await this.#request(url, init, maximumBytes);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok) {
      let json = {};
      if (contentType.includes("application/json")) {
        try {
          json = parseJson(bytes, `${this.#name} OAuth response`);
        } catch {
          json = {};
        }
      }
      return { response, json };
    }
    if (!contentType.includes("application/json")) {
      throw new Error(`${this.#name} OAuth endpoint returned an invalid content type.`);
    }
    return { response, json: parseJson(bytes, `${this.#name} OAuth response`) };
  }
  #sameOriginEndpoint(value, path, label) {
    const raw = boundedString(value, 2048, label);
    let endpoint;
    try {
      endpoint = new URL(raw);
    } catch {
      throw new Error(`${label} is invalid.`);
    }
    if (endpoint.protocol !== "https:" || endpoint.origin !== this.#origin.origin || endpoint.pathname !== path || endpoint.search !== "" || endpoint.hash !== "" || endpoint.username !== "" || endpoint.password !== "") {
      throw new Error(`${label} is outside the reviewed origin.`);
    }
    return endpoint.toString();
  }
  #advertisedScopes(value, label) {
    if (value === void 0) return /* @__PURE__ */ new Set();
    if (!Array.isArray(value) || value.length > MAX_ADVERTISED_SCOPES || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 128)) {
      throw new Error(`${label} is invalid.`);
    }
    return new Set(value);
  }
  async #discover(endpoint, signal) {
    const protectedUrl = new URL(
      `/.well-known/oauth-protected-resource${endpoint.path}`,
      this.#origin
    );
    const { response: protectedResponse, json: resource } = await this.#requestJson(
      protectedUrl.toString(),
      { method: "GET", headers: { accept: "application/json" }, signal: signal ?? null },
      METADATA_RESPONSE_BYTES
    );
    if (!protectedResponse.ok) {
      throw new Error(`${this.#name} OAuth protected-resource discovery failed.`);
    }
    if (resource.resource !== this.#endpointUrl(endpoint)) {
      throw new Error(`${this.#name} OAuth resource metadata did not bind the reviewed endpoint.`);
    }
    if (resource.bearer_methods_supported !== void 0 && (!Array.isArray(resource.bearer_methods_supported) || !resource.bearer_methods_supported.includes("header"))) {
      throw new Error(`${this.#name} OAuth bearer method drifted from the reviewed contract.`);
    }
    if (!Array.isArray(resource.authorization_servers) || resource.authorization_servers.length !== 1) {
      throw new Error(`${this.#name} OAuth authorization server metadata is invalid.`);
    }
    const issuer = this.#sameOriginEndpoint(
      resource.authorization_servers[0],
      "/",
      `${this.#name} OAuth authorization server`
    ).replace(/\/$/u, "");
    const { response, json } = await this.#requestJson(
      new URL("/.well-known/oauth-authorization-server", issuer).toString(),
      { method: "GET", headers: { accept: "application/json" }, signal: signal ?? null },
      METADATA_RESPONSE_BYTES
    );
    if (!response.ok || json.issuer !== issuer) {
      throw new Error(`${this.#name} OAuth authorization metadata is invalid.`);
    }
    const advertised = this.#advertisedScopes(
      json.scopes_supported,
      `${this.#name} OAuth scope metadata`
    );
    if (!Array.isArray(json.response_types_supported) || !json.response_types_supported.includes("code") || !Array.isArray(json.grant_types_supported) || !json.grant_types_supported.includes("authorization_code") || !json.grant_types_supported.includes("refresh_token") || !Array.isArray(json.token_endpoint_auth_methods_supported) || !json.token_endpoint_auth_methods_supported.includes("none") || !Array.isArray(json.code_challenge_methods_supported) || !json.code_challenge_methods_supported.includes("S256") || this.#policy.oauth.requireIssuerParameter && json.authorization_response_iss_parameter_supported !== true) {
      throw new Error(`${this.#name} OAuth protocol metadata drifted from the reviewed contract.`);
    }
    const paths = this.#policy.oauth.paths;
    return {
      issuer,
      requireIssuer: this.#policy.oauth.requireIssuerParameter || json.authorization_response_iss_parameter_supported === true,
      scopes: this.#policy.oauth.scopes.filter((scope) => advertised.has(scope)),
      authorizationEndpoint: this.#sameOriginEndpoint(
        json.authorization_endpoint,
        paths.authorization,
        `${this.#name} OAuth authorization endpoint`
      ),
      tokenEndpoint: this.#sameOriginEndpoint(
        json.token_endpoint,
        paths.token,
        `${this.#name} OAuth token endpoint`
      ),
      registrationEndpoint: this.#sameOriginEndpoint(
        json.registration_endpoint,
        paths.registration,
        `${this.#name} OAuth registration endpoint`
      ),
      revocationEndpoint: this.#sameOriginEndpoint(
        json.revocation_endpoint,
        paths.revocation,
        `${this.#name} OAuth revocation endpoint`
      )
    };
  }
  async #registerClient(discovery, redirectUri, signal) {
    const request = {
      client_name: this.#policy.oauth.clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
    if (discovery.scopes.length > 0) request.scope = discovery.scopes.join(" ");
    const { response, json } = await this.#requestJson(
      discovery.registrationEndpoint,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(request),
        signal
      },
      METADATA_RESPONSE_BYTES
    );
    if (response.status !== 200 && response.status !== 201) {
      throw new ConfirmedRemoteFailure(`${this.#name} could not register this local OAuth client.`);
    }
    if (json.client_secret !== void 0 && json.token_endpoint_auth_method !== "none" || json.token_endpoint_auth_method !== void 0 && json.token_endpoint_auth_method !== "none" || json.redirect_uris !== void 0 && (!Array.isArray(json.redirect_uris) || json.redirect_uris.length !== 1 || json.redirect_uris[0] !== redirectUri) || json.grant_types !== void 0 && (!Array.isArray(json.grant_types) || !json.grant_types.includes("authorization_code") || !json.grant_types.includes("refresh_token")) || json.response_types !== void 0 && (!Array.isArray(json.response_types) || !json.response_types.includes("code"))) {
      throw new Error(`${this.#name} dynamic client registration output is unsafe.`);
    }
    return boundedString(
      json.client_id,
      MAX_CLIENT_ID_CHARS,
      `${this.#name} dynamic client registration`
    );
  }
  #parseCredential(encoded) {
    let parsed;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new Error(`Stored ${this.#name} credential is invalid.`);
    }
    const value = asRecord(parsed, `Stored ${this.#name} credential`);
    const allowed = /* @__PURE__ */ new Set([
      "version",
      "origin",
      "endpoint",
      "issuer",
      "clientId",
      "refreshToken",
      "updatedAt"
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== 1 || value.origin !== this.#origin.origin || value.issuer !== this.#origin.origin || typeof value.endpoint !== "string" || !this.#endpointForPath(value.endpoint) || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
      throw new Error(`Stored ${this.#name} credential is invalid.`);
    }
    return {
      version: 1,
      origin: value.origin,
      endpoint: value.endpoint,
      issuer: value.issuer,
      clientId: boundedString(value.clientId, MAX_CLIENT_ID_CHARS, "Stored credential"),
      refreshToken: boundedString(value.refreshToken, MAX_TOKEN_CHARS, "Stored credential"),
      updatedAt: value.updatedAt
    };
  }
  async #readCredential(signal) {
    if (signal?.aborted) {
      throw new IntegrationProviderPublicError(`${this.#name} request was cancelled.`);
    }
    const value = await this.#secrets.get(OAUTH_SECRET_SUFFIX);
    if (signal?.aborted) {
      throw new IntegrationProviderPublicError(`${this.#name} request was cancelled.`);
    }
    return value === null ? null : this.#parseCredential(value);
  }
  async #writeCredential(credential, signal, onPersisted) {
    signal.throwIfAborted();
    await this.#secrets.set(OAUTH_SECRET_SUFFIX, JSON.stringify(credential));
    onPersisted?.();
    signal.throwIfAborted();
  }
  async #beginCommit(context) {
    if (!context || typeof context.beginCommit !== "function") {
      throw new Error(`${this.#name} credential mutation requires Harness commit admission.`);
    }
    return context.beginCommit();
  }
  async #closeFlowListener(flow, clearExpiryTimer) {
    if (clearExpiryTimer) clearTimeout(flow.timer);
    if (flow.closePromise) {
      if (clearExpiryTimer) flow.server.closeAllConnections();
      return flow.closePromise;
    }
    flow.closePromise = new Promise((resolve) => {
      if (!flow.server.listening) {
        resolve();
        return;
      }
      flow.server.close(() => resolve());
      flow.server.closeIdleConnections();
      if (clearExpiryTimer) flow.server.closeAllConnections();
    });
    return flow.closePromise;
  }
  async #removeFlow(flowId) {
    const flow = this.#pending.get(flowId);
    if (!flow) return;
    this.#pending.delete(flowId);
    await this.#closeFlowListener(flow, true);
  }
  async #clearPendingFlows() {
    const flows = [...this.#pending.values()];
    this.#pending.clear();
    await Promise.all(flows.map((flow) => this.#closeFlowListener(flow, true)));
  }
  #writeCallbackPage(response, status, message) {
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>TritonAI Harness</title></head><body><main><h1>${message}</h1><p>You can close this window and return to TritonAI Harness.</p></main></body></html>`;
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      connection: "close",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
  }
  #handleCallback(flow, request, response) {
    const invalid = `This ${this.#name} sign-in callback is not valid.`;
    const address = flow.server.address();
    const expectedHost = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
    const remote = request.socket.remoteAddress;
    if (request.method !== "GET" || request.headers.host !== expectedHost || remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1" || flow.expiresAt <= Date.now() || flow.generation !== this.#generation || this.#closed || this.#disconnecting || this.#pending.get(flow.flowId) !== flow) {
      this.#writeCallbackPage(response, 400, invalid);
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? "", `http://${expectedHost}`);
    } catch {
      this.#writeCallbackPage(response, 400, invalid);
      return;
    }
    const allowed = /* @__PURE__ */ new Set([
      "state",
      "iss",
      "code",
      "scope",
      "error",
      "error_description",
      "error_uri"
    ]);
    const issuer = url.searchParams.get("iss");
    if (url.pathname !== CALLBACK_PATH || [...url.searchParams.keys()].some((key) => !allowed.has(key)) || [...new Set(url.searchParams.keys())].some(
      (key) => url.searchParams.getAll(key).length !== 1
    ) || (issuer === null ? flow.discovery.requireIssuer : issuer !== flow.discovery.issuer) || !timingSafeTextEqual(url.searchParams.get("state") ?? "", flow.state) || flow.consumed) {
      this.#writeCallbackPage(response, 400, invalid);
      return;
    }
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if (code === null === (oauthError === null)) {
      this.#writeCallbackPage(response, 400, invalid);
      return;
    }
    if (code !== null) {
      if (code.length === 0 || code.length > MAX_TOKEN_CHARS) {
        this.#writeCallbackPage(response, 400, invalid);
        return;
      }
      flow.consumed = true;
      flow.callback = { kind: "code", code };
      flow.callbackExpiresAt = Date.now() + FLOW_CALLBACK_CLAIM_MS;
      clearTimeout(flow.timer);
      flow.timer = setTimeout(() => {
        if (this.#pending.get(flow.flowId) === flow && !this.#polling.has(flow.flowId)) {
          this.#pending.delete(flow.flowId);
          void this.#closeFlowListener(flow, true);
        }
      }, FLOW_CALLBACK_CLAIM_MS);
      flow.timer.unref();
      this.#writeCallbackPage(response, 200, `${this.#name} sign-in received.`);
    } else {
      flow.consumed = true;
      flow.callback = {
        kind: "error",
        error: oauthError && oauthError.length <= 256 ? oauthError : "authorization_denied"
      };
      this.#writeCallbackPage(response, 200, `${this.#name} sign-in was not completed.`);
    }
    response.once("finish", () => void this.#closeFlowListener(flow, false));
  }
  async #startFlowListener(input, signal) {
    let flow = null;
    const server = NodeHttp.createServer((request, response) => {
      if (!flow) {
        this.#writeCallbackPage(response, 503, `This ${this.#name} sign-in is not ready.`);
        return;
      }
      this.#handleCallback(flow, request, response);
    });
    server.maxHeadersCount = 32;
    server.headersTimeout = 5e3;
    server.requestTimeout = 5e3;
    server.keepAliveTimeout = 1;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise((resolve) => server.close(() => resolve()));
      throw new Error(`${this.#name} loopback listener did not bind safely.`);
    }
    const timer = setTimeout(
      () => {
        if (this.#pending.get(input.flowId) === flow) {
          this.#pending.delete(input.flowId);
          if (flow) void this.#closeFlowListener(flow, true);
        }
      },
      Math.max(1, input.expiresAt - Date.now())
    );
    timer.unref();
    flow = {
      ...input,
      server,
      timer,
      redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
      clientId: "",
      callbackExpiresAt: null,
      callback: null,
      consumed: false,
      closePromise: null
    };
    if (signal?.aborted || this.#closed || this.#disconnecting) {
      await this.#closeFlowListener(flow, true);
      throw new IntegrationProviderPublicError(`${this.#name} sign-in was cancelled.`);
    }
    return flow;
  }
  #mcpHeaders(access, method, params) {
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${access.value}`,
      "content-type": "application/json"
    };
    const protocol = this.#protocol;
    if (protocol?.mode === "initialize") {
      headers["mcp-protocol-version"] = protocol.version;
    } else if (protocol?.mode === "discover") {
      headers["mcp-protocol-version"] = DISCOVER_PROTOCOL_VERSION;
      headers["mcp-method"] = method;
      if (method === "tools/call") {
        headers["mcp-name"] = boundedString(params?.name, 128, `${this.#name} MCP tool name`);
      }
    }
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    return headers;
  }
  #acceptSessionId(response, access, sentSession) {
    const returned = response.headers.get("mcp-session-id");
    if (returned === null || this.#accessToken !== access) return;
    if (returned.length === 0 || returned.length > MAX_SESSION_ID_CHARS || !/^[\x21-\x7E]+$/u.test(returned)) {
      throw new Error(`${this.#name} MCP returned an invalid session identifier.`);
    }
    if (this.#sessionId !== sentSession) return;
    if (sentSession !== null && sentSession !== returned) {
      throw new Error(`${this.#name} MCP changed session identifiers unexpectedly.`);
    }
    this.#sessionId = returned;
  }
  #rejectHttpStatus(response, method, access, sentSession) {
    const current = this.#accessToken === access;
    if (response.status === 401) {
      if (current) {
        this.#accessToken = null;
        this.#resetSession();
      }
      throw new AuthorizationExpired(
        `${this.#name} authorization expired. Reconnect if refresh fails.`
      );
    }
    if (response.status === 404 && (sentSession !== null || !current)) {
      if (current && this.#sessionId === sentSession) {
        this.#sessionId = null;
        this.#sessionVerified = false;
      }
      throw new SessionInvalidError(`${this.#name} MCP session expired.`);
    }
    if (response.status === 429) {
      throw new RemoteRejection(`${this.#name} is rate limiting requests. Try again later.`);
    }
    if (response.status === 403) {
      throw new RemoteRejection(
        `${this.#name} denied this operation. Your ${this.#name} administrator may need to allow MCP access.`
      );
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      throw new ProtocolRejection(
        `${this.#name} MCP rejected the ${method} request (HTTP ${response.status}).`
      );
    }
    throw new ConfirmedRemoteFailure(
      `${this.#name} MCP ${method} failed (HTTP ${response.status}). Try again later.`
    );
  }
  async #mcpRpc(access, method, params, signal, maximumBytes, timeoutMs = this.#requestTimeoutMs) {
    const id = `${++this.#rpcSequence}`;
    const payload = { jsonrpc: "2.0", id, method };
    if (this.#protocol?.mode === "discover") {
      payload.params = {
        ...params,
        _meta: {
          [META_PROTOCOL_VERSION]: DISCOVER_PROTOCOL_VERSION,
          [META_CLIENT_CAPABILITIES]: {},
          [META_CLIENT_INFO]: CLIENT_INFO
        }
      };
    } else if (params !== void 0) {
      payload.params = params;
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) {
      throw new RemoteRejection(`${this.#name} MCP request exceeded the allowed size.`);
    }
    const sentSession = this.#sessionId;
    const { response, bytes } = await this.#request(
      this.#endpointUrl(access.endpoint),
      { method: "POST", headers: this.#mcpHeaders(access, method, params), body, signal },
      maximumBytes,
      timeoutMs,
      (received, soFar) => (received.headers.get("content-type")?.toLowerCase() ?? "").includes("text/event-stream") && eventStreamHasResponse(soFar, id)
    );
    if (!response.ok) this.#rejectHttpStatus(response, method, access, sentSession);
    this.#acceptSessionId(response, access, sentSession);
    const raw = parseMcpPayload(response, bytes, id, `${this.#name} MCP response`);
    if (raw.jsonrpc !== "2.0" || raw.id !== id) {
      throw new Error(`${this.#name} MCP returned a mismatched JSON-RPC response.`);
    }
    if (raw.error !== void 0) {
      const error = asRecord(raw.error, `${this.#name} MCP JSON-RPC error`);
      if (!Number.isInteger(error.code)) {
        throw new Error(`${this.#name} MCP returned an invalid error.`);
      }
      if (PRE_DISPATCH_JSON_RPC_ERRORS.has(error.code)) {
        const detail = typeof error.message === "string" && error.message.length > 0 ? `: ${error.message.slice(0, MAX_REJECTION_DETAIL_CHARS)}` : ".";
        throw new ProtocolRejection(`${this.#name} MCP rejected the request${detail}`);
      }
      throw new ConfirmedRemoteFailure(`${this.#name} MCP rejected the request.`);
    }
    if (!("result" in raw)) throw new Error(`${this.#name} MCP response omitted its result.`);
    return raw.result;
  }
  async #mcpNotify(access, method, signal) {
    const sentSession = this.#sessionId;
    const { response } = await this.#request(
      this.#endpointUrl(access.endpoint),
      {
        method: "POST",
        headers: this.#mcpHeaders(access, method),
        body: JSON.stringify({ jsonrpc: "2.0", method }),
        signal
      },
      MCP_CONTROL_RESPONSE_BYTES
    );
    if (!response.ok) this.#rejectHttpStatus(response, method, access, sentSession);
    this.#acceptSessionId(response, access, sentSession);
  }
  async #handshake(access, signal) {
    this.#protocol = null;
    this.#sessionId = null;
    let initialized = null;
    try {
      initialized = asRecord(
        await this.#mcpRpc(
          access,
          "initialize",
          {
            protocolVersion: INITIALIZE_PROTOCOL_VERSIONS[0],
            capabilities: {},
            clientInfo: CLIENT_INFO
          },
          signal,
          MCP_CONTROL_RESPONSE_BYTES
        ),
        `${this.#name} MCP initialize result`
      );
    } catch (error) {
      if (!(error instanceof ProtocolRejection)) throw error;
    }
    if (initialized) {
      const version = initialized.protocolVersion;
      const capabilities = initialized.capabilities;
      if (typeof version !== "string" || !INITIALIZE_PROTOCOL_VERSIONS.includes(version) || !capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) || !capabilities.tools || typeof capabilities.tools !== "object") {
        throw new IntegrationProviderPublicError(
          `${this.#name} MCP protocol changed from the reviewed versions.`
        );
      }
      this.#protocol = { mode: "initialize", version };
      await this.#mcpNotify(access, "notifications/initialized", signal);
      return;
    }
    this.#protocol = { mode: "discover" };
    this.#sessionId = null;
    const discover = asRecord(
      await this.#mcpRpc(access, "server/discover", void 0, signal, MCP_CONTROL_RESPONSE_BYTES),
      `${this.#name} MCP server/discover result`
    );
    if (discover.resultType !== "complete" || !Array.isArray(discover.supportedVersions) || !discover.supportedVersions.includes(DISCOVER_PROTOCOL_VERSION) || !discover.capabilities || typeof discover.capabilities !== "object" || !discover.capabilities.tools) {
      throw new IntegrationProviderPublicError(
        `${this.#name} MCP protocol changed from the reviewed versions.`
      );
    }
  }
  async #initializeSession(access, signal) {
    await this.#serializeSession(async () => {
      if (this.#sessionVerified && this.#sessionAccess === access) return;
      await this.#handshake(access, signal);
      const collected = [];
      let cursor;
      for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
        const result = asRecord(
          await this.#mcpRpc(
            access,
            "tools/list",
            cursor === void 0 ? void 0 : { cursor },
            signal,
            MCP_CONTROL_RESPONSE_BYTES
          ),
          `${this.#name} MCP tools/list result`
        );
        if (result.resultType !== void 0 && result.resultType !== "complete" || !Array.isArray(result.tools)) {
          throw new Error(`${this.#name} MCP tool inventory is invalid.`);
        }
        collected.push(...result.tools);
        if (collected.length > MAX_MCP_TOOLS) {
          throw new Error(`${this.#name} MCP tool inventory is too large.`);
        }
        if (result.nextCursor === void 0 || result.nextCursor === null) {
          cursor = void 0;
          break;
        }
        cursor = boundedString(result.nextCursor, 2048, `${this.#name} MCP tools cursor`);
      }
      if (cursor !== void 0) {
        throw new Error(`${this.#name} MCP tool inventory pagination is too large.`);
      }
      const inventory = validateToolInventory(this.#policy, access.endpoint, collected);
      if (this.#accessToken !== access) {
        throw new SessionInvalidError(`${this.#name} access was refreshed during session setup.`);
      }
      this.#availableTools = inventory.available;
      this.#pausedTools = inventory.paused;
      this.#unofferedTools = inventory.unoffered;
      this.#sessionVerified = true;
      this.#sessionAccess = access;
    });
  }
  async #postRevocation(discovery, token, clientId, signal, accessToken) {
    const headers = {
      "content-type": "application/x-www-form-urlencoded"
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const { response } = await this.#request(
      discovery.revocationEndpoint,
      {
        method: "POST",
        headers,
        body: new URLSearchParams({ client_id: clientId, token, token_type_hint: "refresh_token" }),
        signal
      },
      METADATA_RESPONSE_BYTES
    );
    return response;
  }
  /**
   * Revokes one grant. Resolves when the grant is revoked or can never be revoked (already invalid,
   * or issued for an endpoint the service cannot revoke); throws a confirmed failure to retry later.
   */
  async #revokeGrant(discovery, grant, signal, accessToken) {
    const endpoint = grant.endpoint === void 0 ? null : this.#endpointForPath(grant.endpoint);
    if (endpoint && endpoint.revocable === false) return;
    const failed = () => new ConfirmedRemoteFailure(`${this.#name} could not revoke the credential. Try again.`);
    if (this.#policy.oauth.revocation === "rfc7009") {
      const response2 = await this.#postRevocation(
        discovery,
        grant.refreshToken,
        grant.clientId,
        signal
      );
      if (!response2.ok) throw failed();
      return;
    }
    let access = accessToken;
    let current = grant.refreshToken;
    if (!access) {
      const body = {
        client_id: grant.clientId,
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken
      };
      if (endpoint) body.resource = this.#endpointUrl(endpoint);
      const { response: response2, json } = await this.#requestJson(
        discovery.tokenEndpoint,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams(body),
          signal
        },
        TOKEN_RESPONSE_BYTES
      );
      if (response2.status === 400 && json.error === "invalid_grant") return;
      if (!response2.ok) throw failed();
      access = boundedString(
        json.access_token,
        MAX_TOKEN_CHARS,
        `${this.#name} OAuth access token`
      );
      if (json.refresh_token !== void 0) {
        current = boundedString(
          json.refresh_token,
          MAX_TOKEN_CHARS,
          `${this.#name} OAuth refresh token`
        );
      }
    }
    const replacement = current === grant.refreshToken ? null : { clientId: grant.clientId, refreshToken: current, endpoint: grant.endpoint };
    let response;
    try {
      response = await this.#postRevocation(discovery, current, grant.clientId, signal, access);
    } catch {
      throw new RevocationIncomplete(failed().message, replacement);
    }
    if (response.status === 401) return;
    if (!response.ok) throw new RevocationIncomplete(failed().message, replacement);
    if (current !== grant.refreshToken) {
      await this.#postRevocation(discovery, grant.refreshToken, grant.clientId, signal, access).then(() => void 0).catch(() => void 0);
    }
  }
  #parseTokenResponse(json, clientId, endpoint, discovery, existingRefreshToken) {
    if (typeof json.token_type !== "string" || json.token_type.toLowerCase() !== "bearer") {
      throw new Error(`${this.#name} OAuth returned an invalid token type.`);
    }
    const accessToken = boundedString(
      json.access_token,
      MAX_TOKEN_CHARS,
      `${this.#name} OAuth access token`
    );
    const refreshToken = json.refresh_token === void 0 ? existingRefreshToken : boundedString(json.refresh_token, MAX_TOKEN_CHARS, `${this.#name} OAuth refresh token`);
    if (!refreshToken) throw new Error(`${this.#name} OAuth did not issue renewable access.`);
    let expiresIn = DEFAULT_ACCESS_TOKEN_SECONDS;
    if (json.expires_in !== void 0) {
      if (!Number.isInteger(json.expires_in) || json.expires_in < 60 || json.expires_in > 86400) {
        throw new Error(`${this.#name} OAuth token lifetime is invalid.`);
      }
      expiresIn = json.expires_in;
    }
    if (json.scope !== void 0 && (typeof json.scope !== "string" || json.scope.length > 4096)) {
      throw new Error(`${this.#name} OAuth scope grant is invalid.`);
    }
    return {
      credential: {
        version: 1,
        origin: this.#origin.origin,
        endpoint: endpoint.path,
        issuer: discovery.issuer,
        clientId,
        refreshToken,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      access: { value: accessToken, expiresAt: Date.now() + expiresIn * 1e3, endpoint }
    };
  }
  #validateCapabilities(capabilities) {
    const known = new Set(this.#policy.endpoints.flatMap((endpoint) => endpoint.capabilities));
    if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length || capabilities.some((capability) => !known.has(capability))) {
      throw new Error(`Unsupported ${this.#name} capability.`);
    }
  }
  async status(context) {
    if (this.#uncertainCredentialState) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Credential state is uncertain. Disconnect to verify reset before reconnecting."
      };
    }
    if (this.#closed || this.#disconnecting) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: this.#closed ? `The ${this.#name} provider is closed.` : `${this.#name} is disconnecting.`
      };
    }
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    try {
      const credential = await this.#readCredential(context?.signal);
      if (generation !== this.#generation || revision !== this.#credentialRevision || this.#closed || this.#disconnecting) {
        throw new Error(`${this.#name} connection changed during status.`);
      }
      if (!credential) {
        const revocationPending = await this.#secrets.get(REVOCATION_SECRET_SUFFIX) !== null;
        return {
          state: this.#pending.size > 0 ? "connecting" : "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message: revocationPending ? `Disconnected here, but ${this.#name} has not confirmed revoking the previous sign-in. It is retried on the next connect or disconnect.` : null
        };
      }
      const endpoint = this.#endpointForPath(credential.endpoint);
      const paused = this.#pausedTools.length > 0 ? ` Paused until the plugin is updated because ${this.#name} changed them: ${this.#pausedTools.join(", ")}.` : "";
      const unoffered = this.#unofferedTools.length > 0 ? ` Not offered by ${this.#name} on this connection: ${this.#unofferedTools.join(", ")}.` : "";
      return {
        state: "connected",
        accountLabel: `${this.#name} (${endpoint.label})`,
        grantedCapabilities: [...endpoint.capabilities],
        message: `Connected with your own ${this.#name} permissions (${endpoint.label.toLowerCase()} access).${paused}${unoffered}${this.#renewalDeferred ? ` ${this.#name} was briefly unavailable while renewing access; the next request retries.` : ""}`
      };
    } catch {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: `The stored ${this.#name} connection could not be verified. Disconnect to reset it.`
      };
    }
  }
  async connect(capabilities, context, submission) {
    if (submission !== void 0) {
      throw new Error(`${this.#name} browser sign-in rejects credential submissions.`);
    }
    if (this.#closed || this.#disconnecting) throw new Error(`${this.#name} is unavailable.`);
    if (this.#uncertainCredentialState) {
      throw new Error(`${this.#name} credential state is uncertain.`);
    }
    this.#validateCapabilities(capabilities);
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    const attempt = ++this.#connectAttempt;
    const existing = await this.#readCredential(context?.signal);
    if (existing) {
      const granted = this.#endpointForPath(existing.endpoint).capabilities;
      if (capabilities.every((capability) => granted.includes(capability))) {
        return {
          kind: "connected",
          flowId: NodeCrypto2.randomUUID(),
          message: `${this.#name} is already authorized for this user.`
        };
      }
    }
    const endpoint = this.#policy.endpoints.find(
      (candidate) => capabilities.every((capability) => candidate.capabilities.includes(capability))
    );
    if (!endpoint) {
      throw new IntegrationProviderPublicError(
        `${this.#name} cannot grant that combination of access.`
      );
    }
    const discovery = await this.#discover(endpoint, context?.signal);
    await this.#clearPendingFlows();
    const flowId = NodeCrypto2.randomUUID();
    const state = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const expiresAt = Date.now() + FLOW_LIFETIME_MS;
    const flow = await this.#startFlowListener(
      { flowId, state, codeVerifier, endpoint, discovery, expiresAt, generation },
      context?.signal
    );
    let admitted = false;
    try {
      const commitSignal = await this.#beginCommit(context);
      admitted = true;
      await this.#serializeCredential(async () => {
        try {
          await this.#retryPendingRevocations(discovery, commitSignal);
        } catch (error) {
          if (commitSignal.aborted) throw error;
        }
        const reserved = existing ? 3 : 1;
        if ((await this.#readPendingRevocations()).length > MAX_PENDING_REVOCATIONS - reserved) {
          throw new ConfirmedRemoteFailure(
            `${this.#name} has not confirmed revoking earlier sign-ins. Try again once ${this.#name} accepts revocation.`
          );
        }
      });
      const clientId = await this.#registerClient(discovery, flow.redirectUri, commitSignal);
      if (generation !== this.#generation || revision !== this.#credentialRevision || attempt !== this.#connectAttempt || this.#closed || this.#disconnecting) {
        throw new Error(`${this.#name} sign-in was superseded while starting.`);
      }
      flow.clientId = clientId;
      this.#pending.set(flowId, flow);
    } catch (error) {
      await this.#closeFlowListener(flow, true);
      if (admitted && !(error instanceof ConfirmedRemoteFailure)) {
        this.#uncertainCredentialState = true;
        throw new ExternalCommitOutcomeUnknownError(
          `The ${this.#name} OAuth client registration may have completed. Disconnect before retrying.`
        );
      }
      throw error;
    }
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", flow.clientId);
    authorizationUrl.searchParams.set("redirect_uri", flow.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    if (discovery.scopes.length > 0) {
      authorizationUrl.searchParams.set("scope", discovery.scopes.join(" "));
    }
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set(
      "code_challenge",
      NodeCrypto2.createHash("sha256").update(codeVerifier, "ascii").digest("base64url")
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", this.#endpointUrl(endpoint));
    return {
      kind: "authorization_url",
      flowId,
      authorizationUrl: authorizationUrl.toString(),
      message: `Continue in your browser and approve ${this.#name} access for your own account.`,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: FLOW_POLL_SECONDS
    };
  }
  async poll(flowId, context) {
    const flow = this.#pending.get(flowId);
    if (!flow)
      throw new IntegrationProviderPublicError(`${this.#name} sign-in flow was not found.`);
    if (this.#polling.has(flowId)) {
      throw new IntegrationProviderPublicError(`${this.#name} sign-in is already being checked.`);
    }
    if (flow.callback?.kind === "code" ? flow.callbackExpiresAt !== null && flow.callbackExpiresAt <= Date.now() : flow.expiresAt <= Date.now()) {
      await this.#removeFlow(flowId);
      return {
        state: "expired",
        retryAfterSeconds: null,
        message: `${this.#name} sign-in expired. Start again.`
      };
    }
    if (flow.callback === null) {
      return {
        state: "pending",
        retryAfterSeconds: FLOW_POLL_SECONDS,
        message: `Waiting for ${this.#name} sign-in.`
      };
    }
    if (flow.callback.kind === "error") {
      await this.#removeFlow(flowId);
      return {
        state: "failed",
        retryAfterSeconds: null,
        message: flow.callback.error === "access_denied" ? `${this.#name} sign-in was cancelled.` : `${this.#name} sign-in did not complete. Start again.`
      };
    }
    const authorizationCode = flow.callback.code;
    this.#polling.add(flowId);
    try {
      return await this.#serializeCredential(async () => {
        if (this.#closed || this.#disconnecting || this.#uncertainCredentialState || flow.generation !== this.#generation || this.#pending.get(flowId) !== flow) {
          throw new Error(`${this.#name} sign-in was superseded before token exchange.`);
        }
        const storedReplaced = await this.#secrets.get(OAUTH_SECRET_SUFFIX);
        let replaced = null;
        if (storedReplaced !== null) {
          try {
            replaced = this.#parseCredential(storedReplaced);
          } catch {
            replaced = null;
          }
        }
        let admitted = false;
        let responseSettled = false;
        let exchanged = false;
        let persisted = false;
        let replacedQueued = false;
        let issued = null;
        let issuedAccess = null;
        const failed = (message) => ({
          state: "failed",
          retryAfterSeconds: null,
          message
        });
        try {
          const commitSignal = await this.#beginCommit(context);
          admitted = true;
          const { response, json } = await this.#requestJson(
            flow.discovery.tokenEndpoint,
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded"
              },
              body: new URLSearchParams({
                client_id: flow.clientId,
                code: authorizationCode,
                code_verifier: flow.codeVerifier,
                grant_type: "authorization_code",
                redirect_uri: flow.redirectUri,
                resource: this.#endpointUrl(flow.endpoint)
              }),
              signal: commitSignal
            },
            TOKEN_RESPONSE_BYTES
          );
          responseSettled = true;
          if (!response.ok) {
            await this.#removeFlow(flowId);
            return failed(`${this.#name} sign-in failed. Start again.`);
          }
          exchanged = true;
          const parsed = this.#parseTokenResponse(
            json,
            flow.clientId,
            flow.endpoint,
            flow.discovery
          );
          issued = parsed.credential;
          issuedAccess = parsed.access.value;
          this.#accessToken = parsed.access;
          this.#resetSession();
          try {
            await this.#initializeSession(parsed.access, commitSignal);
          } catch (error) {
            this.#accessToken = null;
            this.#resetSession();
            await this.#discardIssuedGrant(
              flow.discovery,
              parsed.credential,
              commitSignal,
              parsed.access.value
            );
            issued = null;
            await this.#removeFlow(flowId);
            return failed(
              error instanceof IntegrationProviderPublicError ? error.message : `${this.#name} MCP connection verification failed. Try again.`
            );
          }
          if (this.#closed || this.#disconnecting || this.#uncertainCredentialState || flow.generation !== this.#generation || this.#pending.get(flowId) !== flow) {
            throw new Error(`${this.#name} sign-in was superseded before credential commit.`);
          }
          if (replaced && replaced.refreshToken !== parsed.credential.refreshToken) {
            const pending = await this.#readPendingRevocations();
            if (!pending.some((grant) => grant.refreshToken === replaced.refreshToken)) {
              await this.#writePendingRevocations([
                ...pending,
                {
                  clientId: replaced.clientId,
                  refreshToken: replaced.refreshToken,
                  endpoint: replaced.endpoint
                }
              ]);
              replacedQueued = true;
            }
          }
          await this.#writeCredential(parsed.credential, commitSignal, () => {
            persisted = true;
            issued = null;
            this.#renewalDeferred = false;
          });
          this.#credentialRevision += 1;
          this.#generation += 1;
          await this.#removeFlow(flowId);
          if (replaced) {
            try {
              await this.#retryPendingRevocations(flow.discovery, commitSignal);
            } catch {
            }
          }
          return {
            state: "connected",
            retryAfterSeconds: null,
            message: `${this.#name} is connected for this user.`
          };
        } catch (error) {
          if (!admitted || persisted) throw error;
          if (!responseSettled || exchanged && issued === null) {
            this.#uncertainCredentialState = true;
            throw new ExternalCommitOutcomeUnknownError(
              `The ${this.#name} sign-in commit may have completed. Disconnect before retrying.`
            );
          }
          if (issued) {
            const grant = issued;
            if (replacedQueued && replaced) {
              await this.#writePendingRevocations(
                (await this.#readPendingRevocations()).filter(
                  (entry) => entry.refreshToken !== replaced.refreshToken
                )
              ).catch(() => void 0);
            }
            this.#accessToken = null;
            this.#resetSession();
            try {
              await this.#discardIssuedGrant(
                flow.discovery,
                grant,
                new AbortController().signal,
                issuedAccess ?? void 0
              );
            } catch {
              this.#uncertainCredentialState = true;
              throw new ExternalCommitOutcomeUnknownError(
                `The ${this.#name} sign-in issued access that could not be stored or revoked. Disconnect before retrying.`
              );
            }
            await this.#removeFlow(flowId);
            return failed(`${this.#name} sign-in did not complete. Start again.`);
          }
          throw error;
        }
      });
    } finally {
      this.#polling.delete(flowId);
    }
  }
  prepare(context) {
    return this.#serializeCredential(async () => {
      if (this.#closed || this.#disconnecting) throw new Error(`${this.#name} is unavailable.`);
      if (this.#uncertainCredentialState) {
        throw new Error(`${this.#name} credential state is uncertain.`);
      }
      const access = this.#accessToken;
      if (access && access.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) {
        await this.#initializeSession(access, context?.signal ?? new AbortController().signal);
        return;
      }
      const generation = this.#generation;
      const revision = this.#credentialRevision;
      const credential = await this.#readCredential(context?.signal);
      if (!credential) return;
      const endpoint = this.#endpointForPath(credential.endpoint);
      const discovery = await this.#discover(endpoint, context?.signal);
      if (discovery.issuer !== credential.issuer) {
        throw new Error(`${this.#name} OAuth issuer changed from the stored credential.`);
      }
      let admitted = false;
      let responseSettled = false;
      let credentialIssued = false;
      let credentialPersisted = false;
      try {
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        const body = new URLSearchParams({
          client_id: credential.clientId,
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          resource: this.#endpointUrl(endpoint)
        });
        const { response, json } = await this.#requestJson(
          discovery.tokenEndpoint,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded"
            },
            body,
            signal: commitSignal
          },
          TOKEN_RESPONSE_BYTES
        );
        responseSettled = true;
        this.#renewalDeferred = false;
        if (!response.ok) {
          if (response.status === 400 && json.error === "invalid_grant") {
            await this.#secrets.remove(OAUTH_SECRET_SUFFIX);
            this.#accessToken = null;
            this.#credentialRevision += 1;
            this.#resetSession();
            return;
          }
          if (response.status === 429 || response.status >= 500) {
            this.#renewalDeferred = true;
            return;
          }
          throw new IntegrationProviderPublicError(
            `${this.#name} access could not be refreshed. Disconnect and reconnect.`
          );
        }
        credentialIssued = true;
        const parsed = this.#parseTokenResponse(
          json,
          credential.clientId,
          endpoint,
          discovery,
          credential.refreshToken
        );
        if (generation !== this.#generation || revision !== this.#credentialRevision) {
          throw new Error(`${this.#name} connection changed while refreshing.`);
        }
        await this.#writeCredential(parsed.credential, commitSignal, () => {
          credentialPersisted = true;
          this.#renewalDeferred = false;
          this.#credentialRevision += 1;
          this.#accessToken = parsed.access;
          this.#resetSession();
        });
        await this.#initializeSession(parsed.access, commitSignal);
      } catch (error) {
        if (credentialPersisted) return;
        if (admitted && (!responseSettled || credentialIssued)) {
          this.#uncertainCredentialState = true;
          throw new ExternalCommitOutcomeUnknownError(
            `The ${this.#name} credential refresh may have completed. Disconnect before retrying.`
          );
        }
        throw error;
      }
    });
  }
  async #readPendingRevocations() {
    const encoded = await this.#secrets.get(REVOCATION_SECRET_SUFFIX);
    return encoded === null ? [] : parsePendingRevocations(encoded);
  }
  async #writePendingRevocations(grants) {
    if (grants.length === 0) {
      await this.#secrets.remove(REVOCATION_SECRET_SUFFIX);
      return;
    }
    await this.#secrets.set(
      REVOCATION_SECRET_SUFFIX,
      JSON.stringify({ version: 1, origin: this.#origin.origin, grants })
    );
  }
  async #retryPendingRevocations(discovery, signal) {
    if (await this.#secrets.get(REVOCATION_SECRET_SUFFIX) === null) return;
    const budget = AbortSignal.timeout(
      Math.min(REVOCATION_RETRY_BUDGET_MS, this.#requestTimeoutMs)
    );
    const retrySignal = AbortSignal.any([signal, budget]);
    const remaining = [];
    const grants = await this.#readPendingRevocations();
    for (let index = 0; index < grants.length; index += 1) {
      const grant = grants[index];
      if (budget.aborted) {
        remaining.push(grant);
        continue;
      }
      try {
        await this.#revokeGrant(discovery, grant, retrySignal);
      } catch (error) {
        remaining.push(grant);
        if (error instanceof RevocationIncomplete && error.replacement) {
          remaining.push(error.replacement);
        }
        if (signal.aborted) {
          remaining.push(...grants.slice(index + 1));
          await this.#writePendingRevocations(remaining);
          throw error;
        }
      }
    }
    await this.#writePendingRevocations(remaining);
  }
  /** Revokes an issued grant that will not be stored, or queues it so a later retry revokes it. */
  async #discardIssuedGrant(discovery, grant, signal, accessToken) {
    const pendingGrant = {
      clientId: grant.clientId,
      refreshToken: grant.refreshToken,
      endpoint: grant.endpoint
    };
    const queued = [pendingGrant];
    try {
      await this.#revokeGrant(
        discovery,
        pendingGrant,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(REVOCATION_RETRY_BUDGET_MS, this.#requestTimeoutMs))
        ]),
        accessToken
      );
      return;
    } catch (error) {
      if (error instanceof RevocationIncomplete && error.replacement) {
        queued.push(error.replacement);
      }
    }
    const pending = await this.#readPendingRevocations();
    const additions = queued.filter(
      (entry) => !pending.some((existing) => existing.refreshToken === entry.refreshToken)
    );
    if (additions.length > 0) await this.#writePendingRevocations([...pending, ...additions]);
  }
  disconnect(context) {
    return this.#serializeCredential(async () => {
      this.#disconnecting = true;
      this.#generation += 1;
      this.#connectAttempt += 1;
      this.#resetSession();
      await this.#clearPendingFlows();
      let admitted = false;
      try {
        const encoded = await this.#secrets.get(OAUTH_SECRET_SUFFIX);
        context?.signal?.throwIfAborted();
        let credential = null;
        if (encoded !== null) {
          try {
            credential = this.#parseCredential(encoded);
          } catch {
            credential = null;
          }
        }
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        if (credential) {
          const pending = await this.#readPendingRevocations();
          if (!pending.some((grant) => grant.refreshToken === credential.refreshToken)) {
            await this.#writePendingRevocations([
              ...pending,
              {
                clientId: credential.clientId,
                refreshToken: credential.refreshToken,
                endpoint: credential.endpoint
              }
            ]);
          }
        }
        await this.#secrets.remove(OAUTH_SECRET_SUFFIX);
        this.#accessToken = null;
        this.#credentialRevision += 1;
        this.#uncertainCredentialState = false;
        this.#renewalDeferred = false;
        const endpoint = credential ? this.#endpointForPath(credential.endpoint) : this.#policy.endpoints[0];
        let discovery;
        try {
          discovery = await this.#discover(
            endpoint,
            AbortSignal.any([
              commitSignal,
              AbortSignal.timeout(Math.min(REVOCATION_RETRY_BUDGET_MS, this.#requestTimeoutMs))
            ])
          );
        } catch {
          return;
        }
        if (!commitSignal.aborted) {
          try {
            await this.#retryPendingRevocations(discovery, commitSignal);
          } catch {
          }
        }
      } catch (error) {
        if (admitted) {
          this.#uncertainCredentialState = true;
          throw new ExternalCommitOutcomeUnknownError(
            `The ${this.#name} disconnect may have completed. Verify the connection state before retrying.`
          );
        }
        throw error;
      } finally {
        this.#disconnecting = false;
      }
    });
  }
  async invoke(toolName, input, context) {
    const reviewed = this.#policy.tools.find((tool) => tool.name === toolName);
    if (!reviewed) throw new IntegrationProviderPublicError(`Unknown ${this.#name} tool.`);
    const write = reviewed.effect === "write";
    if (write && context?.writeApproved !== true) {
      throw new Error(`${this.#name} writes require explicit Harness approval.`);
    }
    assertJsonBounds(input, this.#name);
    const violation = this.#validators.get(reviewed.name).validate(input);
    if (violation) {
      throw new IntegrationProviderPublicError(
        `Invalid ${reviewed.name} input: ${violation.replace(/^\$\.?/u, "") || "input"}.`
      );
    }
    const generation = this.#generation;
    const access = this.#accessToken;
    if (!access || access.expiresAt - ACCESS_TOKEN_SKEW_MS <= Date.now() || !this.#sessionVerified || this.#sessionAccess !== access || this.#closed || this.#disconnecting || this.#uncertainCredentialState) {
      throw new IntegrationProviderPublicError(
        this.#renewalDeferred && !this.#uncertainCredentialState ? `${this.#name} was briefly unavailable while renewing access, so this call was not run. Try again in a moment.` : `${this.#name} access is not prepared. Reconnect if this continues.`
      );
    }
    const assertAvailable = () => {
      if (!access.endpoint.capabilities.includes(reviewed.capability)) {
        throw new IntegrationProviderPublicError(
          `This ${this.#name} tool needs an ability the current connection does not include. Turn it on for the ${this.#name} plugin in Settings, which signs in to ${this.#name} again.`
        );
      }
      if (!this.#availableTools.has(reviewed.upstreamName)) {
        throw new IntegrationProviderPublicError(
          this.#unofferedTools.includes(reviewed.name) ? `${this.#name} does not offer this tool on the current connection.` : `${this.#name} changed this tool, so it is paused until the TritonAI ${this.#name} plugin is updated.`
        );
      }
    };
    assertAvailable();
    let admitted = false;
    let signal = context?.signal;
    if (write) {
      if (typeof context?.beginCommit !== "function") {
        throw new Error(`${this.#name} writes require Harness commit admission.`);
      }
      signal = await context.beginCommit();
      admitted = true;
    }
    if (!signal) throw new Error(`${this.#name} invocation requires a cancellation signal.`);
    const commitSignal = signal;
    const timeout = TOOL_CALL_TIMEOUT_MS;
    const assertAccessCurrent = () => {
      if (generation !== this.#generation || this.#closed || this.#disconnecting) {
        throw new Error(`${this.#name} access changed during the tool call.`);
      }
    };
    const call = async () => {
      assertAvailable();
      const result = asRecord(
        await this.#mcpRpc(
          access,
          "tools/call",
          { name: reviewed.upstreamName, arguments: input },
          commitSignal,
          MCP_TOOL_RESPONSE_BYTES,
          timeout
        ),
        `${this.#name} MCP tool result`
      );
      if (result.resultType !== void 0 && result.resultType !== "complete") {
        throw new ConfirmedRemoteFailure(
          `${this.#name} asked for an interactive MCP response that TritonAI Harness does not support.`
        );
      }
      assertAccessCurrent();
      if (result.isError === true) {
        if (!write) return result;
        const content = Array.isArray(result.content) ? result.content : [];
        return {
          ...result,
          content: [...content, { type: "text", text: this.#policy.writeFailureNote }]
        };
      }
      return result;
    };
    let failure;
    try {
      return await call();
    } catch (error) {
      failure = error;
    }
    if ((failure instanceof SessionInvalidError || failure instanceof AuthorizationExpired) && this.#accessToken !== access) {
      assertAccessCurrent();
      return rejectedToolResult(
        `${this.#name} access was refreshed during this call, which was not run. Try again.`
      );
    }
    if (failure instanceof SessionInvalidError) {
      try {
        await this.#initializeSession(access, commitSignal);
        assertAvailable();
      } catch (error) {
        if (this.#accessToken !== access) {
          assertAccessCurrent();
          return rejectedToolResult(
            `${this.#name} access was refreshed during this call, which was not run. Try again.`
          );
        }
        if (!admitted) throw error;
        assertAccessCurrent();
        return rejectedToolResult(
          error instanceof IntegrationProviderPublicError ? error.message : `${this.#name} MCP session expired and could not be restored. Try again.`
        );
      }
      try {
        return await call();
      } catch (error) {
        failure = error;
      }
    }
    if (failure instanceof RemoteRejection || failure instanceof SessionInvalidError) {
      assertAccessCurrent();
      return rejectedToolResult(failure.message);
    }
    if (write && admitted) {
      this.#uncertainCredentialState = true;
      throw new ExternalCommitOutcomeUnknownError(
        `The ${this.#name} operation may have completed. Check the document before retrying.`
      );
    }
    throw failure;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#connectAttempt += 1;
    for (const controller of this.#requestControllers) controller.abort();
    await this.#clearPendingFlows();
    this.#accessToken = null;
    this.#resetSession();
  }
};

// src/index.ts
function configuration(value) {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).toSorted().join(",") !== "serverOrigin" || value.serverOrigin !== LUCID_ORIGIN) {
    throw new Error("Lucid configuration must contain only the reviewed server origin.");
  }
}
var createIntegrationProvider = ({
  secrets,
  configuration: input
}) => {
  configuration(input);
  return new RemoteMcpProvider(LUCID_POLICY, secrets);
};
export {
  createIntegrationProvider
};
