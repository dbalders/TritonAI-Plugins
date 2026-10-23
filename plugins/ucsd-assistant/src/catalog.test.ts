import { describe, expect, it } from "vite-plus/test";
import type { JsonObject } from "@tritonai/plugin-sdk";

import { listSources, planSearch, SOURCE_CATALOG } from "./catalog.js";
import { checkPublicPageUrl } from "./public-web.js";

describe("public campus source search", () => {
  it("covers every published source category, including distinct categories sharing a site", () => {
    expect(SOURCE_CATALOG).toHaveLength(71);
    expect(new Set(SOURCE_CATALOG.map((s) => s.id)).size).toBe(71);
    expect(SOURCE_CATALOG.some((s) => s.name === "Course Catalog")).toBe(true);
    expect(SOURCE_CATALOG.some((s) => s.name === "UC San Diego General Catalog")).toBe(true);
    for (const source of SOURCE_CATALOG) {
      expect(source.urls.length).toBeGreaterThan(0);
      for (const url of source.urls) expect(checkPublicPageUrl(url)).toBeInstanceOf(URL);
    }
  });

  it("finds a source by name and explicitly reports catalog scope", () => {
    const result = listSources({ filter: "Triton Card" });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].urls).toContain("https://hdhtcas.ucsd.edu/");
    expect(result.scope).toContain("not a copy");
    expect(result.sourceCount).toBe(71);
  });

  it("constructs source-scoped queries without claiming the plan retrieved evidence", () => {
    const result = planSearch({ query: "travel reimbursement", sourceIds: ["blink"] });
    expect(result.searched).toBe(false);
    expect(result.queries).toEqual([
      {
        webQuery: "site:blink.ucsd.edu travel reimbursement",
        publicSearchUrl:
          "https://cse.google.com/cse?cx=15cf43c1c5ee74fee&q=site%3Ablink.ucsd.edu+travel+reimbursement",
      },
    ]);
    expect(result.sources[0].name).toBe("Blink");
    expect(JSON.stringify(result.queries)).not.toContain("tritongpt");
  });

  it("includes the official external source domains in broad campus searches", () => {
    const result = planSearch({ query: "policy" });
    expect(result.sourceCount).toBe(71);
    expect(result.queries.length).toBeLessThan(10);
    expect(result.queries.some((q) => q.webQuery === "site:ucsd.edu policy")).toBe(true);
    expect(result.queries.some((q) => q.webQuery.includes("site:policy.ucop.edu"))).toBe(true);
    const external = result.queries.find((q) => q.webQuery.includes("policy.ucop.edu"));
    expect(external?.publicSearchUrl).toContain("https://www.google.com/search?");
  });

  it("keeps policy portal searches inside the public UCSD path", () => {
    const result = planSearch({ query: "leave", sourceIds: ["policies-uc-san-diego-and-ucop"] });
    expect(
      result.queries.some((q) => q.webQuery.includes("secure4.compliancebridge.com/ucsd/public")),
    ).toBe(true);
    expect(
      checkPublicPageUrl(
        "https://secure4.compliancebridge.com/ucsd/public/index.php?fuseaction=app.main",
      ),
    ).toBeInstanceOf(URL);
    for (const path of [
      "/ucsd/private/index.php",
      "/other/public/index.php",
      "/ucsd/public/%252e%252e/private",
      "/ucsd/public/a%2f..%2fprivate",
    ]) {
      expect(() => checkPublicPageUrl(`https://secure4.compliancebridge.com${path}`)).toThrow();
    }
  });

  const invalidSearchInputs: JsonObject[] = [
    { query: "" },
    { query: "\npolicy" },
    { query: "x".repeat(1001) },
    { query: "policy", sourceIds: [] },
    { query: "policy", sourceIds: ["missing"] },
    { query: "policy", sourceIds: ["blink", "blink"] },
    { query: "policy", url: "https://example.com" },
  ];
  it.each(invalidSearchInputs)(
    "rejects unsupported search inputs before any search is planned",
    (input) => {
      expect(() => planSearch(input)).toThrow();
    },
  );
});
