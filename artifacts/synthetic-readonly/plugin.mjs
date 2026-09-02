const TOPICS = new Set(["alpha", "beta"]);

function failure(code, message) {
  return Object.freeze({
    _tag: "PluginFailure",
    code,
    message,
    retryable: false,
  });
}

function inputRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw failure("invalid_input", "Input must be a plain object.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "limit" && key !== "topic")) {
    throw failure("invalid_input", "Input contains an unsupported field.");
  }
  if (!TOPICS.has(value.topic)) {
    throw failure("invalid_input", "topic must be alpha or beta.");
  }
  const limit = Object.hasOwn(value, "limit") ? value.limit : 3;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw failure("invalid_input", "limit must be an integer from 1 through 10.");
  }
  return { limit, topic: value.topic };
}

export function createIntegrationProvider() {
  return {
    id: "synthetic-readonly",
    async status({ signal }) {
      signal.throwIfAborted();
      return {
        state: "connected",
        accountLabel: "local synthetic data",
        grantedCapabilities: ["synthetic.read"],
        message: null,
      };
    },
    async invoke(toolName, input, context) {
      context.signal.throwIfAborted();
      if (toolName !== "synthetic.records.list") {
        throw failure("tool_not_found", "The requested tool is not provided by this plugin.");
      }
      const { limit, topic } = inputRecord(input);
      return {
        records: Array.from({ length: limit }, (_, index) => ({
          id: `${topic}-${index + 1}`,
          topic,
        })),
      };
    },
  };
}
