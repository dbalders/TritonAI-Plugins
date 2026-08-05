import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { IntegrationSecretStore } from "./host-contract.ts";
import { createIntegrationProvider, manifest } from "./index.ts";

const secrets: IntegrationSecretStore = {
  get: () => Effect.succeed(Option.none()),
  set: () => Effect.void,
  remove: () => Effect.void,
};
const validConfiguration = { clientId: "Ov23li1234567890abcd" } as const;

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
      provider.tools
        .map(({ name, readOnly }) => ({ name, effect: readOnly ? "read" : "write" }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    ).toEqual(
      manifest.tools
        .map(({ name, effect }) => ({ name, effect }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    );
    expect(
      provider.tools.map(({ input }) => Schema.toJsonSchemaDocument(input).schema.type),
    ).toEqual(provider.tools.map(() => "object"));
    expect(manifest.capabilities.map(({ id, access }) => ({ id, access }))).toEqual([
      { id: "identity.read", access: "default" },
      { id: "repository.read", access: "default" },
      { id: "repository.write", access: "default" },
      { id: "issues.write", access: "default" },
      { id: "pull-requests.write", access: "default" },
    ]);
    expect(
      provider.tools.find(({ name }) => name === "github.repositories.count")?.description,
    ).toContain("do not narrate");
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
