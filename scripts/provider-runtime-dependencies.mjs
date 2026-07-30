import { isDeepStrictEqual } from "node:util";

export const PROVIDER_EFFECT_DEV_VERSION = "4.0.0-beta.102";
export const PROVIDER_EFFECT_PEER_RANGE = ">=4.0.0-beta.78 <4.0.0";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertProviderRuntimeDependencies(directory, packageJson, manifest) {
  if (manifest.provider === undefined) {
    assert(
      packageJson.dependencies === undefined &&
        packageJson.peerDependencies === undefined &&
        packageJson.optionalDependencies === undefined &&
        packageJson.bundledDependencies === undefined &&
        packageJson.bundleDependencies === undefined,
      `${directory}: providerless packages must omit runtime dependencies.`,
    );
    return;
  }

  assert(
    packageJson.dependencies === undefined,
    `${directory}: provider packages must omit production dependencies; the Harness supplies the runtime.`,
  );
  assert(
    packageJson.optionalDependencies === undefined,
    `${directory}: provider packages must omit optional runtime dependencies.`,
  );
  assert(
    packageJson.bundledDependencies === undefined && packageJson.bundleDependencies === undefined,
    `${directory}: provider packages must omit bundled runtime dependencies.`,
  );
  assert(
    isRecord(packageJson.peerDependencies) &&
      isDeepStrictEqual(Object.keys(packageJson.peerDependencies).toSorted(), ["effect"]),
    `${directory}: provider peerDependencies must contain exactly effect.`,
  );
  assert(
    packageJson.peerDependencies.effect === PROVIDER_EFFECT_PEER_RANGE,
    `${directory}: effect peerDependency must be ${PROVIDER_EFFECT_PEER_RANGE}.`,
  );
  assert(
    isRecord(packageJson.devDependencies) &&
      packageJson.devDependencies.effect === PROVIDER_EFFECT_DEV_VERSION,
    `${directory}: package-local development effect must be pinned to ${PROVIDER_EFFECT_DEV_VERSION}.`,
  );
}
