export { GOOGLE_WORKSPACE_PROVIDER_ID, GOOGLE_WORKSPACE_SECRET_SUFFIX, GOOGLE_WORKSPACE_TOOLS, GoogleWorkspaceProvider, } from "./GoogleWorkspaceProvider.js";
import { GoogleWorkspaceProvider } from "./GoogleWorkspaceProvider.js";
export { IntegrationProviderPublicError } from "./host-contract.js";
export { default as manifest } from "../.tritonai-plugin/plugin.json" with { type: "json" };
function configuration(value) {
    if (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error("Google Workspace configuration must be a plain object.");
    }
    const record = value;
    if (Object.keys(record).toSorted().join(",") !== "clientId,clientSecret" ||
        typeof record.clientId !== "string" ||
        typeof record.clientSecret !== "string") {
        throw new Error("Google Workspace configuration must contain exactly clientId and clientSecret strings.");
    }
    return { clientId: record.clientId, clientSecret: record.clientSecret };
}
export function createIntegrationProvider({ secrets, configuration: input, }) {
    return new GoogleWorkspaceProvider(secrets, configuration(input));
}
