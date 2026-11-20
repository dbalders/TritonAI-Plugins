// Live, read-only smoke test of this checkout's built providers against a real account, signed in
// once with `--sign-in`. See docs/release-checklist.md.
//
// Read-only is enforced twice: only tools the manifest marks `effect: "read"` (and the provider
// marks readOnly) are invoked, and every outgoing request other than GET/HEAD is refused except
// OAuth sign-in and token refresh. Results stay in memory; the report prints tool names, HTTP
// status and provider error codes only.
import { spawnSync } from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";

import { keychainSecretStore, readPluginConfiguration } from "./live-smoke-credentials.mjs";

const repositoryRoot = Path.resolve(import.meta.dirname, "..");
const DAY_MS = 24 * 60 * 60 * 1000;
const TOOL_TIMEOUT_MS = 30_000;

class Skip extends Error {}

/** A value from an earlier read, or a skip when the account has no suitable sample. */
function need(value, from) {
  if (value === undefined || value === null) throw new Skip(`no sample from ${from}`);
  return value;
}

function smallest(items, maxBytes) {
  return items
    .filter((item) => typeof item.size === "number" && item.size <= maxBytes)
    .toSorted((left, right) => left.size - right.size)[0];
}

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";

// Every read tool of each plugin, in dependency order. `input` receives earlier results by tool name.
export const PLANS = {
  "google-workspace": {
    reads: [
      ["googleworkspace.identity.get", () => ({})],
      ["googleworkspace.drive.search", () => ({ limit: 50 })],
      [
        "googleworkspace.drive.item.get",
        (r) => ({
          itemId: need(r["googleworkspace.drive.search"]?.files?.[0]?.id, "drive.search"),
        }),
      ],
      [
        "googleworkspace.drive.content.get",
        (r) => ({ itemId: need(docId(r), "drive.search (a Google Doc)"), format: "text" }),
      ],
      [
        "googleworkspace.docs.get",
        (r) => ({ documentId: need(docId(r), "drive.search (a Google Doc)") }),
      ],
      [
        "googleworkspace.sheets.get",
        (r) => ({
          spreadsheetId: need(fileOfType(r, GOOGLE_SHEET), "drive.search (a Google Sheet)"),
          range: "A1:B2",
        }),
      ],
      [
        "googleworkspace.slides.get",
        (r) => ({
          presentationId: need(fileOfType(r, GOOGLE_SLIDES), "drive.search (a Google Slides file)"),
        }),
      ],
      [
        "googleworkspace.drive.permissions.list",
        (r) => ({
          itemId: need(
            r["googleworkspace.drive.search"]?.files?.find((file) =>
              file.owners.some(
                (owner) => owner.emailAddress === r["googleworkspace.identity.get"]?.email,
              ),
            )?.id,
            "drive.search (a file you own)",
          ),
          limit: 5,
        }),
      ],
      ["googleworkspace.mail.labels.list", () => ({})],
      ["googleworkspace.mail.search", () => ({ hasAttachment: true, limit: 5 })],
      [
        "googleworkspace.mail.message.get",
        (r) => ({
          messageId: need(r["googleworkspace.mail.search"]?.messages?.[0]?.id, "mail.search"),
        }),
      ],
      [
        "googleworkspace.mail.thread.get",
        (r) => ({
          threadId: need(r["googleworkspace.mail.search"]?.messages?.[0]?.threadId, "mail.search"),
        }),
      ],
      [
        "googleworkspace.mail.attachment.get",
        (r) => {
          const message = r["googleworkspace.mail.message.get"];
          const attachment = need(
            smallest(message?.attachments ?? [], 1024 * 1024),
            "mail.message.get",
          );
          return { messageId: message.id, attachmentId: attachment.attachmentId };
        },
      ],
      ["googleworkspace.calendar.list", () => ({ limit: 10 })],
      [
        "googleworkspace.calendar.events.list",
        () => ({ calendarId: "primary", ...window(15), limit: 10 }),
      ],
      [
        "googleworkspace.calendar.event.get",
        (r) => ({
          calendarId: "primary",
          eventId: need(
            r["googleworkspace.calendar.events.list"]?.events?.[0]?.id,
            "calendar.events.list",
          ),
        }),
      ],
    ],
    probes: [],
    // Provider error codes that mean the service is turned off for this account, not a defect.
    unavailable: {
      failedPrecondition: "Gmail is not enabled for this account",
      notACalendarUser: "Google Calendar is not enabled for this account",
    },
  },
  "microsoft-365": {
    reads: [
      ["microsoft365.mail.search", () => ({ limit: 25 })],
      [
        "microsoft365.mail.get",
        (r) => ({
          messageId: need(r["microsoft365.mail.search"]?.messages?.[0]?.id, "mail.search"),
        }),
      ],
      ["microsoft365.mail.folders.list", () => ({ limit: 10 })],
      [
        "microsoft365.mail.attachments.list",
        (r) => ({
          messageId: need(
            r["microsoft365.mail.search"]?.messages?.find((message) => message.hasAttachments)?.id,
            "mail.search (a message with attachments)",
          ),
          limit: 10,
        }),
      ],
      [
        "microsoft365.mail.attachment.get",
        (r) => ({
          messageId: need(
            r["microsoft365.mail.search"]?.messages?.find((message) => message.hasAttachments)?.id,
            "mail.search (a message with attachments)",
          ),
          attachmentId: need(
            fileAttachment(r["microsoft365.mail.attachments.list"]),
            "mail.attachments.list",
          ),
        }),
      ],
      ["microsoft365.calendar.events", () => window(14)],
      [
        "microsoft365.calendar.event.get",
        (r) => ({
          eventId: need(r["microsoft365.calendar.events"]?.events?.[0]?.id, "calendar.events"),
        }),
      ],
      [
        "microsoft365.calendar.event.attachments.list",
        (r) => ({
          eventId: need(
            r["microsoft365.calendar.events"]?.events?.find((event) => event.hasAttachments)?.id,
            "calendar.events (an event with attachments)",
          ),
          limit: 10,
        }),
      ],
      [
        "microsoft365.calendar.event.attachment.get",
        (r) => ({
          eventId: need(
            r["microsoft365.calendar.events"]?.events?.find((event) => event.hasAttachments)?.id,
            "calendar.events (an event with attachments)",
          ),
          attachmentId: need(
            fileAttachment(r["microsoft365.calendar.event.attachments.list"]),
            "calendar.event.attachments.list",
          ),
        }),
      ],
      ["microsoft365.chat.list", () => ({ limit: 5 })],
      [
        "microsoft365.chat.messages",
        (r) => ({
          chatId: need(r["microsoft365.chat.list"]?.chats?.[0]?.id, "chat.list"),
          limit: 5,
        }),
      ],
      ["microsoft365.files.list", () => ({ limit: 50 })],
      ["microsoft365.files.search", () => ({ query: "a", limit: 5 })],
      [
        "microsoft365.files.get",
        (r) => ({ itemId: need(r["microsoft365.files.list"]?.items?.[0]?.id, "files.list") }),
      ],
      [
        "microsoft365.files.content.get",
        (r) => ({
          itemId: need(
            smallest(
              (r["microsoft365.files.list"]?.items ?? []).filter((item) => item.kind === "file"),
              256 * 1024,
            )?.id,
            "files.list (a file under 256 KB)",
          ),
        }),
      ],
    ],
    // A write tool whose safety precheck is all reads. It runs to the point of mutation, where the
    // read-only guard must refuse exactly the expected request. The message id does not exist, so
    // even an unguarded request would find nothing to move.
    probes: [
      {
        tool: "microsoft365.mail.message.move",
        input: () => ({
          messageId: "tritonai-smoke-nonexistent-message",
          destinationFolderId: "inbox",
        }),
        refused: (request) =>
          request.method === "POST" &&
          request.url.pathname === "/v1.0/me/messages/tritonai-smoke-nonexistent-message/move",
      },
    ],
  },
};

