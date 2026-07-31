export { MICROSOFT_GRAPH_PROVIDER_ID, MICROSOFT_GRAPH_SECRET_SUFFIX, MICROSOFT_GRAPH_TOOLS, MicrosoftGraphProvider, } from "./MicrosoftGraphProvider.js";
import { MicrosoftGraphProvider } from "./MicrosoftGraphProvider.js";
export { IntegrationProviderPublicError } from "./host-contract.js";
export { default as manifest } from "../.tritonai-plugin/plugin.json" with { type: "json" };
function configuration(value) {
    if (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error("Microsoft 365 configuration must be a plain object.");
    }
    const record = value;
    if (Object.keys(record).toSorted().join(",") !== "clientId,tenantId" ||
        typeof record.clientId !== "string" ||
        typeof record.tenantId !== "string") {
        throw new Error("Microsoft 365 configuration must contain exactly clientId and tenantId strings.");
    }
    return { clientId: record.clientId, tenantId: record.tenantId };
}
export function createIntegrationProvider({ secrets, configuration: input, }) {
    return new MicrosoftGraphProvider(secrets, configuration(input));
}
