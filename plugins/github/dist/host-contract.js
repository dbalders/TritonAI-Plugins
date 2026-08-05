export class IntegrationProviderPublicError extends Error {
    _tag = "IntegrationProviderPublicError";
    constructor(message) {
        super(message.trim() || "Integration provider operation failed.");
        this.name = "IntegrationProviderPublicError";
    }
}
