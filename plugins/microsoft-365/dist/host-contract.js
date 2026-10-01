export class IntegrationProviderPublicError extends Error {
    _tag = "IntegrationProviderPublicError";
    /**
     * The external service definitively refused the operation, so nothing changed. Harness settles
     * an admitted commit rejected this way instead of faulting the provider; older Harness builds
     * ignore it.
     */
    unchanged;
    constructor(message, options) {
        super(message.trim() || "Integration provider operation failed.");
        this.name = "IntegrationProviderPublicError";
        this.unchanged = options?.unchanged === true;
    }
}
