import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assertTrustedHarnessCheckout } from "./harness-contract.mjs";

const { harness: repo, actualHead } = assertTrustedHarnessCheckout(
  process.env.TRITONAI_HARNESS_ROOT,
  process.env.TRITONAI_HARNESS_COMMIT,
);
if (process.platform !== "darwin")
  throw new Error(
    "The broker runtime contract requires macOS; unsupported platforms are not a passing runtime proof.",
  );
const plugins = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
const pluginHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: plugins })).stdout.trim();
async function assertCleanPluginCheckout() {
  const status = await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: plugins,
  });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: plugins })).stdout.trim();
  if (status.stdout.trim() !== "" || head !== pluginHead)
    throw new Error("Plugins checkout must remain clean at one exact commit for broker proof.");
}
await assertCleanPluginCheckout();
const importHost = (relative) => import(pathToFileURL(path.join(repo, relative)).href);
const { createMacPluginSandboxRuntime } = await importHost(
  "apps/server/src/integrations/pluginSandbox/MacPluginSandboxRuntime.ts",
);
const { loadIsolatedPluginIntegration } = await importHost(
  "apps/server/src/integrations/pluginSandbox/IsolatedPluginAdapter.ts",
);
const { loadProductionPackageForTest } = await importHost(
  "apps/server/src/integrations/productionBuiltins.ts",
);
const { loadPluginSandboxBundleForBuild } = await importHost(
  "scripts/lib/plugin-sandbox-bundle.ts",
);
const bundle = loadPluginSandboxBundleForBuild(repo, process.env);
if (!bundle || bundle.manifest.arch !== process.arch)
  throw new Error("Supply a host-verified runtime bundle for this architecture.");
const pins = Object.fromEntries(
  ["runtime", "supervisor", "bootstrap", "engine", "bridge"].map((key) => [
    key,
    {
      path: path.join(bundle.root, bundle.manifest.files[key].name),
      sha256: bundle.manifest.files[key].sha256,
    },
  ]),
);
const require = createRequire(repo + "/apps/server/package.json");
const Effect = require("effect/Effect"),
  Option = require("effect/Option");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "broker-host-contract-")));
async function collect(directory, prefix = "") {
  const result = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix + item.name,
      full = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...(await collect(full, relative + "/")));
    else if (item.isFile()) result.push({ path: relative, contents: await fs.readFile(full) });
    else throw new Error("Nonregular artifact path");
  }
  return result;
}
const pluginPatchSha256 = sha(
  (await exec("git", ["diff", "--binary", "HEAD"], { cwd: plugins })).stdout,
);
let runtime;
const stored = new Map(),
  network = [],
  results = [],
  providers = [];
let admissions = 0;
const secrets = {
  get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
  set: (name, value) =>
    Effect.sync(() => {
      stored.set(name, value);
    }),
  remove: (name) =>
    Effect.sync(() => {
      stored.delete(name);
    }),
  create: () => Effect.void,
  getOrCreateRandom: (_name, n) => Effect.succeed(new Uint8Array(n)),
};
const context = {
  signal: new AbortController().signal,
  beginCommit: async () => {
    admissions++;
    return new AbortController().signal;
  },
};
const doc = "a".repeat(24),
  app = "c".repeat(24),
  action = "b".repeat(24);
