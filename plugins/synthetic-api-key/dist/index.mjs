function failure(code, message) {
  return Object.freeze({ _tag: "PluginFailure", code, message, retryable: false });
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => "value" in entry);
}
export function createIntegrationProvider(context) {
  if (!record(context) || Object.keys(context).some((key) => !["broker", "configuration"].includes(key)) ||
    !record(context.broker) || Object.keys(context.broker).some((key) => key !== "request") ||
    typeof context.broker.request !== "function" || !record(context.configuration) || Object.keys(context.configuration).length > 0) {
    throw failure("invalid_context", "SDK2 requires only the host operation broker and empty configuration.");
  }
  let closed = false;
  return {
    id: "synthetic-api-key",
    async invoke(toolName, input, { signal }) {
      if (closed) throw failure("provider_closed", "Provider closed.");
      signal.throwIfAborted();
      const allowed = toolName === "synthetic.items.list" ? [] : toolName === "synthetic.items.put" ? ["id", "value"] : null;
      if (allowed === null) throw failure("tool_not_found", "Unknown synthetic tool.");
      if (!record(input) || Object.keys(input).some((key) => !allowed.includes(key)) ||
        (toolName === "synthetic.items.put" && (typeof input.id !== "string" || input.id.length < 1 || input.id.length > 32 || typeof input.value !== "string" || input.value.length > 128))) {
        throw failure("invalid_input", "Input is outside the declared tool schema.");
      }
      const result = await context.broker.request(`${toolName}.v1`, input);
      signal.throwIfAborted();
      return result;
    },
    async close() { closed = true; },
  };
}
