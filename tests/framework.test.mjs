import assert from "node:assert/strict";
import test from "node:test";

import { validateManifestV2 } from "../scripts/manifest-v2.mjs";
import {
  assertPackedMetadata,
  assertPackedStaticFiles,
  assertSafePackageFiles,
  assertSourceMetadataUnchanged,
  assertStaticSourceUnchanged,
} from "../scripts/package-artifact.mjs";
import { parseSkillFrontmatter } from "../scripts/skill-frontmatter.mjs";

const manifest = {
  apiVersion: "tritonai.harness/v2",
  kind: "IntegrationPlugin",
  manifestVersion: 2,
  id: "fixture-reader",
  name: "Fixture Reader",
  description: "A framework validation fixture.",
  version: "1.0.0",
  capabilities: [
    {
      id: "fixture.read",
      displayName: "Read fixture",
      description: "Read fixture data.",
      access: "default",
    },
    {
      id: "fixture.write",
      displayName: "Write fixture",
      description: "Write fixture data.",
      access: "opt-in",
    },
  ],
  tools: [],
  skills: [
    {
      name: "fixture-reader",
      description: "Read fixture data.",
      capabilities: ["fixture.read", "fixture.write"],
    },
  ],
};

test("accepts a strict skill-only Harness v2 manifest", () => {
  assert.equal(validateManifestV2(structuredClone(manifest)).id, "fixture-reader");
});

test("rejects the previous Harness manifest contract", () => {
  assert.throws(
    () =>
      validateManifestV2({
        ...manifest,
        apiVersion: "tritonai.harness/v1",
        manifestVersion: 1,
      }),
    /unsupported/iu,
  );
});

test("accepts access policy, multi-capability dependencies, and tool effects", () => {
  const withTool = structuredClone(manifest);
  withTool.provider = "fixture-provider";
  withTool.tools = [
    {
      name: "fixture.write",
      displayName: "Write fixture",
      description: "Write fixture data.",
      capabilities: ["fixture.write"],
      effect: "write",
    },
  ];
  assert.equal(validateManifestV2(withTool).tools[0].effect, "write");
});

test("rejects unsupported and missing manifest fields", () => {
  assert.throws(
    () => validateManifestV2({ ...manifest, unsupported: true }),
    /unsupported fields/u,
  );
  assert.throws(
    () =>
      validateManifestV2({
        ...manifest,
        compatibility: { harness: { min: "0.2.0", maxExclusive: "0.3.0" } },
      }),
    /unsupported fields/u,
  );
  const missingAccess = structuredClone(manifest);
  delete missingAccess.capabilities[0].access;
  assert.throws(() => validateManifestV2(missingAccess), /capability/u);
});

test("rejects mismatched providers and tools and unknown capabilities", () => {
  const withProviderOnly = structuredClone(manifest);
  withProviderOnly.provider = "fixture-provider";
  assert.throws(() => validateManifestV2(withProviderOnly), /exactly when/u);

  const withTool = structuredClone(manifest);
  withTool.tools = [
    {
      name: "fixture.read",
      displayName: "Read fixture",
      description: "Read fixture data.",
      capabilities: ["missing.read"],
      effect: "read",
    },
  ];
  assert.throws(() => validateManifestV2(withTool), /exactly when/u);
  withTool.provider = "fixture-provider";
  assert.throws(() => validateManifestV2(withTool), /unknown capability/u);

  const legacyDependencySpelling = structuredClone(manifest);
  delete legacyDependencySpelling.skills[0].capabilities;
  legacyDependencySpelling.skills[0].capability = "fixture.read";
  assert.throws(() => validateManifestV2(legacyDependencySpelling), /unsupported skill fields/u);

  const missingEffect = structuredClone(manifest);
  missingEffect.provider = "fixture-provider";
  missingEffect.tools = [
    {
      name: "fixture.read",
      displayName: "Read fixture",
      description: "Read fixture data.",
      capabilities: ["fixture.read"],
    },
  ];
  assert.throws(() => validateManifestV2(missingEffect), /invalid effect/u);

  const invalidAccess = structuredClone(manifest);
  invalidAccess.capabilities[0].access = "always";
  assert.throws(() => validateManifestV2(invalidAccess), /capability/u);
});

test("parses bounded YAML skill frontmatter", () => {
  assert.deepEqual(
    parseSkillFrontmatter(
      "---\nname: fixture-reader\ndescription: Read fixture data.\n---\n# Skill\n",
    ),
    { name: "fixture-reader", description: "Read fixture data." },
  );
});

test("rejects missing delimiters and duplicate frontmatter keys", () => {
  assert.throws(
    () => parseSkillFrontmatter("---\nname: fixture-reader\ndescription: Outside only."),
    /closing/u,
  );
  assert.throws(
    () =>
      parseSkillFrontmatter(
        "---\nname: fixture-reader\nname: duplicate\ndescription: Read fixture data.\n---\n",
      ),
    /must be unique/u,
  );
});

const safeArtifactFiles = [
  "package/.tritonai-plugin/plugin.json",
  "package/README.md",
  "package/SECURITY.md",
  "package/package.json",
  "package/skills/fixture-reader/SKILL.md",
];