function window(days) {
  const now = Date.now();
  return {
    start: new Date(now - days * DAY_MS).toISOString(),
    end: new Date(now + days * DAY_MS).toISOString(),
  };
}

function fileOfType(results, mimeType) {
  return results["googleworkspace.drive.search"]?.files?.find((file) => file.mimeType === mimeType)
    ?.id;
}

function docId(results) {
  return fileOfType(results, GOOGLE_DOC);
}

function fileAttachment(list) {
  return smallest(
    (list?.attachments ?? []).filter((item) => item.kind === "file"),
    1024 * 1024,
  )?.id;
}

/** Problems that would let the smoke drift from the manifest or call a non-read tool. */
export function checkPlan(manifest, plan) {
  const effects = new Map(manifest.tools.map((tool) => [tool.name, tool.effect]));
  const planned = plan.reads.map(([name]) => name);
  const problems = [];
  for (const name of planned) {
    if (effects.get(name) !== "read") problems.push(`${name} is not a manifest read tool`);
  }
  for (const [name, effect] of effects) {
    if (effect === "read" && !planned.includes(name)) problems.push(`${name} has no smoke input`);
  }
  for (const probe of plan.probes) {
    if (!effects.has(probe.tool)) problems.push(`${probe.tool} is not a manifest tool`);
  }
  return problems;
}

