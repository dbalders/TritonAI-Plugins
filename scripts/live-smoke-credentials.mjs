// Credentials for the live smoke. The OAuth client configuration comes from an installed TritonAI
// Harness app, the same one its connections use. The smoke's own sign-in is kept in a login Keychain
// item that this script creates, separate from Harness's connections; no value is ever printed or
// passed on a command line.
import { spawnSync } from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const KEYCHAIN_SERVICE = "TritonAI Plugins Live Smoke";
const LOGIN_KEYCHAIN = Path.join(Os.homedir(), "Library", "Keychains", "login.keychain-db");
// `security -i` reads at most 4096 bytes per command line and would store a truncated value.
const MAX_INTERACTIVE_COMMAND = 4000;
const HARNESS_APPS = [
  "/Applications/TritonAI Harness.app",
  "/Applications/TritonAI Harness (Nightly).app",
];

function security(args, input) {
  if (process.platform !== "darwin")
    throw new Error("The live smoke stores its sign-in in the macOS Keychain.");
  return spawnSync("/usr/bin/security", args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    timeout: 60_000,
  });
}

/** A package-scoped secret store backed by this script's own Keychain items. */
export function keychainSecretStore(pluginId) {
  const account = (name) => `${pluginId}--${name}`;
  const read = (name) => {
    const result = security([
      "find-generic-password",
      "-w",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account(name),
      LOGIN_KEYCHAIN,
    ]);
    return result.status === 0 && result.stdout.trim()
      ? new Uint8Array(Buffer.from(result.stdout.trim(), "base64"))
      : null;
  };
  return {
    has: (name) => read(name) !== null,
    store: {
      get: (name) =>
        Effect.try({
          try: () => Option.fromNullishOr(read(name)),
          catch: () => new Error("Keychain read failed."),
        }),
      set: (name, value) =>
        Effect.try({
          try: () => {
            // `security -i` takes the command on stdin, keeping the value off the process list.
            const command = `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account(name)}" -w ${Buffer.from(value).toString("base64")} "${LOGIN_KEYCHAIN}"\n`;
            if (Buffer.byteLength(command) > MAX_INTERACTIVE_COMMAND) throw new Error();
            if (security(["-i"], command).status !== 0) throw new Error();
            if (!Buffer.from(read(name) ?? []).equals(Buffer.from(value))) throw new Error();
          },
          catch: () => new Error("Keychain write failed."),
        }),
      remove: (name) =>
        Effect.sync(
          () =>
            void security([
              "delete-generic-password",
              "-s",
              KEYCHAIN_SERVICE,
              "-a",
              account(name),
              LOGIN_KEYCHAIN,
            ]),
        ),
    },
  };
}

// Read the .mjs files of one directory out of an Electron asar archive: a pickled header length,
// a JSON index, then file data.
function readAsarModules(archive, directory) {
  const fd = Fs.openSync(archive, "r");
  try {
    const head = Buffer.alloc(16);
    Fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const index = Buffer.alloc(head.readUInt32LE(12));
    Fs.readSync(fd, index, 0, index.length, 16);
    let node = JSON.parse(index.toString("utf8"));
    for (const part of directory.split("/")) node = node?.files?.[part];
    const modules = [];
    for (const [name, entry] of Object.entries(node?.files ?? {})) {
      if (entry.files || entry.unpacked || !name.endsWith(".mjs")) continue;
      const bytes = Buffer.alloc(entry.size);
      Fs.readSync(fd, bytes, 0, entry.size, 8 + headerSize + Number(entry.offset));
      modules.push(bytes.toString("utf8"));
    }
    return modules;
  } finally {
    Fs.closeSync(fd);
  }
}

// A Harness build embeds its private, package-ID-keyed plugin configuration as a JSON literal.
export function readPluginConfiguration(pluginId) {
  const marker = "\nconst buildConfiguration = ";
  for (const app of HARNESS_APPS.filter((path) => Fs.existsSync(path))) {
    const archive = Path.join(app, "Contents", "Resources", "app.asar");
    for (const source of readAsarModules(archive, "apps/server/dist")) {
      const start = source.indexOf(marker);
      if (start === -1) continue;
      const configuration = JSON.parse(
        source.slice(start + marker.length, source.indexOf("\n};", start) + 2),
      );
      if (Object.hasOwn(configuration, pluginId)) return configuration[pluginId];
    }
  }
  throw new Error(`No installed TritonAI Harness app has a build configuration for ${pluginId}.`);
}
