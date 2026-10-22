import { pluginFailure, type CreateIntegrationProvider } from "@tritonai/plugin-sdk";

import { listSources, plainInput, planSearch } from "./catalog.js";
import { getCampusBusyness } from "./campus-busyness.js";
import { isCampusMapTool, invokeCampusMapTool } from "./campus-map.js";
import { searchPublicKnowledge, type PublicKnowledgeInput } from "./public-kb.js";
import { readPublicPage } from "./public-web.js";
import { CAMPUS_CONNECTIONS } from "./services.js";

export const createIntegrationProvider: CreateIntegrationProvider = ({ configuration }) => {
  plainInput(configuration, []);
  return {
    id: "ucsd-assistant",
    async status({ signal }) {
      signal.throwIfAborted();
      return {
        state: "connected",
        accountLabel: "Public UCSD sources",
        grantedCapabilities: ["read"],
        message: "Public read-only access. Campus service availability is checked when called.",
      };
    },
    async invoke(name, input, { signal }) {
      signal.throwIfAborted();
      if (isCampusMapTool(name)) return await invokeCampusMapTool(name, input, signal);
      if (name === "ucsd.get_campus_busyness") return await getCampusBusyness(input, signal);
      if (name === "ucsd.search_public_kb")
        return await searchPublicKnowledge(input as unknown as PublicKnowledgeInput, signal);
      if (name === "ucsd.list_sources") return listSources(input);
      if (name === "ucsd.plan_search") return planSearch(input);
      if (name === "ucsd.list_services") {
        plainInput(input, []);
        return {
          services: CAMPUS_CONNECTIONS,
          checkedAt: "2026-10-22",
          note: "This is a verified service-route inventory, not a current occupancy reading or an availability probe. Public tools use direct anonymous APIs; authenticated gateway MCPs are not dispatched.",
        };
      }
      if (name === "ucsd.read_page") {
        plainInput(input, ["url"]);
        if (typeof input.url !== "string" || input.url.length > 4096 || !input.url)
          throw pluginFailure("invalid_input", "url must contain 1–4,096 characters.");
        return await readPublicPage(input.url, signal);
      }
      throw pluginFailure(
        "tool_not_found",
        "The requested tool is not provided by UCSD Assistant.",
      );
    },
  };
};