const TOKEN_ENDPOINTS = [
  (url) => url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token",
  (url) =>
    url.origin === "https://login.microsoftonline.com" &&
    /^\/[^/]+\/oauth2\/v2\.0\/(token|devicecode)$/u.test(url.pathname),
];

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/u;

async function providerErrorCode(response) {
  // Read at most a small prefix of the error body; the provider reads the original response.
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (size < 16 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    const error = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error;
    const codes =
      typeof error === "string"
        ? [error]
        : [error?.status, error?.code, error?.errors?.[0]?.reason, error?.innerError?.code];
    return (
      codes.filter((code) => typeof code === "string" && SAFE_CODE.test(code)).join("/") || null
    );
  } catch {
    return null;
  } finally {
    // Do not await: a tee branch's cancel settles only once the original is read too.
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * Wrap fetch so only GET/HEAD requests and OAuth token refreshes leave the process. Refused and
 * failed requests are recorded on `log` without bodies, queries or headers.
 */
export function createReadOnlyFetch(realFetch, log) {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (
      !["GET", "HEAD"].includes(method) &&
      !(method === "POST" && TOKEN_ENDPOINTS.some((ok) => ok(url)))
    ) {
      log.refused.push({ method, url });
      throw new TypeError(`Read-only smoke refused ${method} ${url.host}`);
    }
    const response = await realFetch(input, init);
    if (!response.ok) {
      log.failures.push({
        host: url.host,
        status: response.status,
        code: await providerErrorCode(response),
      });
    }
    return response;
  };
}

function describeFailure(log, error) {
  const parts = log.failures.map(
    (failure) => `HTTP ${failure.status} ${failure.host}${failure.code ? ` ${failure.code}` : ""}`,
  );
  if (log.refused.length > 0)
    parts.push(`refused ${log.refused[0].method} ${log.refused[0].url.host}`);
  // Provider public errors are fixed sentences without account content. Anything else may echo a
  // response, so only its type is shown.
  if (error instanceof Error && error.name === "IntegrationProviderPublicError") {
    parts.push(`"${error.message.slice(0, 160)}"`);
  } else {
    parts.push(error instanceof Error ? error.name : "unknown error");
  }
  return parts.join("; ");
}

function requiredCapabilities(manifest, plan) {
  const used = new Set([
    ...plan.reads.map(([name]) => name),
    ...plan.probes.map((probe) => probe.tool),
  ]);
  return [
    ...new Set(
      manifest.tools.filter((tool) => used.has(tool.name)).flatMap((tool) => tool.capabilities),
    ),
  ];
}

async function signIn(provider, manifest, plan) {
  const signal = AbortSignal.timeout(10 * 60_000);
  const context = { signal, beginCommit: async () => signal };
  const flow = await provider.connect(requiredCapabilities(manifest, plan), context);
  if (flow.kind === "device_code") {
    console.log(
      `Sign in to ${manifest.name} at ${flow.verificationUri} with code ${flow.userCode}`,
    );
  } else if (flow.kind === "authorization_url") {
    console.log(`Opening the ${manifest.name} sign-in page in your browser.`);
  }
  const page = flow.verificationUriComplete ?? flow.verificationUri ?? flow.authorizationUrl;
  if (page) spawnSync("/usr/bin/open", [page], { stdio: "ignore" });
  let wait = flow.intervalSeconds ?? 2;
  while (flow.kind !== "connected") {
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    const result = await provider.poll(flow.flowId, context);
    if (result.state === "connected") break;
    if (result.state !== "pending") throw new Error(`${manifest.name} sign-in ${result.state}.`);
    wait = result.retryAfterSeconds ?? wait;
  }
}

async function smokePlugin(pluginId, plan, log, report, { signInFirst }) {
  const packageRoot = Path.join(repositoryRoot, "plugins", pluginId);
  const manifest = JSON.parse(
    Fs.readFileSync(Path.join(packageRoot, ".tritonai-plugin", "plugin.json"), "utf8"),
  );
  const header = `${pluginId} ${manifest.version}`;
  const problems = checkPlan(manifest, plan);
  if (problems.length > 0) {
    report(header, "FAIL", problems.join("; "));
    return;
  }
  const secrets = keychainSecretStore(pluginId);
  if (!signInFirst && !secrets.has("oauth")) {
    report(header, "SKIP", "not signed in; run pnpm smoke:live --sign-in");
    return;
  }
  let provider;
  try {
    const module = await import(pathToFileURL(Path.join(packageRoot, "dist", "index.js")).href);
    provider = module.createIntegrationProvider({
      secrets: secrets.store,
      configuration: readPluginConfiguration(pluginId),
    });
  } catch (error) {
    // Configuration errors can quote the private build configuration, so show only the type.
    report(header, "FAIL", `could not load the provider (${error?.name ?? "error"})`);
    return;
  }
  const readOnly = new Map(provider.tools.map((tool) => [tool.name, tool.readOnly === true]));
  const capabilities = new Map(manifest.tools.map((tool) => [tool.name, tool.capabilities]));
  try {
    if (signInFirst) await signIn(provider, manifest, plan);
    // Token refreshes are saved only to the smoke's own Keychain item.
    const signal = AbortSignal.timeout(TOOL_TIMEOUT_MS);
    await provider.prepare?.({ signal, beginCommit: async () => signal });
    const status = await provider.status({ signal });
    report(header, status.state === "connected" ? "INFO" : "FAIL", status.state);
    if (status.state !== "connected") return;
    const granted = new Set(status.grantedCapabilities);
    const results = {};
    const run = async (name, input, context, expectRefusal) => {
      if (!capabilities.get(name).every((capability) => granted.has(capability))) {
        report(name, "SKIP", "capability not granted");
        return;
      }
      let args;
      try {
        args = input(results);
      } catch (error) {
        if (error instanceof Skip) return report(name, "SKIP", error.message);
        return report(name, "FAIL", `smoke input failed (${error.name})`);
      }
      log.failures.length = 0;
      log.refused.length = 0;
      const started = Date.now();
      try {
        results[name] = await provider.invoke(name, args, context());
        if (expectRefusal) report(name, "FAIL", "completed without reaching the guarded request");
        else report(name, "PASS", `${Date.now() - started} ms`);
      } catch (error) {
        const refusedAsExpected =
          expectRefusal &&
          log.refused.length === 1 &&
          expectRefusal(log.refused[0]) &&
          log.failures.length === 0;
        if (refusedAsExpected) report(name, "PASS", "precheck passed; mutation refused by guard");
        else {
          const code = log.failures
            .flatMap((failure) => failure.code?.split("/") ?? [])
            .find((candidate) => Object.hasOwn(plan.unavailable ?? {}, candidate));
          if (code) report(name, "SKIP", plan.unavailable[code]);
          else report(name, "FAIL", describeFailure(log, error));
        }
      }
    };
    for (const [name, input] of plan.reads) {
      if (readOnly.get(name) !== true) {
        report(name, "FAIL", "provider does not mark this tool read-only");
        continue;
      }
      await run(name, input, () => ({ signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) }), null);
    }
    for (const probe of plan.probes) {
      const probeSignal = AbortSignal.timeout(TOOL_TIMEOUT_MS);
      await run(
        probe.tool,
        probe.input,
        () => ({ signal: probeSignal, writeApproved: true, beginCommit: async () => probeSignal }),
        probe.refused,
      );
    }
  } catch (error) {
    report(header, "FAIL", describeFailure(log, error));
  } finally {
    await provider.close?.();
  }
}

