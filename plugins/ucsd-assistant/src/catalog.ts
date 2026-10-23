import { pluginFailure, type JsonObject } from "@tritonai/plugin-sdk";

import sourceData from "./source-data.json" with { type: "json" };

export type CampusSource = {
  readonly id: string;
  readonly name: string;
  readonly urls: readonly string[];
  readonly searchScopes: readonly string[];
  readonly notes: string;
};

export const SOURCE_GUIDE =
  "https://tritonai.ucsd.edu/training-resources/tritongpt/assistants.html";
export const SOURCE_CATALOG: readonly CampusSource[] = sourceData.sources;
export const CATALOG_VERIFIED_AT = sourceData.verifiedAt;
export const CATALOG_SCOPE =
  "The published UCSD Assistant source categories, mapped to public source sites. This is not a copy or a verified inventory of the deployed Onyx index.";

export function plainInput(
  value: unknown,
  allowedKeys: readonly string[],
): asserts value is JsonObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw pluginFailure("invalid_input", "Input must be a plain object.");
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw pluginFailure("invalid_input", "Input contains an unsupported field.");
  }
}

export function queryText(value: unknown, label = "query"): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    // eslint-disable-next-line no-control-regex -- Search inputs must contain printable text.
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw pluginFailure("invalid_input", `${label} must contain 1–1,000 printable characters.`);
  }
  return value.trim();
}

export function listSources(input: JsonObject) {
  plainInput(input, ["filter"]);
  const filter = input.filter === undefined ? "" : queryText(input.filter, "filter").toLowerCase();
  const sources = SOURCE_CATALOG.filter(
    (source) =>
      !filter ||
      `${source.name} ${source.id} ${source.urls.join(" ")}`.toLowerCase().includes(filter),
  );
  return {
    guide: SOURCE_GUIDE,
    verifiedAt: CATALOG_VERIFIED_AT,
    scope: CATALOG_SCOPE,
    sourceCount: SOURCE_CATALOG.length,
    sources,
  };
}

export function planSearch(input: JsonObject) {
  plainInput(input, ["query", "sourceIds"]);
  const query = queryText(input.query);
  let selected = SOURCE_CATALOG;
  if (input.sourceIds !== undefined) {
    if (
      !Array.isArray(input.sourceIds) ||
      input.sourceIds.length === 0 ||
      input.sourceIds.length > 8 ||
      new Set(input.sourceIds).size !== input.sourceIds.length ||
      input.sourceIds.some(
        (id) => typeof id !== "string" || !SOURCE_CATALOG.some((s) => s.id === id),
      )
    ) {
      throw pluginFailure(
        "invalid_input",
        "sourceIds must select 1–8 distinct IDs from ucsd.list_sources.",
      );
    }
    selected = SOURCE_CATALOG.filter((source) =>
      (input.sourceIds as readonly string[]).includes(source.id),
    );
  }
  const scopes = new Set<string>();
  for (const source of selected) {
    for (const scope of source.searchScopes) {
      const parsed = new URL(`https://${scope}`);
      if (
        input.sourceIds === undefined &&
        (parsed.hostname === "ucsd.edu" || parsed.hostname.endsWith(".ucsd.edu"))
      )
        scopes.add("ucsd.edu");
      else scopes.add(scope);
    }
  }
  const queries = [...scopes].map((scope) => {
    const webQuery = `site:${scope} ${query}`;
    const campusScope =
      scope === "ucsd.edu" || new URL(`https://${scope}`).hostname.endsWith(".ucsd.edu");
    const searchUrl = new URL(
      campusScope ? "https://cse.google.com/cse" : "https://www.google.com/search",
    );
    // This is the public engine embedded by UCSD's campus search. Opening it directly avoids the TritonGPT overview embedded on some campus search pages.
    if (campusScope) searchUrl.searchParams.set("cx", "15cf43c1c5ee74fee");
    searchUrl.searchParams.set("q", webQuery);
    return { webQuery, publicSearchUrl: searchUrl.toString() };
  });
  return {
    kind: "search_plan",
    searched: false,
    query,
    guide: SOURCE_GUIDE,
    verifiedAt: CATALOG_VERIFIED_AT,
    scope: CATALOG_SCOPE,
    sourceCount: selected.length,
    sources: input.sourceIds === undefined ? [] : selected,
    queries,
    instructions:
      "Run these queries with the available web search. If needed, open publicSearchUrl in the browser and read organic search results. Fetch original source pages; this plan contains no search results or evidence. Read queries in small batches, select relevant sources, and stop once the question is supported. Do not use an AI overview as source evidence.",
  };
}
