import { describe, expect, it, vi } from "vite-plus/test";

import manifest from "../.tritonai-plugin/plugin.json" with { type: "json" };
import type { IntegrationSecretStore } from "./host-contract.ts";
import { createIntegrationProvider } from "./index.ts";
import {
  EXCLUDED_UPSTREAM_TOOLS,
  LUCID_CAPABILITIES,
  LUCID_ORIGIN,
  LUCID_POLICY,
  LUCID_TOOLS,
} from "./lucid-tools.ts";
import { compatibleUpstreamSchema, compileSchema } from "./remote-mcp/json-schema.ts";
import { RemoteMcpProvider, validateToolInventory } from "./remote-mcp/RemoteMcpProvider.ts";
import { UPSTREAM_READONLY_TOOL_NAMES, UPSTREAM_TOOLS } from "./upstream-tools.ts";

const sdkManifest = manifest as unknown as {
  readonly id: string;
  readonly provider: string;
  readonly capabilities: readonly { readonly id: string; readonly access: string }[];
  readonly configurationSchema: unknown;
  readonly tools: readonly {
    readonly name: string;
    readonly displayName: string;
    readonly description: string;
    readonly capabilities: readonly string[];
    readonly effect: "read" | "write";
    readonly destructive: boolean;
    readonly idempotent: boolean;
    readonly openWorld: boolean;
    readonly inputSchema: unknown;
  }[];
};

// Reads whose upstream readOnlyHint is not true, with the reason each is still a read. None today.
const READ_BY_REVIEW: Readonly<Record<string, string>> = {};

const secrets: IntegrationSecretStore = {
  get: async () => null,
  set: async () => undefined,
  remove: async () => undefined,
};