const transport = async ({ credential, document, variables, signal }) => {
  if (credential !== "synthetic-host-only-api-key") throw Error("Wrong host credential");
  signal.throwIfAborted();
  network.push({ document, variables });
  if (document.includes("DocumentVersion"))
    return { document: { id: doc, meta: { updatedAt: 7 } } };
  if (document.includes("DraftAction"))
    return { action: { id: action, appId: app, document: { id: doc } } };
  if (document.startsWith("mutation KualiBuildDocumentUpdate"))
    return { updateDocument: { id: doc } };
  if (document.startsWith("mutation KualiBuildDraftInitialize"))
    return { initializeWorkflow: { actionId: action } };
  if (document.startsWith("mutation KualiBuildDocumentSubmit"))
    return { submitDocument: "synthetic-submission" };
  if (document.includes("KualiBuildApps")) return { apps: [{ id: app, name: "Synthetic app" }] };
  if (document.includes("KualiBuildFormSchema"))
    return {
      app: {
        id: app,
        name: "Synthetic app",
        formVersion: { schema: [{ formKey: "text", label: "Text" }] },
      },
    };
  if (document.includes("KualiBuildDocuments"))
    return {
      app: {
        id: app,
        name: "Synthetic app",
        documentConnection: {
          totalCount: 1,
          edges: [{ node: { id: doc } }],
          pageInfo: { hasNextPage: false, hasPreviousPage: false, skip: 0, limit: 25 },
        },
      },
    };
  if (document.includes("KualiBuildApp")) return { app: { id: app, name: "Synthetic app" } };
  if (document.includes("KualiBuildUsers"))
    return {
      usersConnection: { edges: [{ node: { id: "synthetic-user", displayName: "Fixture" } }] },
    };
  if (document.includes("KualiBuildDocument") || document.includes("KualiBuildWorkflowStatus"))
    return {
      document: {
        id: doc,
        data: { text: "fixture" },
        meta: { updatedAt: 7, workflowStatus: "Draft" },
      },
    };
  throw Error("Unknown host recipe");
};
try {
  runtime = await createMacPluginSandboxRuntime({
    platform: process.platform,
    parentDirectory: root,
    ...pins,
  });
  for (const id of ["synthetic-api-key", "kuali-build"]) {
    const files = (await collect(plugins + "/artifacts/" + id)).sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
      digest = crypto.createHash("sha256");
    for (const file of files) {
      digest.update(file.path);
      digest.update("\0");
      digest.update(String(file.contents.length));
      digest.update("\0");
      digest.update(file.contents);
      digest.update("\0");
    }
    const plugin = {
      id,
      name: id,
      version: "2.0.0",
      digest: digest.digest("hex"),
      files: files.map((f) => ({ path: f.path, sha256: sha(f.contents), size: f.contents.length })),
    };
    const loaded =
      id === "synthetic-api-key"
        ? await loadProductionPackageForTest(
            plugins + "/artifacts/" + id,
            plugin,
            secrets,
            {},
            undefined,
            runtime,
          )
        : await loadIsolatedPluginIntegration({
            files,
            expected: plugin,
            configuration: {},
            secrets,
            runtime,
            transport,
          });
    const provider = loaded.provider;
    providers.push(provider);
    const caps =
      id === "kuali-build"
        ? ["kuali-build.read", "kuali-build.write"]
        : ["synthetic-api-key.read", "synthetic-api-key.write"];
    const flow = await provider.connect(caps, context);
    if (flow.kind !== "api_key") throw Error("Expected fresh host flow");
    await provider.connect(caps, context, {
      kind: "api_key",
      flowId: flow.flowId,
      value: "synthetic-host-only-api-key",
    });
    const invocations =
      id === "synthetic-api-key"
        ? [
            ["synthetic.items.put", { id: "owned", value: "host retained" }],
            ["synthetic.items.list", {}],
          ]
        : [
            ["kuali-build.apps.list", {}],
            ["kuali-build.apps.get", { appId: app }],
            ["kuali-build.forms.schema", { appId: app }],
            ["kuali-build.documents.list", { appId: app }],
            ["kuali-build.documents.get", { documentId: doc }],
            [
              "kuali-build.documents.update",
              {
                documentId: doc,
                expectedUpdatedAt: "7",
                data: { "data.text": "synthetic update" },
                confirmUpdate: true,
              },
            ],
            ["kuali-build.documents.drafts.initialize", { appId: app, confirmCreateDraft: true }],
            ["kuali-build.documents.drafts.resolve", { actionId: action }],
            [
              "kuali-build.documents.submit",
              {
                documentId: doc,
                actionId: action,
                data: { text: "synthetic submit" },
                confirmSubmit: true,
              },
            ],
            ["kuali-build.users.lookup", { query: "fixture" }],
            ["kuali-build.workflows.status", { documentId: doc }],
          ];
    for (const [tool, input] of invocations) {
      const result = await provider.invoke(tool, input, context);
      if (!result || typeof result !== "object") throw Error("Unusable public result");
      results.push({ tool, result });
    }
    await provider.disconnect(context);
    if ((await provider.status()).state !== "not_connected") throw Error("Disconnect failed");
  }
  if (stored.size !== 0 || results.length !== 13 || admissions !== 8)
    throw Error("Incorrect host lifecycle or operation count");
  await assertCleanPluginCheckout();
  const receipt = {
    harnessHead: actualHead,
    pluginsHead: pluginHead,
    pluginPatchSha256,
    node: process.version,
    executionProfile: runtime.executionProfile,
    pins,
    results,
    hostTransportCalls: network.length,
    admissions,
    credentialStoreEmpty: stored.size === 0,
    proof:
      "Actual pinned macOS host verifier and QuickJS/Wasm worker; synthetic transport, credentials and admission callback only. F05 UI/journal, live Kuali, signed package, Windows and whole-worker hard RSS are separate checks.",
  };
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const p of providers) await p.close();
  if (runtime) await runtime[Symbol.asyncDispose]();
  await fs.rm(root, { recursive: true, force: true });
}
