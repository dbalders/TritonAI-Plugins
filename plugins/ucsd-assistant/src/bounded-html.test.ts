import { parse, parseFragment, serialize } from "parse5";
import { describe, expect, it } from "vite-plus/test";
import { HtmlLimitError, htmlBudget, parseBoundedHtml } from "./bounded-html.js";

const budget = () => htmlBudget(() => undefined);

describe("bounded HTML parsing", () => {
  it("bounds attributes accumulated by repeated body tags before costly adoption", async () => {
    const source =
      Array.from(
        { length: 350 },
        (_, batch) =>
          `<body ${Array.from({ length: 512 }, (_, i) => `a${batch * 512 + i}`).join(" ")}>`,
      ).join("") + "<body>".repeat(30_000);
    const started = performance.now();
    await expect(parseBoundedHtml(source, budget())).rejects.toBeInstanceOf(HtmlLimitError);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("charges repeated adoption of existing attributes even for empty body tokens", async () => {
    const source =
      `<body ${Array.from({ length: 512 }, (_, i) => `a${i}`).join(" ")}>` +
      "<body>".repeat(10_000);
    await expect(parseBoundedHtml(source, budget())).rejects.toBeInstanceOf(HtmlLimitError);
  });

  it("preserves ordinary repeated body attribute semantics", async () => {
    const source =
      '<body class="first" data-a="one"><body class="later" data-b="two"><p>Campus</p>';
    expect(serialize(await parseBoundedHtml(source, budget()))).toBe(
      serialize(parse(source, { scriptingEnabled: false })),
    );
  });

  it.each([false, true])(
    "bounds actual parser depth, including fragments: %s",
    async (fragment) => {
      for (const tag of ["div", "template", "b", "svg"]) {
        const source = `<${tag}>`.repeat(500) + "text" + `</${tag}>`.repeat(500);
        await expect(parseBoundedHtml(source, budget(), fragment)).rejects.toBeInstanceOf(
          HtmlLimitError,
        );
      }
    },
  );

  it.each([false, true])("bounds wide shallow trees: fragment %s", async (fragment) => {
    const started = performance.now();
    await expect(
      parseBoundedHtml("<br>".repeat(25_000), budget(), fragment),
    ).rejects.toBeInstanceOf(HtmlLimitError);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it.each([
    "<html>".repeat(50_000), // Most of these tags would be ignored by the tree builder.
    `<div ${Array.from({ length: 10_000 }, (_, i) => `a${i}=x`).join(" ")}>text</div>`,
    `<div ${"duplicate=x ".repeat(10_000)}>text</div>`,
    `<div title='>' ${Array.from({ length: 10_000 }, (_, i) => `a${i}=x`).join(" ")}>text</div>`,
    `<div ${Array.from({ length: 20_000 }, (_, i) => `a${i}=">"`).join(" ")}>x</div>`,
    `<div bad=a" ${Array.from({ length: 20_000 }, (_, i) => `a${i}=">"`).join(" ")}>x</div>`,
  ])("bounds ignored tokens and attribute work during parsing: %.30s", async (source) => {
    const started = performance.now();
    await expect(parseBoundedHtml(source, budget())).rejects.toBeInstanceOf(HtmlLimitError);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it.each([
    "<title>Travel &amp; finance</title><p>Short public policy.",
    "before<table><tr><td>Campus</table>after",
    "<p><b>bold<i>both</b>italic</i><p>next",
    "<template><div>hidden</div></template><p>visible",
    "<svg><foreignObject><p>Campus</p></foreignObject></svg>",
    "<noscript><p>Fallback</p></noscript><main>Public article</main>",
    `<p>${"a".repeat(8_180)}&amp; &#x1f600; <b>boundary</b></p>`,
  ])("preserves parse5 HTML and fragment semantics: %.40s", async (source) => {
    expect(serialize(await parseBoundedHtml(source, budget()))).toBe(
      serialize(parse(source, { scriptingEnabled: false })),
    );
    expect(serialize(await parseBoundedHtml(source, budget(), true))).toBe(
      serialize(parseFragment(source, { scriptingEnabled: false })),
    );
  });

  it("allows a large shallow public page and raw text spanning many input chunks", async () => {
    const source = `<script>${"x".repeat(100_000)}</script><main>${`<p>${"Policy ".repeat(150)}</p>`.repeat(1_000)}</main>`;
    const started = performance.now();
    expect(serialize(await parseBoundedHtml(source, budget()))).toBe(serialize(parse(source)));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("yields for real cancellation while parsing a long text token", async () => {
    const controller = new AbortController();
    const pending = parseBoundedHtml(
      `<p>${"Campus policy ".repeat(80_000)}</p>`,
      htmlBudget(() => controller.signal.throwIfAborted()),
    );
    const reason = new Error("cancel parsing");
    setImmediate(() => controller.abort(reason));
    await expect(pending).rejects.toBe(reason);
  });

  it("shares the node budget across separate knowledge title/snippet parses", async () => {
    const shared = budget();
    await parseBoundedHtml("<br>".repeat(12_000), shared, true);
    await expect(parseBoundedHtml("<br>".repeat(12_000), shared, true)).rejects.toBeInstanceOf(
      HtmlLimitError,
    );
  });

  it("shares ignored-token work across knowledge title/snippet parses", async () => {
    const shared = budget();
    const source = `<select>${"<div></div>".repeat(11_000)}</select>`;
    await parseBoundedHtml(source, shared, true);
    await expect(parseBoundedHtml(source, shared, true)).rejects.toBeInstanceOf(HtmlLimitError);
  });

  it("bounds tokenizer work even when alternating text tokens merge into one node", async () => {
    await expect(
      parseBoundedHtml(`<p>${"a ".repeat(600_000)}</p>`, budget()),
    ).rejects.toBeInstanceOf(HtmlLimitError);
  });
});
