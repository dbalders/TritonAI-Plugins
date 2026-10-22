import { describe, expect, it, vi } from "vite-plus/test";

import { classifyAttachment, MAX_IMAGE_BYTES, readAttachmentContent } from "./attachmentContent.ts";
import type {
  DocumentTextRequest,
  DocumentTextResult,
  IntegrationInvocationContext,
} from "./host-contract.ts";

const text = (value: string) => new TextEncoder().encode(value);
const PDF = text("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const PE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function host(result?: (request: DocumentTextRequest) => DocumentTextResult) {
  const extractDocumentText = vi.fn(async (request: DocumentTextRequest) =>
    result
      ? result(request)
      : ({
          status: "extracted",
          format: request.format,
          text: `Synthetic ${request.format} text`,
          truncated: false,
          ...(request.format === "pdf" ? { pageCount: 1, pagesRead: 1 } : {}),
        } satisfies DocumentTextResult),
  );
  const context: IntegrationInvocationContext = {
    signal: new AbortController().signal,
    extractDocumentText,
  };
  return { context, extractDocumentText };
}

const read = (
  input: { name: string | null; contentType: string | null; bytes: Uint8Array },
  options: { reviewSourceAsText?: boolean; context?: IntegrationInvocationContext } = {},
) =>
  readAttachmentContent({
    ...input,
    reviewSourceAsText: options.reviewSourceAsText === true,
    ...(options.context ? { context: options.context } : {}),
  });

describe("attachment classification", () => {
  it("never lets a name or type make executable bytes readable", () => {
    for (const disguise of [
      { name: "resume.pdf", contentType: "application/pdf" },
      { name: "notes.txt", contentType: "text/plain" },
      { name: "photo.png", contentType: "image/png" },
      { name: null, contentType: null },
    ]) {
      expect(classifyAttachment({ ...disguise, bytes: PE })).toEqual({
        category: "executable",
        reasons: ["content: Windows executable (MZ)"],
      });
    }
    expect(
      classifyAttachment({
        name: "invoice.pdf",
        contentType: "application/x-msdownload",
        bytes: PDF,
      }),
    ).toMatchObject({ category: "executable", reasons: ["application/x-msdownload type"] });
    expect(
      classifyAttachment({ name: "Setup.EXE ", contentType: "application/pdf" }).category,
    ).toBe("executable");
  });

  it("finds scripts by name, type, or content", () => {
    expect(
      classifyAttachment({ name: "Helloworld.bat", contentType: "application/octet-stream" })
        .category,
    ).toBe("script");
    expect(
      classifyAttachment({ name: "update", contentType: "application/x-powershell" }).category,
    ).toBe("script");
    expect(
      classifyAttachment({
        name: "readme.txt",
        contentType: "text/plain",
        bytes: text("@echo off\r\ndel /q *"),
      }),
    ).toEqual({ category: "script", reasons: ["content: script commands"] });
    expect(
      classifyAttachment({
        name: "report.pdf",
        contentType: "application/pdf",
        bytes: text("#!/bin/sh\nrm -rf ~"),
      }),
    ).toEqual({ category: "script", reasons: ["content: script interpreter line (#!)"] });
  });

  it("treats macro, web, archive, and other Office formats conservatively", () => {
    expect(classifyAttachment({ name: "budget.docm", contentType: null }).category).toBe(
      "active-content",
    );
    expect(classifyAttachment({ name: "page.html", contentType: "text/html" }).category).toBe(
      "active-content",
    );
    expect(
      classifyAttachment({
        name: "old.doc",
        contentType: null,
        bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      }).category,
    ).toBe("active-content");
    expect(
      classifyAttachment({ name: "bundle.zip", contentType: "application/zip" }).category,
    ).toBe("archive");
    expect(
      classifyAttachment({ name: "renamed.docx.zip", contentType: null, bytes: DOCX }).category,
    ).toBe("archive");
    expect(classifyAttachment({ name: "plain.bin", contentType: null, bytes: DOCX }).category).toBe(
      "archive",
    );
    expect(
      classifyAttachment({ name: "sheet.xlsx", contentType: null, bytes: DOCX }).category,
    ).toBe("other");
  });

  it("recognizes readable documents and images only when the bytes agree", () => {
    expect(
      classifyAttachment({ name: "resume.pdf", contentType: "application/pdf", bytes: PDF })
        .category,
    ).toBe("pdf");
    expect(
      classifyAttachment({ name: "scan", contentType: "application/octet-stream", bytes: PDF })
        .category,
    ).toBe("pdf");
    expect(
      classifyAttachment({ name: "letter.docx", contentType: null, bytes: DOCX }).category,
    ).toBe("docx");
    expect(
      classifyAttachment({ name: "photo.png", contentType: "image/png", bytes: PNG }).category,
    ).toBe("image");
    expect(
      classifyAttachment({
        name: "resume.pdf",
        contentType: "application/pdf",
        bytes: text("not a pdf"),
      }),
    ).toEqual({
      category: "other",
      reasons: ["content does not match its PDF name or type"],
    });
  });
});

