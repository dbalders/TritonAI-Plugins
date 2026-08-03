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
const validConfiguration = { clientId: "Iv1.1234567890abcdef" } as const;

describe("GitHub plugin factory", () => {
  it("constructs the exact manifest provider and effect surface", () => {
    const provider = createIntegrationProvider({
      secrets,
      configuration: Object.assign(Object.create(null), validConfiguration),
    });
    expect(provider.id).toBe(manifest.provider);
    expect(provider.tools.map(({ name }) => name).toSorted()).toEqual(
      manifest.tools.map(({ name }) => name).toSorted(),
    );
    expect(
      provider.tools.map(({ name, readOnly }) => ({ name, effect: readOnly ? "read" : "write" })),
    ).toEqual(manifest.tools.map(({ name, effect }) => ({ name, effect })));
  });

  it("accepts only an exact public clientId configuration without disclosing values", () => {
    const sentinel = "do-not-disclose-client-fixture";
    const inherited = Object.create(validConfiguration) as Record<string, unknown>;
    for (const configuration of [
      null,
      [],
      inherited,
      {},
      { clientId: 42 },
      { ...validConfiguration, extra: sentinel },
      { clientId: sentinel },
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
