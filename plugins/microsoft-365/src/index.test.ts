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

const validConfiguration = {
  clientId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
} as const;

describe("Microsoft 365 plugin factory", () => {
  it("constructs the manifest provider through the standard factory contract", () => {
    const provider = createIntegrationProvider({
      secrets,
      configuration: Object.assign(Object.create(null), validConfiguration),
    });

    expect(provider.id).toBe(manifest.provider);
    expect(provider.tools.map(({ name }) => name).toSorted()).toEqual(
      manifest.tools.map(({ name }) => name).toSorted(),
    );
    expect(
      provider.tools.map(({ name, readOnly }) => ({
        name,
        effect: readOnly ? "read" : "write",
      })),
    ).toEqual(manifest.tools.map(({ name, effect }) => ({ name, effect })));
  });

  it("rejects non-plain, incomplete, extra, and non-string configuration without disclosure", () => {
    const inherited = Object.create(validConfiguration) as Record<string, unknown>;
    const sentinel = "do-not-disclose-fixture-value";
    for (const configuration of [
      null,
      [],
      inherited,
      {},
      { clientId: validConfiguration.clientId },
      { ...validConfiguration, extra: sentinel },
      { ...validConfiguration, tenantId: 42 },
      { ...validConfiguration, clientId: sentinel },
      {
        ...validConfiguration,
        clientId: "11111111-1111-0111-0111-111111111111",
      },
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
