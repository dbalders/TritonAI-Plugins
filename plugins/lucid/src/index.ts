import type {
  CreateIntegrationProvider,
  IntegrationProvider,
  JsonObject,
} from "@tritonai/plugin-sdk";

import { LUCID_ORIGIN, LUCID_POLICY } from "./lucid-tools.js";
import { RemoteMcpProvider } from "./remote-mcp/RemoteMcpProvider.js";

function configuration(value: JsonObject): void {
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).toSorted().join(",") !== "serverOrigin" ||
    value.serverOrigin !== LUCID_ORIGIN
  ) {
    throw new Error("Lucid configuration must contain only the reviewed server origin.");
  }
}

export const createIntegrationProvider: CreateIntegrationProvider = ({
  secrets,
  configuration: input,
}) => {
  configuration(input);
  return new RemoteMcpProvider(LUCID_POLICY, secrets) as unknown as IntegrationProvider;
};
