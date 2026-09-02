import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import manifest from "../.tritonai-plugin/plugin.json" with { type: "json" };
import { N8N_TOOLS } from "./N8nProvider.ts";
import type { IntegrationSecretStore } from "./host-contract.ts";
import { createIntegrationProvider } from "./index.ts";

const sdkManifest = manifest as unknown as {
  readonly provider: string;
  readonly capabilities: readonly { readonly id: string; readonly access: string }[];
  readonly tools: readonly {
    readonly name: string;
    readonly effect: "read" | "write";
    readonly destructive: boolean;
    readonly idempotent: boolean;
    readonly openWorld: boolean;
    readonly inputSchema: unknown;
  }[];
};

const secrets: IntegrationSecretStore = {
  get: async () => null,
  set: async () => undefined,
  remove: async () => undefined,
};

function inputSchema(input: Schema.Decoder<unknown>) {
  const document = Schema.toJsonSchemaDocument(input);
  const schema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
  if (schema.type === "object" && schema.properties === undefined) schema.properties = {};
  return schema;
}

describe("n8n SDK plugin factory", () => {
  it("keeps the sealed manifest and reviewed runtime tools identical", () => {
    const provider = createIntegrationProvider({
      secrets,
      configuration: Object.assign(Object.create(null), {
        serverUrl: "https://n8n.tritonai.ucsd.edu/mcp-server/http",
      }),
    });
    expect(provider.id).toBe(sdkManifest.provider);
    expect(
      sdkManifest.tools.map(
        ({ name, effect, destructive, idempotent, openWorld, inputSchema: input }) => ({
          name,
          effect,
          destructive,
          idempotent,
          openWorld,
          inputSchema: input,
        }),
      ),
    ).toEqual(
      N8N_TOOLS.map((tool) => ({
        name: tool.name,
        effect: tool.readOnly ? "read" : "write",
        destructive: tool.destructive,
        idempotent: tool.idempotent,
        openWorld: tool.openWorld,
        inputSchema: inputSchema(tool.input),
      })),
    );
    expect(sdkManifest.capabilities.map(({ id, access }) => ({ id, access }))).toEqual([
      { id: "read", access: "authorization" },
      { id: "write", access: "authorization" },
    ]);
  });

  it("rejects every arbitrary, malformed, or extra endpoint without disclosure", () => {
    const sentinel = "https://attacker.invalid/mcp?secret=do-not-disclose";
    for (const configuration of [
      null,
      [],
      {},
      { serverUrl: 42 },
      { serverUrl: sentinel },
      { serverUrl: "http://n8n.tritonai.ucsd.edu/mcp-server/http" },
      { serverUrl: "https://n8n.tritonai.ucsd.edu/mcp-server/http", extra: sentinel },
      Object.create({ serverUrl: "https://n8n.tritonai.ucsd.edu/mcp-server/http" }),
    ]) {
      let failure: unknown;
      try {
        createIntegrationProvider({
          secrets,
          configuration: configuration as never,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(sentinel);
    }
  });
});
