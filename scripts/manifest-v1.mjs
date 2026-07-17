export const HARNESS_INTEGRATION_API_VERSION = "tritonai.harness/v1";

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
  "compatibility",
  "provider",
  "capabilities",
  "tools",
  "skills",
]);
const CAPABILITY_KEYS = new Set(["id", "displayName", "description", "access"]);
const TOOL_KEYS = new Set([
  "name",
  "displayName",
  "description",
  "capability",
  "capabilities",
  "effect",
]);
const SKILL_KEYS = new Set(["name", "description", "capability", "capabilities"]);

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

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareVersion(left, right) {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  assert(a && b, `Invalid semantic version: ${!a ? left : right}`);
  for (const key of ["major", "minor", "patch"]) {
    const compared = compareNumericIdentifier(a[key], b[key]);
    if (compared) return compared;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const identifiers = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric)
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function validateManifestV1(value) {
  assert(isRecord(value), "Integration manifest must be an object.");
  assert(hasOnlyKeys(value, MANIFEST_KEYS), "Integration manifest contains unsupported fields.");
  assert(
    value.apiVersion === HARNESS_INTEGRATION_API_VERSION,
    `Unsupported integration apiVersion ${String(value.apiVersion)}.`,
  );
  assert(
    value.kind === "IntegrationPlugin" && value.manifestVersion === 1,
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
    isRecord(value.compatibility) && hasOnlyKeys(value.compatibility, new Set(["harness"])),
    "Integration compatibility contains unsupported fields.",
  );
  const harness = value.compatibility.harness;
  assert(
    isRecord(harness) && hasOnlyKeys(harness, new Set(["min", "maxExclusive"])),
    "Integration manifest must declare an explicit Harness version range.",
  );
  assert(
    nonEmpty(harness.min) &&
      nonEmpty(harness.maxExclusive) &&
      parsedVersion(harness.min) &&
      parsedVersion(harness.maxExclusive),
    "Integration manifest must declare an explicit Harness version range.",
  );
  assert(
    compareVersion(harness.min, harness.maxExclusive) < 0,
    "Integration Harness version range must have min < maxExclusive.",
  );
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
        (capability.access === undefined ||
          capability.access === "default" ||
          capability.access === "opt-in"),
      "Every capability requires a unique id, displayName, and description.",
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
      const references = Array.isArray(entry.capabilities)
        ? entry.capabilities
        : nonEmpty(entry.capability)
          ? [entry.capability]
          : [];
      assert(
        references.length > 0 &&
          references.every((capability) => nonEmpty(capability) && capabilityIds.has(capability)) &&
          new Set(references).size === references.length &&
          !(entry.capability !== undefined && entry.capabilities !== undefined),
        `${kind} ${entry.name} references an unknown capability.`,
      );
      assert(
        kind !== "tool" ||
          entry.effect === undefined ||
          entry.effect === "read" ||
          entry.effect === "write",
        `Tool ${entry.name} has an invalid effect.`,
      );
      assert(!names.has(entry.name), `Duplicate ${kind} name ${entry.name}.`);
      names.add(entry.name);
    }
  }
  return value;
}
