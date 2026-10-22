import { describe, expect, it } from "vite-plus/test";
import { createIntegrationProvider } from "./index.js";
import { pluginManifest } from "./manifest.js";

const context = () => ({
  signal: new AbortController().signal,
  writeApproved: false,
  beginCommit: async () => {
    throw new Error("A public read must not cross the write boundary.");
  },
});
const secrets = {
  get: async () => {
    throw new Error("Public tools must not read secrets.");
  },
  set: async () => {
    throw new Error("Public tools must not write secrets.");
  },
  remove: async () => {
    throw new Error("Public tools must not remove secrets.");
  },
};

describe("UCSD Assistant plugin", () => {
  it("works without sign-in, stored credentials or a connection lifecycle", async () => {
    const provider = createIntegrationProvider({ secrets, configuration: {} });
    await expect(provider.status(context())).resolves.toMatchObject({
      state: "connected",
      grantedCapabilities: ["read"],
      accountLabel: "Public UCSD sources",
    });
    expect(provider.connect).toBeUndefined();
    expect(provider.disconnect).toBeUndefined();
    expect(pluginManifest.capabilities.every((c) => c.access === "default")).toBe(true);
    await expect(
      provider.invoke("ucsd.list_sources", { filter: "Admissions" }, context()),
    ).resolves.toMatchObject({ sourceCount: 71 });
  });

  it("distinguishes anonymous REST routes from unsupported parking and authenticated MCPs", async () => {
    const provider = createIntegrationProvider({ secrets, configuration: {} });
    const result = await provider.invoke("ucsd.list_services", {}, context());
    expect(result).toMatchObject({
      services: expect.arrayContaining([
        expect.objectContaining({ id: "campus-busyness", status: "anonymous_verified" }),
        expect.objectContaining({ id: "parking", status: "live_anonymous_unverified" }),
      ]),
    });
    await expect(
      provider.invoke("campus_busyness-GetCampusBusyness", {}, context()),
    ).rejects.toMatchObject({ code: "tool_not_found" });
    await expect(
      provider.invoke("ucsd.get_campus_busyness", { token: "forbidden" }, context()),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      provider.invoke("ucsd.search_map_buildings", { query: "Geisel", where: "1=1" }, context()),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects configuration and unknown input fields locally", async () => {
    expect(() =>
      createIntegrationProvider({
        secrets,
        configuration: { serverOrigin: "https://tritongpt-stage.ucsd.edu" },
      }),
    ).toThrow();
    const provider = createIntegrationProvider({ secrets, configuration: {} });
    await expect(
      provider.invoke("ucsd.list_services", { token: "untrusted" }, context()),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      provider.invoke("ucsd.read_page", { url: "https://blink.ucsd.edu/", headers: {} }, context()),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("stops public operations on cancellation", async () => {
    const provider = createIntegrationProvider({ secrets, configuration: {} });
    const operation = context();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.invoke("ucsd.list_sources", {}, { ...operation, signal: controller.signal }),
    ).rejects.toBeTruthy();
  });
});
