import { describe, expect, it } from "vite-plus/test";

import { parseMcpPayload } from "./transport.ts";

const stream = (text: string) =>
  new Response(text, { headers: { "content-type": "text/event-stream" } });

describe("parseMcpPayload", () => {
  it("skips notifications and unknown fields, and accepts a bare data line", async () => {
    const body = [
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      "",
      "id: 7",
      "retry: 1000",
      "x-vendor: ignored",
      'data: {"jsonrpc":"2.0","id":"3",',
      "data",
      'data: "result":{"ok":true}}',
      "",
      "",
    ].join("\r\n");
    const response = stream(body);
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    expect(parseMcpPayload(response, bytes, "3", "fixture")).toEqual({
      jsonrpc: "2.0",
      id: "3",
      result: { ok: true },
    });
  });

  it("refuses a server-initiated request and a duplicate response", async () => {
    const request = stream(
      'data: {"jsonrpc":"2.0","id":"9","method":"sampling/createMessage"}\n\n',
    );
    await expect(async () =>
      parseMcpPayload(request, new Uint8Array(await request.clone().arrayBuffer()), "1", "fixture"),
    ).rejects.toThrow(/interactive MCP response/u);
    const twice = stream(
      'data: {"jsonrpc":"2.0","id":"1","result":{}}\n\ndata: {"jsonrpc":"2.0","id":"1","result":{}}\n\n',
    );
    await expect(async () =>
      parseMcpPayload(twice, new Uint8Array(await twice.clone().arrayBuffer()), "1", "fixture"),
    ).rejects.toThrow(/duplicate/u);
  });
});
