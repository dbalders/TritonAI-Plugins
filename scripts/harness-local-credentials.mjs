// Reads a connected account's stored credential, and the plugin's build configuration, from an
// installed TritonAI Harness desktop app on this Mac. Nothing here writes to Harness state or prints
// a secret. The Harness data key is unwrapped through the macOS Keychain, so every run asks the
// maintainer to allow access ("Allow", not "Always Allow").
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";

// Electron's safeStorage service name comes from the app's package name, which the stable and
// nightly builds share. The Dev build uses its own item and is not a smoke source.
const KEYCHAIN_SERVICE = "TritonAI Harness Safe Storage";

export function harnessProfiles(home = Os.homedir()) {
  return [
    {
      name: "stable",
      base: Path.join(home, ".tritonai-harness"),
      app: "/Applications/TritonAI Harness.app",
    },
    {
      name: "nightly",
      base: Path.join(home, ".tritonai-harness-nightly"),
      app: "/Applications/TritonAI Harness (Nightly).app",
    },
  ];
}

export function storedSecretName(pluginId, suffix) {
  return `integration-${pluginId}--${suffix}`;
}

export function findConnectedProfile(pluginId, suffix, profiles = harnessProfiles()) {
  return (
    profiles.find((profile) =>
      Fs.existsSync(
        Path.join(profile.base, "userdata", "secrets", `${storedSecretName(pluginId, suffix)}.bin`),
      ),
    ) ?? null
  );
}

let safeStoragePassword = null;

function keychainPassword() {
  if (safeStoragePassword !== null) return safeStoragePassword;
  if (process.platform !== "darwin") {
    throw new Error("Reading Harness credentials is supported only on macOS.");
  }
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Leave time to answer the Keychain prompt, but do not hang when nobody is there.
      timeout: 180_000,
    },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Keychain access to "${KEYCHAIN_SERVICE}" was denied or unavailable.`);
  }
  safeStoragePassword = result.stdout.trim();
  return safeStoragePassword;
}

// Chromium OSCrypt on macOS, which Electron safeStorage uses: "v10" + AES-128-CBC with a
// PBKDF2-SHA1 key derived from the Keychain password.
function safeStorageDecrypt(bytes) {
  if (bytes.subarray(0, 3).toString("latin1") !== "v10") {
    throw new Error("The wrapped Harness key is not in the expected safeStorage format.");
  }
  const key = Crypto.pbkdf2Sync(keychainPassword(), "saltysalt", 1003, 16, "sha1");
  const decipher = Crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]).toString("utf8");
}

function dataKeys(profile) {
  let keyring;
  try {
    keyring = JSON.parse(
      safeStorageDecrypt(
        Fs.readFileSync(Path.join(profile.base, "userdata", "secret-store-key.v1.bin")),
      ),
    );
  } catch (cause) {
    // The cause can carry decrypted bytes; keep only a fixed message.
    if (cause instanceof Error && cause.message.startsWith("Keychain")) throw cause;
    throw new Error(`The ${profile.name} Harness secret-store key could not be unwrapped.`);
  }
  return [keyring.active, ...(keyring.previous ?? [])].map((key) => Buffer.from(key, "base64"));
}

// Harness ServerSecretStore envelope: "T3SECRET", version 1, 12-byte nonce, 16-byte GCM tag,
// ciphertext, with the full secret name as associated data.
function openEnvelope(name, envelope, keys) {
  const magic = Buffer.from("T3SECRET");
  if (!envelope.subarray(0, magic.length).equals(magic) || envelope[magic.length] !== 1) {
    throw new Error(`${name} is not a supported Harness secret envelope.`);
  }
  const nonceStart = magic.length + 1;
  const tagStart = nonceStart + 12;
  const dataStart = tagStart + 16;
  for (const key of keys) {
    try {
      const decipher = Crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        envelope.subarray(nonceStart, tagStart),
      );
      decipher.setAAD(Buffer.from(name, "utf8"));
      decipher.setAuthTag(envelope.subarray(tagStart, dataStart));
      return Buffer.concat([decipher.update(envelope.subarray(dataStart)), decipher.final()]);
    } catch {
      // Try the next rotation key.
    }
  }
  throw new Error(`${name} could not be decrypted with the ${keys.length} Harness key(s).`);
}

export function readStoredSecret(profile, pluginId, suffix) {
  const name = storedSecretName(pluginId, suffix);
  const envelope = Fs.readFileSync(Path.join(profile.base, "userdata", "secrets", `${name}.bin`));
  return new Uint8Array(openEnvelope(name, envelope, dataKeys(profile)));
}

// Read one file out of an Electron asar archive: a pickled header length, a JSON index, then data.
function readAsarFiles(archive, directory, predicate) {
  const fd = Fs.openSync(archive, "r");
  try {
    const head = Buffer.alloc(16);
    Fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const index = Buffer.alloc(head.readUInt32LE(12));
    Fs.readSync(fd, index, 0, index.length, 16);
    let node = JSON.parse(index.toString("utf8"));
    for (const part of directory.split("/")) node = node?.files?.[part];
    const results = [];
    for (const [name, entry] of Object.entries(node?.files ?? {})) {
      if (entry.files || entry.unpacked || !predicate(name)) continue;
      const bytes = Buffer.alloc(entry.size);
      Fs.readSync(fd, bytes, 0, entry.size, 8 + headerSize + Number(entry.offset));
      results.push(bytes.toString("utf8"));
    }
    return results;
  } finally {
    Fs.closeSync(fd);
  }
}

// The Harness build embeds its private, package-ID-keyed plugin configuration as a JSON literal.
export function readPluginConfiguration(profile, pluginId) {
  const marker = "\nconst buildConfiguration = ";
  const archive = Path.join(profile.app, "Contents", "Resources", "app.asar");
  for (const source of readAsarFiles(archive, "apps/server/dist", (name) =>
    name.endsWith(".mjs"),
  )) {
    const start = source.indexOf(marker);
    if (start === -1) continue;
    const end = source.indexOf("\n};", start);
    const configuration = JSON.parse(source.slice(start + marker.length, end + 2));
    if (Object.hasOwn(configuration, pluginId)) return configuration[pluginId];
  }
  throw new Error(`${profile.app} has no build configuration for ${pluginId}.`);
}
