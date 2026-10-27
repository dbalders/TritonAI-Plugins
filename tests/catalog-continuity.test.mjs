import assert from "node:assert/strict";
import * as Fs from "node:fs/promises";
import test from "node:test";
import { sha256 } from "./fixtures/broker-host.mjs";

// Canonical catalogs from reviewed Plugins 218f616; migration changes ABI, not tool authority.
const expected = {
  github: {
    tools: 29,
    sha256: "c841f1e2f74a8c3b792c7474d5b06fc7f396f95cbe44876d973ba7d84b098c78",
  },
  "google-workspace": {
    tools: 38,
    sha256: "0c24ac5b586f17ef1f7cf1b9eab1a4f77a7547ab8656470503289e45f50c49f8",
  },
  "jira-data-center": {
    tools: 21,
    sha256: "e84cc8434991930ef2e37bc3fe1c36fc910a8d0edeff32b4bd9df16d9e81689d",
  },
  "kuali-build": {
    tools: 11,
    sha256: "97d49d7edaa3c286a7c634d0f2a3f318d2697d9bf168fae14402776e09ffa564",
  },
  lucid: {
    tools: 30,
    sha256: "c8f7824c753ab8fd8e679393202940b7caf1075462ac58b7cef817dcae3d9bda",
  },
  "microsoft-365": {
    tools: 26,
    sha256: "3ac8211bc56bf6ca72b06f569505626c1cd4fbaf7e542a36480979385f4e07e9",
  },
  n8n: {
    tools: 60,
    sha256: "a43d3713e4953affeaee11543b8cb162fb62b95eb3049949e32c9340a39f3b92",
  },
  "synthetic-api-key": {
    tools: 2,
    sha256: "d23f4818e4334b23725ac6e53e25fd860141e6c9e8a9a7d664586066f6abc8b8",
  },
  "synthetic-readonly": {
    tools: 1,
    sha256: "f0526b6c35b09ca1a14b2095ceba229e17b89fbe28ed62406c00dd5a41818cbb",
  },
  tableau: {
    tools: 14,
    sha256: "70d0adcdd3061f63cb92c23eda1ac9976a79365dd3a2e173a669e151f2d8b372",
  },
  "ucsd-assistant": {
    tools: 12,
    sha256: "0560ea6472206bf825400878efb81ccfdf19d7817a9e048a814bc2b1f4597ee7",
  },
};
for (const [id, snapshot] of Object.entries(expected)) {
  test(
    id + ": broker migration preserves exact catalog, schemas and capability bindings",
    async () => {
      const manifest = JSON.parse(
        await Fs.readFile(
          new URL("../plugins/" + id + "/.tritonai-plugin/plugin.json", import.meta.url),
          "utf8",
        ),
      );
      assert.equal(manifest.tools.length, snapshot.tools);
      assert.equal(
        sha256({
          tools: manifest.tools,
          capabilities: manifest.capabilities,
          configurationSchema: manifest.configurationSchema ?? null,
        }),
        snapshot.sha256,
      );
    },
  );
}
