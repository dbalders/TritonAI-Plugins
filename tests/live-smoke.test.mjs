import assert from "node:assert/strict";
import * as Fs from "node:fs";
import test from "node:test";

import { checkPlan, createReadOnlyFetch, PLANS } from "../scripts/live-smoke.mjs";

test("the live smoke covers exactly each plugin's manifest read tools", () => {
  for (const [pluginId, plan] of Object.entries(PLANS)) {
    const manifest = JSON.parse(
      Fs.readFileSync(
        new URL(`../plugins/${pluginId}/.tritonai-plugin/plugin.json`, import.meta.url),
      ),
    );
    assert.deepEqual(checkPlan(manifest, plan), [], pluginId);
  }
});

test("the live smoke refuses every request except reads and token refreshes", async () => {
  const log = { failures: [], refused: [] };
  const sent = [];
  const guarded = createReadOnlyFetch(async (input, init) => {
    sent.push(init?.method ?? "GET");
    return new Response("{}");
  }, log);
  await guarded("https://graph.microsoft.com/v1.0/me/messages");
  await guarded("https://oauth2.googleapis.com/token", { method: "POST" });
  for (const [url, method] of [
    ["https://graph.microsoft.com/v1.0/me/messages/x/move", "POST"],
    ["https://www.googleapis.com/drive/v3/files/x", "PATCH"],
    ["https://www.googleapis.com/drive/v3/files/x", "DELETE"],
    ["https://oauth2.googleapis.com/revoke", "POST"],
  ]) {
    await assert.rejects(guarded(url, { method }), TypeError);
  }
  await assert.rejects(
    guarded(new Request("https://gmail.googleapis.com/x", { method: "PUT" })),
    TypeError,
  );
  assert.deepEqual(sent, ["GET", "POST"]);
  assert.equal(log.refused.length, 5);
});
