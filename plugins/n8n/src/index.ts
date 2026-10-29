import type {
  CreateIntegrationProvider,
  IntegrationProvider,
  JsonObject,
} from "@tritonai/plugin-sdk";

import { N8nEnvironmentProvider } from "./N8nEnvironmentProvider.js";

const SERVER_URL = "https://n8n.tritonai.ucsd.edu/mcp-server/http";

function configuration(value: JsonObject): { readonly serverUrl: string } {
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).toSorted().join(",") !== "serverUrl" ||
    value.serverUrl !== SERVER_URL
  ) {
    throw new Error("n8n configuration must contain only the reviewed server URL.");
  }
  return { serverUrl: value.serverUrl };
}

export const createIntegrationProvider: CreateIntegrationProvider = ({
  secrets,
  configuration: input,
}) => new N8nEnvironmentProvider(secrets, configuration(input)) as unknown as IntegrationProvider;
