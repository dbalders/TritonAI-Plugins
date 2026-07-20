export const HARNESS_INTEGRATION_API_VERSION = "tritonai.harness/v2";

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const MAX_ID_LENGTH = 64;
const TOOL = /^[a-z][a-z0-9_.-]*$/u;
const MAX_TOOL_NAME_LENGTH = 128;
const SKILL = /^[a-z][a-z0-9-]{0,63}$/u;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MANIFEST_KEYS = new Set([
  "apiVersion",
  "kind",
  "manifestVersion",
  "id",
  "name",
  "description",
  "version",
  "provider",
  "capabilities",
  "tools",
  "skills",
]);
const CAPABILITY_KEYS = new Set(["id", "displayName", "description", "access"]);
const TOOL_KEYS = new Set(["name", "displayName", "description", "capabilities", "effect"]);
const SKILL_KEYS = new Set(["name", "description", "capabilities"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parsedVersion(value) {
  const match = VERSION.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier))) {
    return null;
  }
  return { major: match[1], minor: match[2], patch: match[3], prerelease };
}

export function validateManifestV2(value) {
  assert(isRecord(value), "Integration manifest must be an object.");
  assert(hasOnlyKeys(value, MANIFEST_KEYS), "Integration manifest contains unsupported fields.");
  assert(
    value.apiVersion === HARNESS_INTEGRATION_API_VERSION,
    `Unsupported integration apiVersion ${String(value.apiVersion)}.`,
  );
  assert(
    value.kind === "IntegrationPlugin" && value.manifestVersion === 2,
    "Integration manifest kind or manifestVersion is unsupported.",
  );
  for (const field of ["id", "name", "description", "version"]) {
    assert(nonEmpty(value[field]), `Integration manifest ${field} is required.`);
  }
  assert(
    value.id.length <= MAX_ID_LENGTH && ID.test(value.id),
    "Integration identifiers must use lowercase stable slugs.",
  );
  assert(
    value.provider === undefined ||
      (typeof value.provider === "string" &&
        value.provider.length <= MAX_ID_LENGTH &&
        ID.test(value.provider)),
    "Integration provider identifiers must use lowercase stable slugs.",
  );
  assert(parsedVersion(value.version), "Integration version must be semver.");
  assert(
    Array.isArray(value.capabilities) && Array.isArray(value.tools) && Array.isArray(value.skills),
    "Integration capabilities, tools, and skills must be arrays.",
  );
  assert(
    value.tools.length > 0 === (value.provider !== undefined),
    "Integration plugins must declare a provider exactly when they declare tools.",
  );
  const capabilityIds = new Set();
  for (const capability of value.capabilities) {
    assert(
      isRecord(capability) && hasOnlyKeys(capability, CAPABILITY_KEYS),
      "Invalid or unsupported capability fields.",
    );
    assert(
      nonEmpty(capability.id) &&
        capability.id.length <= MAX_ID_LENGTH &&
        ID.test(capability.id) &&
        nonEmpty(capability.displayName) &&
        nonEmpty(capability.description) &&
        (capability.access === "default" || capability.access === "opt-in"),
      "Every capability requires a unique id, displayName, description, and explicit access value.",
    );
    assert(!capabilityIds.has(capability.id), `Duplicate capability ${capability.id}.`);
    capabilityIds.add(capability.id);
  }
  for (const [kind, entries] of [
    ["tool", value.tools],
    ["skill", value.skills],
  ]) {
    const names = new Set();
    for (const entry of entries) {
      const allowed = kind === "tool" ? TOOL_KEYS : SKILL_KEYS;
      assert(
        isRecord(entry) && hasOnlyKeys(entry, allowed),
        `Invalid or unsupported ${kind} fields.`,
      );
      assert(
        typeof entry.name === "string" &&
          (kind === "skill"
            ? SKILL.test(entry.name)
            : entry.name.length <= MAX_TOOL_NAME_LENGTH && TOOL.test(entry.name)) &&
          nonEmpty(entry.description),
        `Every ${kind} requires a stable name and description.`,
      );
      assert(kind !== "tool" || nonEmpty(entry.displayName), "Every tool requires a displayName.");
      const references = entry.capabilities;
      assert(
        Array.isArray(references) &&
          references.length > 0 &&
          references.every((capability) => nonEmpty(capability) && capabilityIds.has(capability)) &&
          new Set(references).size === references.length,
        `${kind} ${entry.name} references an unknown capability.`,
      );
      assert(
        kind !== "tool" || entry.effect === "read" || entry.effect === "write",
        `Tool ${entry.name} has an invalid effect.`,
      );
      assert(!names.has(entry.name), `Duplicate ${kind} name ${entry.name}.`);
      names.add(entry.name);
    }
  }
  return value;
}
