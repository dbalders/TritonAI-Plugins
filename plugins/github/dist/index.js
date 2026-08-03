export { GITHUB_PROVIDER_ID, GITHUB_SECRET_SUFFIX, GITHUB_TOOLS, GitHubProvider, } from "./GitHubProvider.js";
import { GitHubProvider } from "./GitHubProvider.js";
export { IntegrationProviderPublicError } from "./host-contract.js";
export { default as manifest } from "../.tritonai-plugin/plugin.json" with { type: "json" };
function configuration(value) {
    if (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error("GitHub configuration must be a plain object.");
    }
    const record = value;
    if (Object.keys(record).toSorted().join(",") !== "clientId" ||
        typeof record.clientId !== "string") {
        throw new Error("GitHub configuration must contain exactly one public clientId string.");
    }
    return { clientId: record.clientId };
}
export function createIntegrationProvider({ secrets, configuration: input, }) {
    return new GitHubProvider(secrets, configuration(input));
}