test("accepts only declared package metadata and skill roots", () => {
  assert.doesNotThrow(() => assertSafePackageFiles("fixture-reader", safeArtifactFiles, manifest));
  for (const unsafe of [
    "package/.tritonai-plugin/extra.json",
    "package/skills/undeclared/SKILL.md",
    "package/dist/provider.test.js",
    "package/dist/provider.test.d.ts",
    "package/dist/provider.ts",
    "package/dist/provider.js.map",
  ]) {
    assert.throws(
      () => assertSafePackageFiles("fixture-reader", [...safeArtifactFiles, unsafe], manifest),
      /unsafe or undeclared/u,
    );
  }
  assert.throws(
    () =>
      assertSafePackageFiles(
        "fixture-reader",
        [...safeArtifactFiles, "package/dist/index.js"],
        manifest,
      ),
    /unsafe or undeclared/u,
  );
});

test("rejects packed metadata that differs from reviewed source", () => {
  const packageJson = {
    name: "@tritonai/plugin-fixture-reader",
    version: "1.0.0",
    scripts: { prepack: "pnpm build", test: "vp test run" },
  };
  const packedPackageJson = {
    ...packageJson,
    scripts: { test: "vp test run" },
  };
  assert.doesNotThrow(() =>
    assertPackedMetadata("fixture-reader", packageJson, manifest, packedPackageJson, manifest),
  );
  assert.throws(
    () =>
      assertPackedMetadata(
        "fixture-reader",
        packageJson,
        manifest,
        { ...packedPackageJson, version: "2.0.0" },
        manifest,
      ),
    /package.json differs/u,
  );
  assert.throws(
    () =>
      assertPackedMetadata("fixture-reader", packageJson, manifest, packedPackageJson, {
        ...manifest,
        version: "2.0.0",
      }),
    /manifest differs/u,
  );
  assert.throws(
    () => assertPackedMetadata("fixture-reader", packageJson, manifest, packageJson, manifest),
    /must not retain the prepack/u,
  );
  assert.doesNotThrow(() =>
    assertSourceMetadataUnchanged("fixture-reader", packageJson, manifest, packageJson, manifest),
  );
  assert.throws(
    () =>
      assertSourceMetadataUnchanged(
        "fixture-reader",
        packageJson,
        manifest,
        { ...packageJson, scripts: { test: "vp test run" } },
        manifest,
      ),
    /changed reviewed source package.json/u,
  );
});

test("requires packed static bytes to match reviewed source", () => {
  const reviewed = new Map([["package/README.md", Buffer.from("reviewed")]]);
  assert.doesNotThrow(() =>
    assertPackedStaticFiles(
      "fixture-reader",
      new Map([["package/README.md", Buffer.from("reviewed")]]),
      reviewed,
    ),
  );
  assert.throws(
    () =>
      assertPackedStaticFiles(
        "fixture-reader",
        new Map([["package/README.md", Buffer.from("rewritten")]]),
        reviewed,
      ),
    /differs from reviewed source/u,
  );
  assert.throws(
    () =>
      assertPackedStaticFiles(
        "fixture-reader",
        new Map([
          ["package/README.md", Buffer.from("reviewed")],
          ["package/skills/fixture-reader/extra.md", Buffer.from("added")],
        ]),
        reviewed,
      ),
    /no reviewed source/u,
  );
  assert.throws(
    () =>
      assertPackedStaticFiles(
        "fixture-reader",
        new Map([["package/README.md", Buffer.from("reviewed")]]),
        new Map([
          ["package/README.md", Buffer.from("reviewed")],
          ["package/skills/fixture-reader/helper.js", Buffer.from("helper")],
        ]),
      ),
    /missing from package/u,
  );
  assert.throws(
    () =>
      assertPackedStaticFiles(
        "fixture-reader",
        new Map([["package/dist/index.js", Buffer.from("rewritten")]]),
        new Map([["package/dist/index.js", Buffer.from("reviewed")]]),
      ),
    /differs from reviewed source/u,
  );
  assert.throws(
    () =>
      assertPackedStaticFiles(
        "fixture-reader",
        new Map([["package/dist/index.js", Buffer.from("reviewed")]]),
        new Map([
          ["package/dist/index.js", Buffer.from("reviewed")],
          ["package/dist/schema.json", Buffer.from("{}")],
        ]),
      ),
    /missing from package/u,
  );
});

test("detects package lifecycle mutations to static source", () => {
  const before = new Map([["package/README.md", Buffer.from("reviewed")]]);
  assert.doesNotThrow(() => assertStaticSourceUnchanged("fixture-reader", before, before));
  assert.throws(
    () =>
      assertStaticSourceUnchanged(
        "fixture-reader",
        before,
        new Map([["package/README.md", Buffer.from("changed")]]),
      ),
    /changed reviewed source/u,
  );
  assert.throws(
    () => assertStaticSourceUnchanged("fixture-reader", before, new Map()),
    /changed the reviewed static file set/u,
  );
});
