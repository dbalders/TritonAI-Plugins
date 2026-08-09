import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { IntegrationSecretStore } from "./host-contract.ts";
import { createIntegrationProvider, manifest } from "./index.ts";

const secrets: IntegrationSecretStore = {
  get: () => Effect.succeed(Option.none()),
  set: () => Effect.void,
  remove: () => Effect.void,
};

describe("n8n plugin factory", () => {
  it("constructs the manifest provider through the standard factory", () => {
    const provider = createIntegrationProvider({
      secrets,
      configuration: Object.assign(Object.create(null), {
        serverUrl: "https://n8n.tritonai.ucsd.edu/mcp-server/http",
      }),
    });
    expect(provider.id).toBe(manifest.provider);
    expect(provider.tools.map(({ name }) => name).toSorted()).toEqual(
      manifest.tools.map(({ name }) => name).toSorted(),
    );
    expect(manifest.capabilities).toHaveLength(9);
    expect(manifest.capabilities.every(({ access }) => access === "default")).toBe(true);
    expect(manifest.capabilities.map(({ id }) => id).toSorted()).toEqual([
      "credential.read",
      "data-table.read",
      "data-table.write",
      "execution.read",
      "project.read",
      "tag.read",
      "workflow.execute",
      "workflow.read",
      "workflow.write",
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
        createIntegrationProvider({ secrets, configuration });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(sentinel);
    }
  });
});
