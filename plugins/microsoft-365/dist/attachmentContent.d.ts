import type { IntegrationInvocationContext } from "./host-contract.js";
/**
 * How a mail or event file attachment reaches the agent. Attachment bytes are untrusted: the
 * agent gets bounded text for readable files, image data for images, and metadata for anything
 * else. Executables and scripts are never handed over as runnable content. This decides what the
 * tool returns; it cannot stop an agent with unrestricted shell access from acting on its own.
 */
export type AttachmentCategory = "executable" | "script" | "active-content" | "archive" | "pdf" | "docx" | "image" | "text" | "other";
export interface AttachmentClassification {
    readonly category: AttachmentCategory;
    /** What decided the category, so a mismatch between name, type, and bytes is visible. */
    readonly reasons: ReadonlyArray<string>;
}
/** Largest raw attachment the provider downloads for reading. */
export declare const MAX_ATTACHMENT_READ_BYTES: number;
/** Images keep the existing base64 response, which must stay below the host result ceiling. */
export declare const MAX_IMAGE_BYTES: number;
/**
 * Classifies by name, declared type, and (when given) the bytes. Every signal can only make the
 * result more cautious: a renamed executable or a misleading type cannot make it readable.
 */
export declare function classifyAttachment(input: {
    readonly name: string | null;
    readonly contentType: string | null;
    readonly bytes?: Uint8Array;
}): AttachmentClassification;
/** Repeated wherever the agent cannot read an attachment, because that is when it improvises. */
export declare const ATTACHMENT_FALLBACK_BOUNDARY = "Report this to the user as it is. Do not decode, convert, or run the attachment another way; search the computer for a file with the same name; read, decrypt, or create Microsoft or other sign-in credentials; or sign in to Microsoft in the browser to fetch it.";
export type AttachmentContent = {
    readonly status: "extracted";
    readonly format: "pdf" | "docx";
    readonly text: string;
    readonly truncated: boolean;
    readonly pageCount?: number;
    readonly pagesRead?: number;
    readonly note?: string;
} | {
    readonly status: "text";
    readonly text: string;
    readonly truncated: boolean;
} | {
    readonly status: "image";
    readonly mediaType: string;
} | {
    readonly status: "inert-source";
    readonly text: string;
    readonly truncated: boolean;
    readonly warning: string;
} | {
    readonly status: "withheld" | "unsupported" | "failed";
    readonly reason: string;
    readonly retryable: false;
    readonly note: string;
};
/**
 * Reads one downloaded file attachment. `reviewSourceAsText` returns a script or web file as
 * inert source text, for an explicit user request to review it.
 */
export declare function readAttachmentContent(input: {
    readonly name: string | null;
    readonly contentType: string | null;
    readonly bytes: Uint8Array;
    readonly reviewSourceAsText: boolean;
    readonly context?: IntegrationInvocationContext;
}): Promise<{
    readonly classification: AttachmentClassification;
    readonly content: AttachmentContent;
    /** Base64 image data, kept in the existing `contentBytes` field. */
    readonly imageBase64?: string;
}>;
