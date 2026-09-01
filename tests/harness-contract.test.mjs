import assert from "node:assert/strict";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertSupportedEffectVersion,
  assertTrustedHarnessCheckout,
  resolveEffectRuntimeIdentity,
} from "../scripts/harness-contract.mjs";

const effectVersion = "4.0.0-beta.103";
const effectHash = "7".repeat(64);
const effectSelector = `effect@${effectVersion}`;
const effectPatchPath = `patches/effect@${effectVersion}.patch`;

function runtimeFixture({ lockPatch = effectHash, patched = true } = {}) {
  const lockVersion = patched ? `${effectVersion}(patch_hash=${effectHash})` : effectVersion;
  const snapshotKey = patched ? `${effectSelector}(patch_hash=${effectHash})` : effectSelector;
  return {
    workspace: {
      catalog: { effect: effectVersion },
      ...(patched ? { patchedDependencies: { [effectSelector]: effectPatchPath } } : {}),
    },
    lockfile: {
      ...(patched ? { patchedDependencies: { [effectSelector]: lockPatch } } : {}),
      importers: {
        "apps/server": {
          dependencies: { effect: { specifier: effectVersion, version: lockVersion } },
        },
      },
      packages: { [effectSelector]: {} },
      snapshots: { [snapshotKey]: {} },
    },
    installedPackageVersion: effectVersion,
    expectedPnpmStoreRoot: "/fixture/node_modules/.pnpm",
    installedRealpath: patched
      ? `/fixture/node_modules/.pnpm/${effectSelector}_patch_hash=${effectHash}/node_modules/effect`
      : `/fixture/node_modules/.pnpm/${effectSelector}/node_modules/effect`,
  };
}

test("enforces the complete provider Effect peer-range boundaries", () => {
  for (const version of ["4.0.0-beta.78", effectVersion, "4.0.0-rc.0"]) {
    assert.doesNotThrow(() => assertSupportedEffectVersion(version));
  }
  for (const version of ["4.0.0-beta.77", "4.0.0", "5.0.0-beta.1", "invalid"]) {
    assert.throws(() => assertSupportedEffectVersion(version), /outside the provider peer range/u);
  }
});

test("accepts pnpm object patch metadata and binds its path and hash", () => {
  const fixture = runtimeFixture({
    lockPatch: { hash: effectHash, path: effectPatchPath },
  });
  assert.deepEqual(resolveEffectRuntimeIdentity(fixture).patch, {
    hash: effectHash,
    path: effectPatchPath,
  });
  fixture.lockfile.patchedDependencies[effectSelector].path = "patches/other.patch";
  assert.throws(
    () => resolveEffectRuntimeIdentity(fixture),
    /malformed or disagrees with the workspace/u,
  );
});

test("accepts the current pnpm hash-only patch metadata", () => {
  assert.deepEqual(resolveEffectRuntimeIdentity(runtimeFixture()).patch, {
    hash: effectHash,
    path: effectPatchPath,
  });
});

test("accepts a coherently unpatched Effect runtime", () => {
  const identity = resolveEffectRuntimeIdentity(runtimeFixture({ patched: false }));
  assert.equal(identity.patch, undefined);
  assert.equal(identity.lockVersion, effectVersion);
  assert.equal(identity.snapshotKey, effectSelector);
});

test("binds the server importer, package and snapshot keys, and patch identity", () => {
  const catalogDrift = runtimeFixture();
  catalogDrift.workspace.catalog.effect = "4.0.0-beta.101";
  assert.throws(() => resolveEffectRuntimeIdentity(catalogDrift), /server importer/u);

  const importerDrift = runtimeFixture();
  importerDrift.lockfile.importers["apps/server"].dependencies.effect.version = effectVersion;
  assert.throws(() => resolveEffectRuntimeIdentity(importerDrift), /server importer/u);

  const packageDrift = runtimeFixture();
  delete packageDrift.lockfile.packages[effectSelector];
  assert.throws(() => resolveEffectRuntimeIdentity(packageDrift), /package entry is missing/u);

  const snapshotDrift = runtimeFixture();
  delete snapshotDrift.lockfile.snapshots[`${effectSelector}(patch_hash=${effectHash})`];
  assert.throws(() => resolveEffectRuntimeIdentity(snapshotDrift), /snapshot entry is missing/u);

  const patchDrift = runtimeFixture({ lockPatch: "bad-hash" });
  assert.throws(() => resolveEffectRuntimeIdentity(patchDrift), /patch hash/u);
});

test("binds installed package version and exact pnpm realpath", () => {
  const versionDrift = runtimeFixture();
  versionDrift.installedPackageVersion = "4.0.0-beta.101";
  assert.throws(() => resolveEffectRuntimeIdentity(versionDrift), /installed Effect/u);

  const realpathDrift = runtimeFixture();
  realpathDrift.installedRealpath =
    "/fixture/node_modules/.pnpm/effect@4.0.0-beta.103/node_modules/effect";
  assert.throws(() => resolveEffectRuntimeIdentity(realpathDrift), /realpath/u);
});

test("requires the exact caller-supplied commit and a clean Harness tree", async (context) => {
  const checkout = await Fs.mkdtemp(Path.join(Os.tmpdir(), "tritonai-harness-contract-test-"));
  context.after(() => Fs.rm(checkout, { recursive: true, force: true }));
  const runGit = (args) => {
    const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit(["init", "--quiet"]);
  await Fs.writeFile(Path.join(checkout, "tracked.txt"), "trusted\n");
  runGit(["add", "tracked.txt"]);
  runGit([
    "-c",
    "user.name=Contract Fixture",
    "-c",
    "user.email=contract@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const commit = runGit(["rev-parse", "HEAD"]);

  assert.deepEqual(assertTrustedHarnessCheckout(checkout, commit), {
    actualHead: commit,
    harness: checkout,
  });
  assert.throws(
    () => assertTrustedHarnessCheckout(checkout, "0".repeat(40)),
    /expected 0000000000000000000000000000000000000000/u,
  );

  await Fs.writeFile(Path.join(checkout, "dirty.txt"), "untrusted drift\n");
  assert.throws(() => assertTrustedHarnessCheckout(checkout, commit), /worktree must be clean/u);
});