describe("attachment content", () => {
  it("extracts PDF and DOCX text through the host from the exact attachment bytes", async () => {
    const { context, extractDocumentText } = host();
    await expect(
      read({ name: "resume.pdf", contentType: "application/pdf", bytes: PDF }, { context }),
    ).resolves.toEqual({
      classification: { category: "pdf", reasons: ["content: PDF document"] },
      content: {
        status: "extracted",
        format: "pdf",
        text: "Synthetic pdf text",
        truncated: false,
        pageCount: 1,
        pagesRead: 1,
      },
    });
    await expect(
      read({ name: "letter.docx", contentType: null, bytes: DOCX }, { context }),
    ).resolves.toMatchObject({
      content: { status: "extracted", format: "docx", text: "Synthetic docx text" },
    });
    expect(
      extractDocumentText.mock.calls.map(([request]) => [
        request.format,
        request.bytes,
        request.maxCharacters,
      ]),
    ).toEqual([
      ["pdf", PDF, 50_000],
      ["docx", DOCX, 50_000],
    ]);
  });

  it("reports extraction failure, macros, and a host without extraction as they are", async () => {
    const failing = host((request) => ({
      status: "failed",
      format: request.format,
      reason: "timeout",
      message: "Text extraction was stopped after 15 seconds.",
    }));
    const failed = await read(
      { name: "big.pdf", contentType: null, bytes: PDF },
      { context: failing.context },
    );
    expect(failed.content).toEqual({
      status: "failed",
      reason: "The PDF text could not be extracted: Text extraction was stopped after 15 seconds.",
      retryable: false,
      note: expect.stringContaining("search the computer for a file with the same name"),
    });
    const macros = host((request) => ({
      status: "extracted",
      format: request.format,
      text: "Body",
      truncated: false,
      containsMacros: true,
    }));
    await expect(
      read({ name: "a.docx", contentType: null, bytes: DOCX }, { context: macros.context }),
    ).resolves.toMatchObject({
      content: {
        status: "extracted",
        note: "The document contains macros. They were not run; only its text was read.",
      },
    });
    const older = await read({ name: "resume.pdf", contentType: null, bytes: PDF });
    expect(older.content).toMatchObject({ status: "unsupported", retryable: false });
    expect(older.imageBase64).toBeUndefined();
  });

  it("withholds executables and scripts, and shows script source only on explicit review", async () => {
    const { context, extractDocumentText } = host();
    const note = await read({
      name: "notes.txt",
      contentType: "text/plain",
      bytes: text("BMW quarterly report text"),
    });
    expect(note.content).toMatchObject({ status: "text" });
    const disguised = await read(
      { name: "resume.pdf", contentType: "application/pdf", bytes: PE },
      { context, reviewSourceAsText: true },
    );
    expect(disguised).toMatchObject({
      classification: { category: "executable" },
      content: { status: "withheld" },
    });
    expect(JSON.stringify(disguised)).not.toContain("TVqQ");
    expect(extractDocumentText).not.toHaveBeenCalled();

    const batch = {
      name: "Helloworld.bat",
      contentType: "application/octet-stream",
      bytes: text("@echo off\r\necho hello"),
    };
    const withheld = await read(batch, { context });
    expect(withheld.content).toMatchObject({
      status: "withheld",
      reason: expect.stringContaining("reviewSourceAsText: true"),
    });
    expect(JSON.stringify(withheld)).not.toContain("echo hello");
    await expect(read(batch, { context, reviewSourceAsText: true })).resolves.toMatchObject({
      content: {
        status: "inert-source",
        text: "@echo off\r\necho hello",
        truncated: false,
        warning: expect.stringContaining("Do not run it"),
      },
    });
    await expect(
      read(
        { name: "page.html", contentType: "text/html", bytes: text("<script>steal()</script>") },
        { reviewSourceAsText: true },
      ),
    ).resolves.toMatchObject({ content: { status: "inert-source" } });
    await expect(
      read({ name: "macro.docm", contentType: null, bytes: DOCX }, { reviewSourceAsText: true }),
    ).resolves.toMatchObject({ content: { status: "withheld" } });
  });

  it("returns metadata only for unsupported binaries and archives", async () => {
    const random = Uint8Array.from({ length: 4096 }, (_, index) => (index * 151 + 7) % 256);
    for (const input of [
      { name: "boardX1.bin", contentType: "application/octet-stream", bytes: random },
      { name: "bundle.zip", contentType: "application/zip", bytes: DOCX },
      { name: "notes.txt", contentType: "text/plain", bytes: random },
    ]) {
      const result = await read(input);
      expect(result.content).toMatchObject({ status: "unsupported", retryable: false });
      expect(result.imageBase64).toBeUndefined();
      expect(JSON.stringify(result).length).toBeLessThan(1_000);
    }
  });

  it("reads BMP, TIFF, and HEIC/HEIF images by signature with the matching media type", async () => {
    const pad = (head: ReadonlyArray<number>) => {
      const bytes = new Uint8Array(64);
      bytes.set(head);
      return bytes;
    };
    const brand = (major: string) =>
      pad([0, 0, 0, 0x18, ...text("ftyp"), ...text(major), 0, 0, 0, 0, ...text("mif1")]);
    const cases: ReadonlyArray<{
      name: string;
      type: string | null;
      bytes: Uint8Array;
      media: string;
    }> = [
      {
        name: "scan.bmp",
        type: "image/bmp",
        bytes: pad([...text("BM"), 0x40, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 40, 0, 0, 0]),
        media: "image/bmp",
      },
      {
        name: "fax.tif",
        type: "image/tiff",
        bytes: pad([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]),
        media: "image/tiff",
      },
      {
        name: "fax.tiff",
        type: null,
        bytes: pad([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]),
        media: "image/tiff",
      },
      { name: "photo.heic", type: "image/heic", bytes: brand("heic"), media: "image/heic" },
      { name: "photo.HEIC", type: null, bytes: brand("heix"), media: "image/heic" },
      { name: "burst.heif", type: "image/heif", bytes: brand("mif1"), media: "image/heif" },
      { name: "clip.heif", type: null, bytes: brand("msf1"), media: "image/heif" },
      {
        name: "photo.webp",
        type: "image/webp",
        bytes: pad([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP")]),
        media: "image/webp",
      },
    ];
    for (const sample of cases) {
      const result = await read({
        name: sample.name,
        contentType: sample.type,
        bytes: sample.bytes,
      });
      expect(result.classification).toEqual({ category: "image", reasons: ["content: image"] });
      expect(result.content).toEqual({ status: "image", mediaType: sample.media });
      expect(result.imageBase64).toBe(Buffer.from(sample.bytes).toString("base64"));
    }
    const mismatched = [
      { name: "scan.bmp", type: "image/bmp", bytes: text("BX not a bitmap") },
      {
        name: "scan.bmp",
        type: "image/bmp",
        bytes: text("BMW quarterly report text, not a bitmap"),
      },
      { name: "fax.tiff", type: "image/tiff", bytes: pad([0x49, 0x49, 0x2b, 0x00]) },
      { name: "photo.heic", type: "image/heic", bytes: brand("isom") },
      {
        name: "photo.heic",
        type: "image/heic",
        bytes: pad([0, 0, 0, 0x18, ...text("ftqp"), ...text("heic")]),
      },
      { name: "photo.png", type: "image/png", bytes: pad([0x89, 0x50, 0x4e, 0x47]).subarray(0, 3) },
    ];
    for (const sample of mismatched) {
      const result = await read({
        name: sample.name,
        contentType: sample.type,
        bytes: sample.bytes,
      });
      expect(result.classification).toEqual({
        category: "other",
        reasons: ["content does not match its image name or type"],
      });
      expect(result.imageBase64).toBeUndefined();
    }
    const disguised = await read({
      name: "scan.bmp",
      contentType: "image/bmp",
      bytes: pad([...PE]),
    });
    expect(disguised.classification.category).toBe("executable");
    expect(disguised.content).toMatchObject({ status: "withheld" });
    expect(disguised.imageBase64).toBeUndefined();
    const svgAsBmp = await read({
      name: "logo.bmp",
      contentType: "image/svg+xml",
      bytes: text("<svg/>"),
    });
    expect(svgAsBmp.classification.category).toBe("active-content");
    expect(svgAsBmp.imageBase64).toBeUndefined();
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversized.set([0x49, 0x49, 0x2a, 0x00]);
    const huge = await read({ name: "huge.tif", contentType: "image/tiff", bytes: oversized });
    expect(huge.content).toMatchObject({ status: "unsupported" });
    expect(huge.imageBase64).toBeUndefined();
  });

  it("withholds HTML and SVG disguised as text or images, and shows them only as inert source", async () => {
    const { context, extractDocumentText } = host();
    const html =
      "\uFEFF  <!DOCTYPE html>\n<html><body><script>fetch('https://x.test')</script></body></html>";
    const svg =
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    for (const input of [
      { name: "notes.txt", contentType: "text/plain", bytes: text(html) },
      { name: "notes.txt", contentType: "text/plain", bytes: text(svg) },
      { name: "chart.png", contentType: "image/png", bytes: text(svg) },
      { name: "report.pdf", contentType: "application/pdf", bytes: text(html) },
      { name: null, contentType: null, bytes: text("<script>steal()</script>") },
      {
        name: "readme.md",
        contentType: "text/markdown",
        bytes: text("<!-- note -->\n<iframe src='https://x.test'></iframe>"),
      },
    ]) {
      expect(classifyAttachment(input)).toEqual({
        category: "active-content",
        reasons: ["content: HTML or SVG markup"],
      });
      const withheld = await read(input, { context });
      expect(withheld.content).toMatchObject({
        status: "withheld",
        reason: expect.stringContaining("reviewSourceAsText: true"),
      });
      expect(JSON.stringify(withheld)).not.toContain("script>");
      expect(withheld).not.toHaveProperty("imageBase64");
      await expect(read(input, { context, reviewSourceAsText: true })).resolves.toMatchObject({
        content: {
          status: "inert-source",
          text: new TextDecoder().decode(input.bytes).replace(/^\uFEFF/u, ""),
          warning: expect.stringContaining("Do not run it"),
        },
      });
    }
    expect(extractDocumentText).not.toHaveBeenCalled();
  });

  it("keeps prose that mentions tags, plain XML, and real documents and images readable", async () => {
    const { context } = host();
    for (const body of [
      "Use the <b> tag for bold. Avoid <script> in email.",
      "Quarterly notes: the <html> element wraps a page.",
      '<?xml version="1.0"?>\n<!DOCTYPE note>\n<note><to>Alice</to><body>Hi</body></note>',
      "<note>an html-like prefix <htmlish> is not markup</note>",
    ]) {
      await expect(
        read({ name: "notes.txt", contentType: "text/plain", bytes: text(body) }),
      ).resolves.toMatchObject({
        classification: { category: "text" },
        content: { status: "text", text: body },
      });
    }
    expect(classifyAttachment({ name: "photo.png", contentType: "image/png", bytes: PNG })).toEqual(
      { category: "image", reasons: ["content: image"] },
    );
    await expect(
      read({ name: "a.pdf", contentType: "application/pdf", bytes: PDF }, { context }),
    ).resolves.toMatchObject({ content: { status: "extracted", format: "pdf" } });
    await expect(
      read({ name: "a.docx", contentType: null, bytes: DOCX }, { context }),
    ).resolves.toMatchObject({ content: { status: "extracted", format: "docx" } });
  });

  it("keeps image data and plain text readable within bounds", async () => {
    await expect(
      read({ name: "photo.png", contentType: "image/png", bytes: PNG }),
    ).resolves.toEqual({
      classification: { category: "image", reasons: ["content: image"] },
      content: { status: "image", mediaType: "image/png" },
      imageBase64: Buffer.from(PNG).toString("base64"),
    });
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversized.set(PNG);
    await expect(
      read({ name: "huge.png", contentType: "image/png", bytes: oversized }),
    ).resolves.toMatchObject({
      content: { status: "unsupported" },
    });
    const long = await read({
      name: "log.txt",
      contentType: "text/plain",
      bytes: text("é".repeat(80_000)),
    });
    expect(long.content).toMatchObject({ status: "text", truncated: true });
  });
});
