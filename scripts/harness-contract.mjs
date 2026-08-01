import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";

import { satisfies as satisfiesSemver } from "semver";
import * as YAML from "yaml";

import { PROVIDER_EFFECT_PEER_RANGE } from "./provider-runtime-dependencies.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert(result.status === 0, result.stderr || `git ${args.join(" ")} failed.`);
  return result.stdout.trim();
}

/**
 * Establishes immutability, not provenance. The caller must select a trusted Harness checkout;
 * contract verification imports and executes modules from it after this identity check succeeds.
 */
export function assertTrustedHarnessCheckout(harnessRoot, expectedHarnessCommit) {
  assert(
    typeof harnessRoot === "string" && harnessRoot.length > 0,
    "TRITONAI_HARNESS_ROOT must identify an exact trusted Harness checkout.",
  );
  assert(
    /^[a-f0-9]{40}$/u.test(expectedHarnessCommit ?? ""),
    "TRITONAI_HARNESS_COMMIT must be the full trusted Harness commit SHA.",
  );

  const harness = Path.resolve(harnessRoot);
  const actualHead = git(["rev-parse", "HEAD"], harness);
  assert(/^[a-f0-9]{40}$/u.test(actualHead), "Harness HEAD must be a full commit SHA.");
  assert(
    actualHead === expectedHarnessCommit,
    `Harness checkout is at ${actualHead}, expected ${expectedHarnessCommit}.`,
  );
  assert(
    git(["status", "--porcelain=v1", "--untracked-files=all"], harness) === "",
    "Harness worktree must be clean so the contract uses one exact trusted commit.",
  );

  return { actualHead, harness };
}

export function assertSupportedEffectVersion(version) {
  assert(
    typeof version === "string" &&
      satisfiesSemver(version, PROVIDER_EFFECT_PEER_RANGE, { includePrerelease: true }),
    `Harness Effect ${String(version)} is outside the provider peer range ${PROVIDER_EFFECT_PEER_RANGE}.`,
  );
}

function patchIdentity(workspace, lockfile, selector) {
  const configuredPath = workspace?.patchedDependencies?.[selector];
  const lockedPatch = lockfile?.patchedDependencies?.[selector];

  if (configuredPath === undefined && lockedPatch === undefined) return undefined;
  assert(
    typeof configuredPath === "string" && configuredPath.length > 0,
    `Harness workspace patch path for ${selector} is missing or malformed.`,
  );
  const normalizedPath = configuredPath.replaceAll("\\", "/");
  assert(
    !Path.posix.isAbsolute(normalizedPath) &&
      Path.posix.normalize(normalizedPath) === normalizedPath &&
      normalizedPath !== "." &&
      normalizedPath !== ".." &&
      !normalizedPath.startsWith("../"),
    `Harness workspace patch path for ${selector} must stay inside the checkout.`,
  );

  let hash;
  if (typeof lockedPatch === "string") {
    // pnpm 11 stores only the hash here; the matching path remains in pnpm-workspace.yaml.
    hash = lockedPatch;
  } else {
    // pnpm 10 lockfiles store both fields in the patchedDependencies entry.
    assert(
      isRecord(lockedPatch) &&
        Object.keys(lockedPatch).toSorted().join(",") === "hash,path" &&
        lockedPatch.path === configuredPath,
      `Harness lockfile patch metadata for ${selector} is malformed or disagrees with the workspace.`,
    );
    hash = lockedPatch.hash;
  }
  assert(
    typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash),
    `Harness lockfile patch hash for ${selector} is malformed.`,
  );
  return { hash, path: normalizedPath };
}

export function resolveEffectRuntimeIdentity({
  workspace,
  lockfile,
  installedPackageVersion,
  installedRealpath,
  expectedPnpmStoreRoot,
}) {
  const version = workspace?.catalog?.effect;
  assertSupportedEffectVersion(version);

  const packageKey = `effect@${version}`;
  const patch = patchIdentity(workspace, lockfile, packageKey);
  const lockVersion = patch === undefined ? version : `${version}(patch_hash=${patch.hash})`;
  const snapshotKey = patch === undefined ? packageKey : `${packageKey}(patch_hash=${patch.hash})`;
  const serverEffect = lockfile?.importers?.["apps/server"]?.dependencies?.effect;

  assert(
    serverEffect?.specifier === version && serverEffect?.version === lockVersion,
    "Harness server importer does not bind Effect to the catalog and patch identity.",
  );
  assert(
    isRecord(lockfile?.packages) && Object.hasOwn(lockfile.packages, packageKey),
    `Harness lockfile package entry is missing ${packageKey}.`,
  );
  assert(
    isRecord(lockfile?.snapshots) && Object.hasOwn(lockfile.snapshots, snapshotKey),
    `Harness lockfile snapshot entry is missing ${snapshotKey}.`,
  );
  assert(
    installedPackageVersion === version,
    `Harness installed Effect ${String(installedPackageVersion)} does not match catalog ${version}.`,
  );

  const normalizedRealpath = installedRealpath.replaceAll("\\", "/");
  const storeDirectory = Path.posix.basename(
    Path.posix.dirname(Path.posix.dirname(normalizedRealpath)),
  );
  const expectedStoreDirectory =
    patch === undefined ? packageKey : `${packageKey}_patch_hash=${patch.hash}`;
  const normalizedStoreRoot = expectedPnpmStoreRoot.replaceAll("\\", "/");
  const expectedRealpath = Path.posix.join(
    normalizedStoreRoot,
    expectedStoreDirectory,
    "node_modules/effect",
  );
  assert(
    normalizedRealpath === expectedRealpath && storeDirectory === expectedStoreDirectory,
    `Harness installed Effect realpath does not match lock identity ${lockVersion}.`,
  );

  return { lockVersion, packageKey, patch, snapshotKey, version };
}

export async function verifyHarnessEffectRuntime(harness) {
  const workspace = YAML.parse(
    await Fs.readFile(Path.join(harness, "pnpm-workspace.yaml"), "utf8"),
  );
  const lockfile = YAML.parse(await Fs.readFile(Path.join(harness, "pnpm-lock.yaml"), "utf8"));
  const installedRoot = Path.join(harness, "apps/server/node_modules/effect");
  const installedPackage = JSON.parse(
    await Fs.readFile(Path.join(installedRoot, "package.json"), "utf8"),
  );
  const identity = resolveEffectRuntimeIdentity({
    workspace,
    lockfile,
    installedPackageVersion: installedPackage.version,
    installedRealpath: await Fs.realpath(installedRoot),
    expectedPnpmStoreRoot: Path.join(harness, "node_modules/.pnpm"),
  });
  if (identity.patch !== undefined) {
    const patchFile = await Fs.stat(Path.join(harness, identity.patch.path)).catch(() => undefined);
    assert(patchFile?.isFile(), `Harness Effect patch is missing ${identity.patch.path}.`);
  }
  return { ...identity, workspace };
}