async function main(argv) {
  const signInFirst = argv.includes("--sign-in");
  const rest = argv.filter((arg) => arg !== "--sign-in");
  const requested = rest.flatMap((arg, index) => (rest[index - 1] === "--plugin" ? [arg] : []));
  const unknown = requested.filter((id) => !Object.hasOwn(PLANS, id));
  if (
    unknown.length > 0 ||
    rest.some((arg, index) => arg !== "--plugin" && rest[index - 1] !== "--plugin")
  ) {
    console.error(
      `Usage: pnpm smoke:live [--sign-in] [--plugin ${Object.keys(PLANS).join("|")}]...`,
    );
    process.exitCode = 2;
    return;
  }
  const log = { failures: [], refused: [] };
  globalThis.fetch = createReadOnlyFetch(globalThis.fetch.bind(globalThis), log);
  const counts = { PASS: 0, FAIL: 0, SKIP: 0, INFO: 0 };
  const report = (name, outcome, detail) => {
    counts[outcome] += 1;
    console.log(`${outcome.padEnd(4)}  ${name.padEnd(46)}  ${detail}`);
  };
  for (const pluginId of requested.length > 0 ? requested : Object.keys(PLANS)) {
    await smokePlugin(pluginId, PLANS[pluginId], log, report, { signInFirst });
  }
  console.log(`\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped`);
  if (counts.FAIL > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2)).catch((error) => {
    // Never let Node print an unexpected error, which could carry account content.
    console.error(`Live smoke stopped unexpectedly (${error?.name ?? "error"}).`);
    process.exitCode = 1;
  });
}
