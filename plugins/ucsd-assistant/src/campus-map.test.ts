import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CAMPUS_MAP_TOOLS, invokeCampusMapTool, isCampusMapTool } from "./campus-map.ts";
import routeMetadata from "./fixtures/campus-map/route-metadata.json" with { type: "json" };

const fetchMock = vi.fn<typeof fetch>();
const from = { longitude: -117.2376196739352, latitude: 32.8814788468894 };
const to = { longitude: -117.2375030000456, latitude: 32.8792690004391 };
const signal = () => new AbortController().signal;
const invoke = (name: string, input: unknown) =>
  invokeCampusMapTool(`ucsd.${name}`, input, signal());
const feature = {
  attributes: {
    OBJECTID: 453,
    UpdatedName: "Geisel Library",
    Class: "Libraries",
    Subclass: "Library",
    FacilityLongName: "Geisel Library",
    ClassroomCodes: null,
    URL: "https://library.ucsd.edu/",
  },
  geometry: { x: from.longitude, y: from.latitude },
};
function reply(body: unknown, init: ResponseInit = {}) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", date: "Thu, 22 Oct 2026 20:10:25 GMT" },
      ...init,
    }),
  );
}
function request(index = 0) {
  const call = fetchMock.mock.calls[index]!;
  return { url: new URL(String(call[0])), options: call[1]! };
}
function routeReply() {
  return {
    routes: {
      spatialReference: { wkid: 4326 },
      features: [
        {
          attributes: {
            Total_Length: 976.6768165055435,
            Total_WalkingMinutes: 4.883312073501409,
            Shape_Length: 0.0028,
          },
          geometry: {
            paths: [
              [
                [from.longitude, from.latitude],
                [to.longitude, to.latitude],
              ],
            ],
          },
        },
      ],
    },
    stops: {
      spatialReference: { wkid: 4326 },
      features: [from, to].map((p, i) => ({
        attributes: { Sequence: i + 1, Status: i === 0 ? 7 : 0, DistanceToNetworkInMeters: 5 },
        geometry: { x: p.longitude, y: p.latitude },
      })),
    },
    directions: [
      {
        features: [
          {
            attributes: {
              length: 0,
              time: 0,
              text: "Start at Geisel Library",
              maneuverType: "esriDMTDepart",
              ETA: -2209161600000,
              arriveTimeUTC: -2209161600000,
            },
          },
        ],
      },
    ],
    messages: [
      {
        type: 50,
        code: -2147200756,
        description:
          "Network elements with avoid-restrictions are traversed in the output (WalkingLowPriority).",
      },
    ],
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("public campus map contracts", () => {
  it("exposes exactly six read-only tools with strict schemas", () => {
    expect(CAMPUS_MAP_TOOLS).toHaveLength(6);
    expect(new Set(CAMPUS_MAP_TOOLS.map((tool) => tool.name)).size).toBe(6);
    for (const tool of CAMPUS_MAP_TOOLS) {
      expect(isCampusMapTool(tool.name)).toBe(true);
      expect(tool).toMatchObject({
        capabilities: ["read"],
        effect: "read",
        destructive: false,
        inputSchema: { additionalProperties: false },
      });
    }
    expect(isCampusMapTool("ucsd.map_arbitrary_url")).toBe(false);
  });

  it("searches whitelisted building fields and escapes SQL string literals", async () => {
    reply({
      features: [
        {
          attributes: {
            OBJECTID: 1814,
            FacilityLongName: "Geisel Library",
            BuildingAliases: "Library - Geisel",
            StreetAddress: "9701 Hopkins Drive",
          },
          geometry: feature.geometry,
        },
      ],
    });
    const result = await invoke("search_map_buildings", { query: "O'Brien' OR 1=1 --", limit: 3 });
    const { url, options } = request();
    expect(url.origin + url.pathname).toBe(
      "https://admin-enterprise-gis.ucsd.edu/SERVER/rest/services/AdministrationServices/Buildings_Public/MapServer/0/query",
    );
    expect(url.searchParams.get("where")).toBe(
      "(UPPER(FacilityLongName) LIKE '%O''BRIEN'' OR 1=1 --%' OR UPPER(BuildingAliases) LIKE '%O''BRIEN'' OR 1=1 --%')",
    );
    expect(url.searchParams.get("resultRecordCount")).toBe("3");
    expect(options).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    expect(new Headers(options.headers).has("cookie")).toBe(false);
    expect(result.results).toEqual([
      {
        id: 1814,
        name: "Geisel Library",
        point: from,
        aliases: "Library - Geisel",
        streetAddress: "9701 Hopkins Drive",
      },
    ]);
    expect(result.source).toMatchObject({
      sourceObservationAt: null,
      httpDate: "Thu, 22 Oct 2026 20:10:25 GMT",
    });
  });

  it("filters POIs by exact safely quoted classes and discloses truncation", async () => {
    reply({ features: [feature], exceededTransferLimit: true });
    const result = await invoke("search_map_pois", { query: "Geisel", class: "Student's Life" });
    expect(request().url.searchParams.get("where")).toBe(
      "(UPPER(UpdatedName) LIKE '%GEISEL%') AND (Class='Student''s Life')",
    );
    expect(result).toMatchObject({
      truncated: true,
      results: [{ id: 453, class: "Libraries", point: from }],
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("preserves distinct class spelling variants and handles empty results", async () => {
    reply({
      features: ["Libraries", "Library", "Libraries", null].map((Class) => ({
        attributes: { Class },
      })),
    });
    expect(await invoke("list_map_poi_classes", {})).toMatchObject({
      classes: ["Libraries", "Library"],
      truncated: false,
    });
    expect(request().url.searchParams.get("returnDistinctValues")).toBe("true");
    expect(request().url.searchParams.get("resultRecordCount")).toBe("100");
    reply({ features: [] });
    expect(await invoke("search_map_pois", { query: "not a place" })).toMatchObject({
      results: [],
      truncated: false,
    });
  });

  it.each([
    [1500, "feet", "esriSRUnit_Foot"],
    [400, "meters", "esriSRUnit_Meter"],
  ])(
    "sends a bounded nearby radius of %s %s without claiming nearest order",
    async (radius, unit, apiUnit) => {
      reply({ features: [feature] });
      const result = await invoke("nearby_map_pois", {
        point: from,
        radius,
        unit,
        class: "Libraries",
        limit: 1,
      });
      const params = request().url.searchParams;
      expect(params.get("geometry")).toBe(`${from.longitude},${from.latitude}`);
      expect(params.get("units")).toBe(apiUnit);
      expect(params.get("distance")).toBe(String(radius));
      expect(params.get("inSR")).toBe("4326");
      expect(result).toMatchObject({ radius, unit, truncated: true });
      expect(result.ordering).toContain("no relevance or nearest-first guarantee");
    },
  );

  it.each(["meters", "feet"])(
    "reports explicitly selected %s for direct geodesic distance",
    async (unit) => {
      reply({ distance: 245.3202063622164 });
      const result = await invoke("map_distance", { from, to, unit });
      expect(request().url.origin).toBe("https://utility.arcgisonline.com");
      expect(request().url.searchParams.get("distanceUnit")).toBe("9001");
      expect(request().url.searchParams.get("geodesic")).toBe("true");
      expect(JSON.parse(request().url.searchParams.get("geometry1")!)).toEqual({
        geometryType: "esriGeometryPoint",
        geometry: { x: from.longitude, y: from.latitude },
      });
      expect(result.distance).toBeCloseTo(245.3202063622164 / (unit === "feet" ? 0.3048 : 1), 10);
      expect(result.meaning).toContain("not walking");
    },
  );

  it("keeps the exact public metadata fixture tied to its research receipt", () => {
    const bytes = readFileSync(
      new URL("./fixtures/campus-map/route-metadata.json", import.meta.url),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "55206f895dd0219e485fc96472c702aa77116e557580f98f8ad326f2498cdaf9",
    );
  });

  it.each(["walking", "ada"])(
    "submits the full advertised %s mode and retains warnings and network age",
    async (mode) => {
      reply(routeMetadata);
      reply(routeReply());
      const result = await invoke("map_walking_route", { from, to, mode });
      expect(request().url.pathname.endsWith("/Route")).toBe(true);
      const params = request(1).url.searchParams;
      const expected = routeMetadata.supportedTravelModes.find(
        (item) => item.name === (mode === "ada" ? "ADA" : "Walking"),
      );
      expect(JSON.parse(params.get("travelMode")!)).toEqual(expected);
      expect(params.get("ignoreInvalidLocations")).toBe("false");
      expect(params.get("directionsLengthUnits")).toBe("esriNAUFeet");
      expect(result).toMatchObject({
        mode,
        networkBuildAt: "2026-10-08T17:32:21.000Z",
        lengthFeet: 976.6768165055435,
        modeledMinutes: 4.883312073501409,
        maximumSnapDistanceMeters: 50,
        stops: [{ relocatedToTraversableFeature: true }, { relocatedToTraversableFeature: false }],
        messages: [{ code: -2147200756 }],
      });
      expect(result.networkBuildAt).not.toBe(
        (result.source as { retrievedAt: string }).retrievedAt,
      );
      expect(JSON.stringify(result)).not.toMatch(
        /arriveTimeUTC|"ETA"|Shape_Length|compressedGeometry/,
      );
    },
  );

  it.each([
    { lengths: [1024], geometryOmitted: false },
    { lengths: [1025], geometryOmitted: true },
    { lengths: [1024, 976], geometryOmitted: false },
  ])(
    "preserves route details with path lengths $lengths (geometryOmitted: $geometryOmitted)",
    async ({ lengths, geometryOmitted }) => {
      const body = routeReply();
      const paths = lengths.map((length) =>
        Array.from({ length }, (_, index) => [
          from.longitude + (to.longitude - from.longitude) * (index / (length - 1)),
          from.latitude + (to.latitude - from.latitude) * (index / (length - 1)),
        ]),
      );
      body.routes.features[0]!.geometry.paths = paths;
      reply(routeMetadata);
      reply(body);
      const result = await invoke("map_walking_route", { from, to, mode: "walking" });
      expect(result.paths).toEqual(geometryOmitted ? null : paths);
      expect(result).toMatchObject({
        geometryOmitted,
        from,
        to,
        mode: "walking",
        advertisedTravelMode: { name: "Walking", itemId: "1" },
        networkBuildAt: "2026-10-08T17:32:21.000Z",
        lengthFeet: 976.6768165055435,
        modeledMinutes: 4.883312073501409,
        stops: [
          { sequence: 1, point: from, status: 7, distanceToNetworkMeters: 5 },
          { sequence: 2, point: to, status: 0, distanceToNetworkMeters: 5 },
        ],
        directions: [
          {
            text: "Start at Geisel Library",
            lengthFeet: 0,
            modeledMinutes: 0,
            maneuverType: "esriDMTDepart",
          },
        ],
        directionsTruncated: false,
        messages: [{ code: -2147200756 }],
        messagesTruncated: false,
        source: { httpDate: "Thu, 22 Oct 2026 20:10:25 GMT" },
        metadataSource: { httpDate: "Thu, 22 Oct 2026 20:10:25 GMT" },
      });
      expect(result.directions).toHaveLength(body.directions[0]!.features.length);
      expect(result.stops).toHaveLength(body.stops.features.length);
    },
  );

  it("omits geometry above 2000 total points and bounds direction output explicitly", async () => {
    const body = routeReply();
    body.routes.features[0]!.geometry.paths = [1024, 977].map((length) =>
      Array.from({ length }, () => [from.longitude, from.latitude]),
    );
    body.directions[0]!.features = Array.from(
      { length: 101 },
      () => body.directions[0]!.features[0]!,
    );
    reply(routeMetadata);
    reply(body);
    expect(await invoke("map_walking_route", { from, to, mode: "walking" })).toMatchObject({
      paths: null,
      geometryOmitted: true,
      directionsTruncated: true,
    });
  });
});

describe("runtime validation and public transport failures", () => {
  it.each([
    ["search_map_buildings", { query: "%" }],
    ["search_map_pois", { query: "A_B" }],
    ["search_map_buildings", { query: "Geisel", where: "1=1" }],
    ["search_map_buildings", { query: " ", limit: 2 }],
    ["search_map_buildings", { query: "a\n" }],
    ["search_map_pois", { query: "Geisel", limit: 26 }],
    ["search_map_pois", { query: "Geisel", limit: "8" }],
    ["search_map_pois", { query: "Geisel", class: [] }],
    ["list_map_poi_classes", { token: "secret" }],
    ["map_distance", { from: { ...from, latitude: NaN }, to, unit: "meters" }],
    ["map_distance", { from: { ...from, longitude: -181 }, to, unit: "feet" }],
    ["map_distance", { from: { ...from, extra: true }, to, unit: "meters" }],
    ["map_distance", { from, to, unit: "miles" }],
    ["map_walking_route", { from, to, mode: "driving" }],
    ["nearby_map_pois", { point: from, radius: 5001, unit: "meters" }],
    ["nearby_map_pois", { point: from, radius: Infinity, unit: "feet" }],
    ["nearby_map_pois", { point: from, radius: 0, unit: "feet" }],
    ["list_map_poi_classes", []],
    ["list_map_poi_classes", null],
  ])("rejects bypassed invalid %s input before networking (%j)", async (name, input) => {
    await expect(invoke(name as string, input)).rejects.toMatchObject({
      _tag: "PluginFailure",
      code: "invalid_input",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, {}, "application/json"],
    [403, {}, "application/json"],
    [302, {}, "application/json"],
    [200, { error: { code: 499, message: "Token required" } }, "application/json"],
    [200, { error: { code: 400, details: ["private failure detail"] } }, "application/json"],
    [200, { features: [] }, "text/html"],
    [200, { wrong: [] }, "application/json"],
    [200, { features: [], exceededTransferLimit: "true" }, "application/json"],
  ])("fails closed for HTTP/source/shape errors (%s %j)", async (status, body, type) => {
    reply(body, { status: status as number, headers: { "content-type": type as string } });
    await expect(invoke("search_map_buildings", { query: "Geisel" })).rejects.toMatchObject({
      code: "source_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow redirects or expose underlying network details", async () => {
    fetchMock.mockRejectedValueOnce(
      new Error("redirect to private credential-bearing destination"),
    );
    await expect(invoke("list_map_poi_classes", {})).rejects.toMatchObject({
      code: "source_unavailable",
      message: expect.not.stringContaining("credential-bearing"),
    });
    expect(request().options.redirect).toBe("error");
  });

  it.each(["invalid JSON", JSON.stringify({ features: [feature, feature] })])(
    "rejects bad JSON or results exceeding the requested limit",
    async (body) => {
      fetchMock.mockResolvedValueOnce(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
      await expect(invoke("search_map_pois", { query: "Geisel", limit: 1 })).rejects.toMatchObject({
        code: "source_unavailable",
      });
    },
  );

  it.each(["header", "stream"])("bounds downloads through the %s", async (kind) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        headers: {
          "content-type": "application/json",
          ...(kind === "header" ? { "content-length": String(1024 * 1024 + 1) } : {}),
        },
      }),
    );
    await expect(invoke("list_map_poi_classes", {})).rejects.toMatchObject({
      code: "source_unavailable",
      message: expect.stringContaining("1 MiB"),
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels before networking when the host signal is already aborted", async () => {
    await expect(
      invokeCampusMapTool("ucsd.list_map_poi_classes", {}, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["fetch", "body"])(
    "enforces timeout during %s and aborts the transport",
    async (phase) => {
      vi.useFakeTimers();
      if (phase === "fetch") fetchMock.mockImplementationOnce(() => new Promise(() => {}));
      else
        fetchMock.mockResolvedValueOnce(
          new Response(new ReadableStream<Uint8Array>({}), {
            headers: { "content-type": "application/json" },
          }),
        );
      const pending = expect(invoke("list_map_poi_classes", {})).rejects.toMatchObject({
        code: "cancelled",
      });
      await vi.advanceTimersByTimeAsync(20_001);
      await pending;
      expect(request().options.signal?.aborted).toBe(true);
    },
  );

  it("honors host cancellation while downloading", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({}), {
        headers: { "content-type": "application/json" },
      }),
    );
    const pending = expect(
      invokeCampusMapTool("ucsd.list_map_poi_classes", {}, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    controller.abort();
    await pending;
  });

  it.each(["mode", "units", "empty route", "stop status", "snap distance", "coordinate system"])(
    "rejects unsafe routing changes: %s",
    async (kind) => {
      const metadata = structuredClone(routeMetadata),
        body = routeReply();
      if (kind === "mode")
        metadata.supportedTravelModes = metadata.supportedTravelModes.filter(
          (item) => item.name !== "ADA",
        );
      if (kind === "units") metadata.networkDataset.networkAttributes[1]!.units = "esriNAUMeters";
      if (kind === "empty route") body.routes.features = [];
      if (kind === "stop status") body.stops.features[0]!.attributes.Status = 1;
      if (kind === "snap distance")
        body.stops.features[0]!.attributes.DistanceToNetworkInMeters = 51;
      if (kind === "coordinate system") body.routes.spatialReference.wkid = 2230;
      reply(metadata);
      reply(body);
      await expect(invoke("map_walking_route", { from, to, mode: "ada" })).rejects.toMatchObject({
        code: "source_unavailable",
      });
    },
  );
});