describe("Lucid SDK plugin factory", () => {
  it("keeps the sealed manifest and the reviewed runtime tools identical", () => {
    const provider = createIntegrationProvider({
      secrets,
      configuration: Object.assign(Object.create(null), { serverOrigin: LUCID_ORIGIN }),
    });
    expect(provider.id).toBe(sdkManifest.provider);
    expect(sdkManifest.id).toBe("lucid");
    expect(sdkManifest.tools).toEqual(
      LUCID_TOOLS.map((tool) => ({
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
    );
    expect(sdkManifest.capabilities.map(({ id, access }) => ({ id, access }))).toEqual([
      { id: "read", access: "default" },
      { id: "write", access: "opt-in" },
      { id: "share", access: "opt-in" },
    ]);
    expect(LUCID_CAPABILITIES.map(({ id }) => id)).toEqual(["read", "write", "share"]);
  });

  it("rejects every arbitrary, malformed, or extra configuration without disclosure", () => {
    const sentinel = "https://attacker.invalid/mcp?secret=do-not-disclose";
    for (const configuration of [
      null,
      [],
      {},
      { serverOrigin: 42 },
      { serverOrigin: sentinel },
      { serverOrigin: "http://mcp.lucid.app" },
      { serverOrigin: "https://mcp.lucid.app/" },
      { serverOrigin: LUCID_ORIGIN, extra: sentinel },
      Object.create({ serverOrigin: LUCID_ORIGIN }),
    ]) {
      let failure: unknown;
      try {
        createIntegrationProvider({ secrets, configuration: configuration as never });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(sentinel);
    }
  });
});

describe("Lucid reviewed catalog", () => {
  it("exposes every captured Lucid tool except the reviewed exclusions", () => {
    const exposed = new Set(LUCID_TOOLS.map((tool) => tool.upstreamName));
    const pinned = UPSTREAM_TOOLS.map((tool) => tool.name);
    expect(pinned.filter((name) => !exposed.has(name))).toEqual(
      pinned.filter((name) => EXCLUDED_UPSTREAM_TOOLS.includes(name)),
    );
    expect(LUCID_TOOLS).toHaveLength(30);
    expect(new Set(LUCID_TOOLS.map((tool) => tool.name)).size).toBe(30);
  });

  it("names, bounds, and classifies every tool explicitly", () => {
    for (const tool of LUCID_TOOLS) {
      expect(tool.name).toMatch(/^lucid\.[a-z][a-z0-9_]*$/u);
      expect(tool.description.length).toBeLessThanOrEqual(1_024);
      expect(tool.openWorld).toBe(true);
      expect(tool.inputSchema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
      expect(() => compileSchema(tool.inputSchema)).not.toThrow();
      expect(tool.effect).toBe(tool.capability === "read" ? "read" : "write");
      // A tool Lucid does not mark read-only is exposed as a read only by explicit review.
      if (tool.upstream.annotations.readOnlyHint !== true && !(tool.name in READ_BY_REVIEW)) {
        expect(tool.effect).toBe("write");
      }
      if (tool.upstream.annotations.destructiveHint === true) expect(tool.destructive).toBe(true);
    }
    const byName = new Map(LUCID_TOOLS.map((tool) => [tool.name, tool]));
    expect(byName.get("lucid.run_script")).toMatchObject({
      capability: "write",
      effect: "write",
      destructive: true,
    });
    expect(byName.get("lucid.share_with_collaborators")).toMatchObject({
      capability: "share",
      effect: "write",
    });
    expect(byName.get("lucid.submit_feedback")).toMatchObject({
      capability: "write",
      effect: "write",
    });
  });

  it("only refines upstream properties into narrower local schemas", () => {
    const typesOf = (schema: unknown): ReadonlySet<string> | null => {
      if (!schema || typeof schema !== "object") return null;
      const record = schema as Record<string, unknown>;
      if (typeof record.type === "string") return new Set([record.type]);
      if (Array.isArray(record.type)) return new Set(record.type as string[]);
      if (Array.isArray(record.anyOf)) {
        const union = new Set<string>();
        for (const member of record.anyOf) {
          const types = typesOf(member);
          if (!types) return null;
          for (const type of types) union.add(type);
        }
        return union;
      }
      return null;
    };
    for (const tool of LUCID_TOOLS) {
      const upstream = tool.upstream.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const local = tool.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(local.properties).toSorted()).toEqual(
        Object.keys(upstream.properties ?? {}).toSorted(),
      );
      for (const name of upstream.required ?? []) expect(local.required ?? []).toContain(name);
      for (const [name, schema] of Object.entries(local.properties)) {
        const allowed = typesOf((upstream.properties ?? {})[name]);
        const narrowed = typesOf(schema);
        if (allowed === null) continue;
        expect(narrowed, `${tool.name}.${name} must declare its types`).not.toBeNull();
        for (const type of narrowed!) {
          expect(
            allowed.has(type) || (type === "integer" && allowed.has("number")),
            `${tool.name}.${name} widens ${type}`,
          ).toBe(true);
        }
      }
    }
    expect(
      LUCID_TOOLS.find((tool) => tool.name === "lucid.create_share_link")!.inputSchema
        .required as string[],
    ).toEqual(expect.arrayContaining(["restrict_to_account", "allow_anonymous", "role"]));
    expect(
      LUCID_TOOLS.find((tool) => tool.name === "lucid.share_with_collaborators")!.inputSchema
        .required as string[],
    ).toContain("role");
    const validate = (name: string, input: unknown) =>
      compileSchema(LUCID_TOOLS.find((tool) => tool.name === name)!.inputSchema).validate(input);
    expect(
      validate("lucid.create_share_link", {
        document_id: "d",
        role: "owner",
        restrict_to_account: true,
        allow_anonymous: false,
      }),
    ).toContain("must be one of");
    expect(validate("lucid.create_share_link", { document_id: "d", role: "view" })).toBe(
      "$.restrict_to_account is required",
    );
    expect(
      validate("lucid.share_with_collaborators", {
        document_id: "d",
        role: "view",
        emails: ["not an email"],
      }),
    ).toContain("pattern");
    expect(validate("lucid.run_script", { document_id: "d" })).toBe("$.source is required");
    expect(validate("lucid.read_resource", { resource_uri: "https://example.invalid" })).toContain(
      "pattern",
    );
    expect(
      validate("lucid.create_diagram", {
        title: "t",
        product: "lucidchart",
        standard_import_json: "{}",
      }),
    ).toBeNull();
  });

  it("serves only read tools from the read-only endpoint and every tool from the full one", () => {
    const [readonly, full] = LUCID_POLICY.endpoints;
    const live = UPSTREAM_TOOLS.map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }));
    const readOnly = validateToolInventory(
      LUCID_POLICY,
      readonly!,
      live.filter((tool) => UPSTREAM_READONLY_TOOL_NAMES.includes(tool.name)),
    );
    expect(readOnly.paused).toEqual([]);
    expect([...readOnly.available].toSorted()).toEqual(
      UPSTREAM_READONLY_TOOL_NAMES.filter((name) =>
        LUCID_TOOLS.some((tool) => tool.upstreamName === name && tool.capability === "read"),
      ).toSorted(),
    );
    expect(readOnly.available.has("lucid_submit_feedback")).toBe(false);
    const everything = validateToolInventory(LUCID_POLICY, full!, live);
    expect(everything.paused).toEqual([]);
    expect(everything.available.size).toBe(30);
  });

  it("matches the pinned upstream contract to itself under the drift comparison", () => {
    for (const tool of UPSTREAM_TOOLS) {
      expect(compatibleUpstreamSchema(tool.inputSchema, tool.inputSchema)).toBe(true);
    }
  });

  it("refuses a write the host did not approve before any network call", async () => {
    const fetchImplementation = vi.fn();
    const provider = new RemoteMcpProvider(
      LUCID_POLICY,
      secrets,
      fetchImplementation as unknown as typeof fetch,
    );
    const controller = new AbortController();
    await expect(
      provider.invoke(
        "lucid.run_script",
        { document_id: "d", source: "return 1" },
        {
          signal: controller.signal,
          writeApproved: false,
          beginCommit: async () => controller.signal,
        },
      ),
    ).rejects.toThrow(/explicit Harness approval/u);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
