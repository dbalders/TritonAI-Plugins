import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type IntegrationConnectionSubmission,
  type IntegrationDeviceCodeConnectResult,
  type IntegrationInvocationContext,
  type IntegrationLifecycleContext,
  type IntegrationProvider,
  IntegrationProviderPublicError,
  type IntegrationProviderPollResult,
  type IntegrationProviderStatus,
  type IntegrationProviderTool,
  type IntegrationSecretStore,
} from "./host-contract.js";

/** Package-local suffix; the Harness adds the collision-free package namespace. */
export const MICROSOFT_GRAPH_SECRET_SUFFIX = "oauth";
export const MICROSOFT_GRAPH_PROVIDER_ID = "microsoft-graph";

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_API_ROOT = `${GRAPH_ORIGIN}/v1.0`;
const IDENTITY_ORIGIN = "https://login.microsoftonline.com";
const VERIFICATION_HOSTS = new Set([
  "login.microsoft.com",
  "login.microsoftonline.com",
  "microsoft.com",
  "www.microsoft.com",
]);
const OUTLOOK_WEB_HOSTS = new Set(["outlook.office.com", "outlook.office365.com"]);
const TEAMS_WEB_HOSTS = new Set(["teams.cloud.microsoft", "teams.microsoft.com"]);
const OFFLINE_SCOPE = "offline_access";
const OIDC_RESPONSE_SCOPES = new Set(["openid", "profile", "email"]);
const DELETION_MOVE_DESTINATIONS = new Set(["deleteditems", "recoverableitemsdeletions"]);
const MAX_MAIL_FOLDER_ANCESTRY_DEPTH = 64;
const REFRESH_TOKEN_FIELD = ["refresh", "token"].join("_");
const refreshValueField = ["refresh", "Token"].join("") as "refreshToken";
const CAPABILITY_SCOPES = {
  "mail.read": "Mail.Read",
  "mail.draft.create": "Mail.ReadWrite",
  "mail.organize": "Mail.ReadWrite",
  "calendar.read": "Calendars.Read",
  "calendar.write": "Calendars.ReadWrite",
  "chat.read": "Chat.Read",
  // The tenant already approved Chat.ReadWrite for this public client. The provider's fixed tool
  // surface remains send-only for this capability and never exposes chat create/edit/delete.
  "chat.write": "Chat.ReadWrite",
} as const;
const CAPABILITY_NAMES = new Set<string>(Object.keys(CAPABILITY_SCOPES));
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const IDENTITY_RESPONSE_BYTES = 64 * 1024;
const GRAPH_RESPONSE_BYTES = 1024 * 1024;
const GRAPH_ATTACHMENT_RESPONSE_BYTES = 512 * 1024;
const MAX_TOKEN_CHARS = 16_384;
const MAX_CALENDAR_RANGE_MS = 31 * 86_400_000;
const MAX_INPUT_BODY_CHARS = 50_000;
const MAX_BODY_BYTES = 50_000;
const MAX_BODY_CODE_POINTS = 50_000;
const MAX_PREVIEW_BYTES = 1_024;
const MAX_PREVIEW_CODE_POINTS = 255;
const MAX_ATTACHMENT_CONTENT_BASE64_BYTES = 350 * 1024;
const MAX_RESULT_BYTES = 384 * 1024;
const MAX_DRAFT_ATTACHMENT_BASE64_CHARS = 3_999_996;
const MAX_DRAFT_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CHAT_BODY_CHARS = 20_000;
const MAX_CHAT_REQUEST_BYTES = 28 * 1024;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface MicrosoftGraphConfiguration {
  readonly clientId: string;
  readonly tenantId: string;
}

const ENTRA_IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const MailSearchInput = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "Optional mail search text (maximum 200 characters).",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })).annotate({
      description: "Maximum number of messages (1-25).",
    }),
  ),
});

const MailGetInput = Schema.Struct({
  messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 message identifier.",
  }),
});

const MailFolderListInput = Schema.Struct({
  parentFolderId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
      description: "Optional exact parent mail-folder identifier.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description: "Maximum number of mail folders (1-100).",
    }),
  ),
});

const MailFolderCreateInput = Schema.Struct({
  displayName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    Schema.isPattern(/\S/u),
  ).annotate({ description: "Display name for the new mail folder." }),
  parentFolderId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
      description: "Optional exact parent mail-folder identifier.",
    }),
  ),
});

const MailMessageMoveInput = Schema.Struct({
  messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 message identifier.",
  }),
  destinationFolderId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
    Schema.isPattern(/\S/u),
  ).annotate({
    description:
      'Exact destination mail-folder identifier, or the well-known folder name "archive".',
  }),
});

const CalendarEventsInput = Schema.Struct({
  start: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(64)).annotate({
      description: "Inclusive ISO 8601 start timestamp.",
    }),
  ),
  end: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(64)).annotate({
      description: "Exclusive ISO 8601 end timestamp, no more than 31 days after start.",
    }),
  ),
});

const CalendarEventGetInput = Schema.Struct({
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 event identifier.",
  }),
});

const AttachmentLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
  description: "Maximum number of attachments (1-50).",
});

const MailAttachmentListInput = Schema.Struct({
  messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 message identifier.",
  }),
  limit: Schema.optionalKey(AttachmentLimit),
});

const MailAttachmentGetInput = Schema.Struct({
  messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 message identifier.",
  }),
  attachmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 attachment identifier.",
  }),
});

const CalendarAttachmentListInput = Schema.Struct({
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 event identifier.",
  }),
  limit: Schema.optionalKey(AttachmentLimit),
});

const CalendarAttachmentGetInput = Schema.Struct({
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 event identifier.",
  }),
  attachmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 attachment identifier.",
  }),
});

const EmailAddress = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
).annotate({ description: "A single email address." });

const RecipientList = Schema.Array(EmailAddress).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(25),
);

const OptionalRecipientList = Schema.Array(EmailAddress).check(Schema.isMaxLength(25));

const DraftFileAttachment = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
    description: "Attachment file name.",
  }),
  contentBytes: Schema.String.check(
    Schema.isMaxLength(MAX_DRAFT_ATTACHMENT_BASE64_CHARS),
    Schema.isPattern(BASE64_PATTERN),
  ).annotate({
    description: "Base64-encoded file content for an attachment smaller than 3 MB.",
  }),
  contentType: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
      description: "Optional MIME content type.",
    }),
  ),
});

const DraftFileAttachmentList = Schema.Array(DraftFileAttachment).check(Schema.isMaxLength(25));

const MailDraftCreateInput = Schema.Struct({
  to: RecipientList.annotate({ description: "Primary recipients (1-25)." }),
  cc: Schema.optionalKey(OptionalRecipientList.annotate({ description: "CC recipients (0-25)." })),
  bcc: Schema.optionalKey(
    OptionalRecipientList.annotate({ description: "BCC recipients (0-25)." }),
  ),
  subject: Schema.String.check(Schema.isMaxLength(255)).annotate({
    description: "Draft subject (maximum 255 characters).",
  }),
  body: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_INPUT_BODY_CHARS),
  ).annotate({ description: "Plain-text draft body." }),
  attachments: Schema.optionalKey(
    DraftFileAttachmentList.annotate({
      description: "Optional file attachments included with the unsent draft.",
    }),
  ),
});

const Attendee = Schema.Struct({
  address: EmailAddress,
  type: Schema.Literals(["required", "optional", "resource"]).annotate({
    description: "Attendee role to preserve in Microsoft 365.",
  }),
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(512)).annotate({
      description: "Optional attendee display name.",
    }),
  ),
});

const AttendeeList = Schema.Array(Attendee).check(Schema.isMaxLength(50));

const CalendarEventFields = {
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
    description: "Event subject.",
  }),
  start: Schema.String.check(Schema.isMaxLength(64)).annotate({
    description: "Inclusive ISO 8601 start timestamp.",
  }),
  end: Schema.String.check(Schema.isMaxLength(64)).annotate({
    description: "Exclusive ISO 8601 end timestamp.",
  }),
  location: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(1_000)).annotate({
      description: "Optional location display name.",
    }),
  ),
  body: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(MAX_INPUT_BODY_CHARS)).annotate({
      description: "Optional plain-text event body.",
    }),
  ),
  attendees: Schema.optionalKey(
    AttendeeList.annotate({ description: "Optional complete attendee list (0-50)." }),
  ),
};

const CalendarEventCreateInput = Schema.Struct(CalendarEventFields);

// Deliberately omit body: replacing it can remove existing Teams meeting join information.
const CalendarEventUpdateInput = Schema.Struct({
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 event identifier.",
  }),
  subject: Schema.optionalKey(CalendarEventFields.subject),
  start: Schema.optionalKey(CalendarEventFields.start),
  end: Schema.optionalKey(CalendarEventFields.end),
  location: CalendarEventFields.location,
  attendees: CalendarEventFields.attendees,
});

const ChatListInput = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })).annotate({
      description: "Maximum number of chats (1-25).",
    }),
  ),
});

const ChatMessagesInput = Schema.Struct({
  chatId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact Microsoft 365 chat identifier.",
  }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
      description: "Maximum number of messages (1-50).",
    }),
  ),
});

const ChatMessageSendInput = Schema.Struct({
  chatId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact destination Microsoft 365 chat identifier.",
  }),
  body: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CHAT_BODY_CHARS),
  ).annotate({ description: "Plain-text chat message whose encoded request is at most 28 KB." }),
});

const decodeMailSearchInput = Schema.decodeUnknownPromise(MailSearchInput);
const decodeMailGetInput = Schema.decodeUnknownPromise(MailGetInput);
const decodeMailFolderListInput = Schema.decodeUnknownPromise(MailFolderListInput);
const decodeMailFolderCreateInput = Schema.decodeUnknownPromise(MailFolderCreateInput);
const decodeMailMessageMoveInput = Schema.decodeUnknownPromise(MailMessageMoveInput);
const decodeMailAttachmentListInput = Schema.decodeUnknownPromise(MailAttachmentListInput);
const decodeMailAttachmentGetInput = Schema.decodeUnknownPromise(MailAttachmentGetInput);
const decodeCalendarEventsInput = Schema.decodeUnknownPromise(CalendarEventsInput);
const decodeCalendarEventGetInput = Schema.decodeUnknownPromise(CalendarEventGetInput);
const decodeCalendarAttachmentListInput = Schema.decodeUnknownPromise(CalendarAttachmentListInput);
const decodeCalendarAttachmentGetInput = Schema.decodeUnknownPromise(CalendarAttachmentGetInput);
const decodeMailDraftCreateInput = Schema.decodeUnknownPromise(MailDraftCreateInput);
const decodeCalendarEventCreateInput = Schema.decodeUnknownPromise(CalendarEventCreateInput);
const decodeCalendarEventUpdateInput = Schema.decodeUnknownPromise(CalendarEventUpdateInput);
const decodeChatListInput = Schema.decodeUnknownPromise(ChatListInput);
const decodeChatMessagesInput = Schema.decodeUnknownPromise(ChatMessagesInput);
const decodeChatMessageSendInput = Schema.decodeUnknownPromise(ChatMessageSendInput);

export const MICROSOFT_GRAPH_TOOLS = [
  {
    name: "microsoft365.mail.search",
    description:
      "Search Microsoft 365 mail through a fixed bounded projection; every non-null preview is marked previewIsPartial.",
    input: MailSearchInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.mail.get",
    description:
      "Read one exact Microsoft 365 mail message through a fixed bounded projection; body.truncated reports provider truncation.",
    input: MailGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.mail.folders.list",
    description:
      "List bounded Microsoft 365 mail-folder resources from a fixed read-only endpoint.",
    input: MailFolderListInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.mail.folder.create",
    description: "Create one Microsoft 365 mail folder through a fixed endpoint.",
    input: MailFolderCreateInput,
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  {
    name: "microsoft365.mail.message.move",
    description:
      'Move one exact Microsoft 365 mail message to an exact folder or the well-known "archive" folder.',
    input: MailMessageMoveInput,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  {
    name: "microsoft365.mail.draft.create",
    description:
      "Create one unsent Microsoft 365 mail draft with a plain-text body and optional file attachments through a fixed endpoint.",
    input: MailDraftCreateInput,
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  {
    name: "microsoft365.mail.attachments.list",
    description: "List attachments on one exact Microsoft 365 mail message.",
    input: MailAttachmentListInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.mail.attachment.get",
    description:
      "Read one exact attachment from one exact Microsoft 365 mail message through a fixed projection below the host result ceiling.",
    input: MailAttachmentGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.calendar.events",
    description:
      "Read Microsoft 365 calendar events through a fixed bounded projection; every non-null preview is marked previewIsPartial.",
    input: CalendarEventsInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.calendar.event.get",
    description:
      "Read one exact Microsoft 365 calendar event through a fixed bounded projection; body.truncated reports provider truncation.",
    input: CalendarEventGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.calendar.event.create",
    description: "Create one Microsoft 365 calendar event through the fixed events endpoint.",
    input: CalendarEventCreateInput,
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  {
    name: "microsoft365.calendar.event.attachments.list",
    description: "List attachments on one exact Microsoft 365 calendar event.",
    input: CalendarAttachmentListInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.calendar.event.attachment.get",
    description:
      "Read one exact attachment from one exact Microsoft 365 calendar event through a fixed projection below the host result ceiling.",
    input: CalendarAttachmentGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.calendar.event.update",
    description:
      "Update the subject, time, location, or attendee list on one Microsoft 365 calendar event.",
    input: CalendarEventUpdateInput,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  {
    name: "microsoft365.chat.list",
    description: "List a bounded number of Microsoft 365 chats through the fixed chats endpoint.",
    input: ChatListInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.chat.messages",
    description:
      "Read bounded message history from one exact Microsoft 365 chat; body is null without content, otherwise body.truncated reports provider truncation.",
    input: ChatMessagesInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "microsoft365.chat.message.send",
    description: "Send one plain-text message to one existing Microsoft 365 chat.",
    input: ChatMessageSendInput,
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
] as const satisfies ReadonlyArray<IntegrationProviderTool>;

interface Credential {
  readonly version: 2;
  readonly refreshToken: string;
  readonly grantedScopes: ReadonlyArray<string>;
  readonly grantedCapabilities: ReadonlyArray<keyof typeof CAPABILITY_SCOPES>;
  readonly updatedAt: string;
}

interface PendingFlow {
  readonly deviceCode: string;
  readonly requestedScopes: ReadonlyArray<string>;
  readonly requestedCapabilities: ReadonlyArray<keyof typeof CAPABILITY_SCOPES>;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
  readonly generation: number;
}

interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly grantedScopes: ReadonlyArray<string>;
  readonly grantedCapabilities: ReadonlyArray<keyof typeof CAPABILITY_SCOPES>;
}

type Fetch = typeof globalThis.fetch;

function validateEntraIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!ENTRA_IDENTIFIER.test(normalized)) {
    throw new Error(`Microsoft 365 requires a valid Entra ${label}.`);
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Microsoft returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function boundedString(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || utf8Length(value) > maximumBytes) {
    throw new Error("Microsoft returned an invalid response.");
  }
  return value;
}

function boundedOptionalString(value: unknown, maximumBytes: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || utf8Length(value) > maximumBytes) {
    throw new Error("Microsoft returned an invalid response.");
  }
  return value;
}

function boundedOptionalHttpsUrl(
  value: unknown,
  maximumBytes: number,
  allowedHosts: ReadonlySet<string>,
): string | null {
  const raw = boundedOptionalString(value, maximumBytes);
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Microsoft returned an invalid response.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !allowedHosts.has(url.hostname)
  ) {
    throw new Error("Microsoft returned an invalid response.");
  }
  return boundedString(url.toString(), maximumBytes);
}

function truncatedUtf8String(
  value: unknown,
  maximumBytes: number,
  maximumCodePoints: number,
): { readonly value: string; readonly truncated: boolean } {
  if (typeof value !== "string") throw new Error("Microsoft returned an invalid response.");
  let bytes = 0;
  let codePoints = 0;
  let end = 0;
  for (const codePoint of value) {
    const point = codePoint.codePointAt(0) as number;
    const codePointBytes = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x1_00_00 ? 3 : 4;
    if (bytes + codePointBytes > maximumBytes || codePoints === maximumCodePoints) {
      return { value: value.slice(0, end), truncated: true };
    }
    bytes += codePointBytes;
    codePoints += 1;
    end += codePoint.length;
  }
  return { value, truncated: false };
}

function boundedResult<T>(value: T, maximumBytes = MAX_RESULT_BYTES): T {
  if (utf8Length(JSON.stringify(value)) > maximumBytes) {
    throw new Error("Microsoft result exceeded the allowed size.");
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error("Microsoft returned an invalid response.");
  }
  return value as number;
}

function canonicalScopes(value: unknown, required: ReadonlyArray<string>): ReadonlyArray<string> {
  const expectedScopes = [...new Set(required)].toSorted();
  if (value === undefined) return expectedScopes;
  const raw = boundedString(value, 2_048).split(/\s+/u).filter(Boolean);
  const unique = [...new Set(raw)];
  const resourceScopes = unique
    .filter((scope) => scope !== OFFLINE_SCOPE && !OIDC_RESPONSE_SCOPES.has(scope))
    .toSorted();
  if (
    unique.length !== raw.length ||
    expectedScopes.some((scope) => !resourceScopes.includes(scope))
  ) {
    throw new Error("Microsoft returned an unexpected delegated-scope grant.");
  }
  // Entra access tokens contain every scope previously consented for this client and resource,
  // even when this request asks for a narrower subset. Host capabilities remain restricted to
  // the requested manifest scopes; additive grants never widen the provider's fixed tool surface.
  return expectedScopes;
}

function legacyCapabilitiesFromScopes(
  scopes: ReadonlyArray<string>,
): ReadonlyArray<keyof typeof CAPABILITY_SCOPES> {
  return Object.entries(CAPABILITY_SCOPES)
    .filter(([capability, scope]) => capability !== "mail.organize" && scopes.includes(scope))
    .map(([capability]) => capability as keyof typeof CAPABILITY_SCOPES)
    .toSorted();
}

function canonicalCapabilities(
  value: unknown,
  scopes: ReadonlyArray<string>,
): ReadonlyArray<keyof typeof CAPABILITY_SCOPES> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (capability) => typeof capability !== "string" || !CAPABILITY_NAMES.has(capability),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Stored Microsoft credential is invalid.");
  }
  const capabilities = value as ReadonlyArray<keyof typeof CAPABILITY_SCOPES>;
  if (capabilities.some((capability) => !scopes.includes(CAPABILITY_SCOPES[capability]))) {
    throw new Error("Stored Microsoft credential is invalid.");
  }
  return [...capabilities].toSorted();
}

function isoTimestamp(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds)) {
    throw new IntegrationProviderPublicError("Calendar start and end must be ISO 8601 timestamps.");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const requiredZone = zone!;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHours = requiredZone === "Z" ? 0 : Number(requiredZone.slice(1, 3));
  const offsetMinutes = requiredZone === "Z" ? 0 : Number(requiredZone.slice(4, 6));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    throw new IntegrationProviderPublicError("Calendar start and end must be ISO 8601 timestamps.");
  }
  return new Date(milliseconds).toISOString();
}

function safeVerificationUrl(value: unknown): string {
  const raw = boundedString(value, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Microsoft returned an invalid verification address.");
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !VERIFICATION_HOSTS.has(url.hostname)
  ) {
    throw new Error("Microsoft returned an invalid verification address.");
  }
  return url.toString();
}

function parseCredential(bytes: Uint8Array): Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("Stored Microsoft credential is invalid.");
  }
  const value = asRecord(parsed);
  const isLegacy = value.version === 1;
  if (
    (value.version !== 1 && value.version !== 2) ||
    !exactKeys(
      value,
      new Set(
        isLegacy
          ? ["version", "refreshToken", "grantedScopes", "updatedAt"]
          : ["version", "refreshToken", "grantedScopes", "grantedCapabilities", "updatedAt"],
      ),
    ) ||
    !Array.isArray(value.grantedScopes) ||
    value.grantedScopes.length === 0 ||
    value.grantedScopes.some(
      (scope) =>
        typeof scope !== "string" || !Object.values(CAPABILITY_SCOPES).includes(scope as never),
    ) ||
    new Set(value.grantedScopes).size !== value.grantedScopes.length ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error("Stored Microsoft credential is invalid.");
  }
  const refreshToken = boundedString(value.refreshToken, MAX_TOKEN_CHARS);
  const grantedScopes = [...value.grantedScopes].toSorted() as ReadonlyArray<string>;
  return {
    version: 2,
    refreshToken,
    grantedScopes,
    grantedCapabilities: isLegacy
      ? legacyCapabilitiesFromScopes(grantedScopes)
      : canonicalCapabilities(value.grantedCapabilities, grantedScopes),
    updatedAt: value.updatedAt,
  };
}

async function readJson(
  response: Response,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json")) {
    throw new Error("Microsoft returned an invalid content type.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("Microsoft response exceeded the allowed size.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Microsoft returned an empty response.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Microsoft response exceeded the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return asRecord(JSON.parse(decoder.decode(bytes)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Microsoft returned")) throw error;
    throw new Error("Microsoft returned invalid JSON.");
  }
}

function collectionResult(
  value: Record<string, unknown>,
  maximumItems: number,
): { readonly items: ReadonlyArray<unknown>; readonly hasMore: boolean } {
  if (!Array.isArray(value.value) || value.value.length > maximumItems) {
    throw new Error("Microsoft Graph returned an invalid collection response.");
  }
  const nextLink = value["@odata.nextLink"];
  const hasMore = nextLink !== null && nextLink !== undefined;
  if (hasMore) boundedString(nextLink, 2_048);
  return { items: value.value, hasMore };
}

function graphEmailAddress(value: unknown) {
  const item = asRecord(value);
  return {
    name: boundedOptionalString(item.name, 512),
    address: boundedString(item.address, 320),
  };
}

function graphRecipients(value: unknown): ReadonlyArray<ReturnType<typeof graphEmailAddress>> {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error("Microsoft Graph returned an invalid recipient response.");
  }
  return value.map((raw) => graphEmailAddress(asRecord(raw).emailAddress));
}

function graphSender(value: unknown) {
  const from = value === null || value === undefined ? null : asRecord(value);
  const emailAddress =
    from === null || from.emailAddress === null || from.emailAddress === undefined
      ? null
      : asRecord(from.emailAddress);
  return emailAddress === null
    ? null
    : {
        name: boundedOptionalString(emailAddress.name, 512),
        address: boundedOptionalString(emailAddress.address, 320),
      };
}

function projectedBody(value: unknown) {
  const body = asRecord(value);
  const contentType = boundedString(body.contentType, 16);
  if (contentType !== "text" && contentType !== "html") {
    throw new Error("Microsoft Graph returned an invalid body type.");
  }
  const content = truncatedUtf8String(body.content, MAX_BODY_BYTES, MAX_BODY_CODE_POINTS);
  return { contentType, content: content.value, truncated: content.truncated };
}

function projectedChatBody(value: unknown) {
  if (value === null || value === undefined) return null;
  const body = asRecord(value);
  return body.content === null || body.content === undefined ? null : projectedBody(body);
}

function projectedPreview(value: unknown) {
  if (value === null || value === undefined) {
    return { preview: null, previewIsPartial: false };
  }
  const preview = truncatedUtf8String(value, MAX_PREVIEW_BYTES, MAX_PREVIEW_CODE_POINTS);
  return { preview: preview.value, previewIsPartial: true };
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Microsoft returned an invalid response.");
  return value;
}

function mailFields(item: Record<string, unknown>) {
  return {
    id: boundedString(item.id, 512),
    subject: boundedOptionalString(item.subject, 1_000),
    from: graphSender(item.from),
    receivedDateTime: boundedString(item.receivedDateTime, 64),
    isRead: requiredBoolean(item.isRead),
  };
}

function mailSearchResult(value: Record<string, unknown>, limit: number) {
  const collection = collectionResult(value, limit);
  const messages = collection.items.map((raw) => {
    const item = asRecord(raw);
    return {
      ...mailFields(item),
      ...projectedPreview(item.bodyPreview),
      hasAttachments: requiredBoolean(item.hasAttachments),
    };
  });
  return boundedResult({ messages, hasMore: collection.hasMore });
}

function mailGetResult(value: Record<string, unknown>) {
  return boundedResult({ ...mailFields(value), body: projectedBody(value.body) });
}

function mailDraftResult(value: Record<string, unknown>) {
  if (value.isDraft !== true) {
    throw new Error("Microsoft Graph did not return an unsent mail draft.");
  }
  return boundedResult({
    id: boundedString(value.id, 512),
    subject: boundedOptionalString(value.subject, 998),
    to: graphRecipients(value.toRecipients),
    cc: graphRecipients(value.ccRecipients),
    bcc: graphRecipients(value.bccRecipients),
    isDraft: true,
    webLink: boundedOptionalHttpsUrl(value.webLink, 2_048, OUTLOOK_WEB_HOSTS),
  });
}

function graphDateTime(value: unknown): { readonly dateTime: string; readonly timeZone: string } {
  const item = asRecord(value);
  return {
    dateTime: boundedString(item.dateTime, 64),
    timeZone: boundedString(item.timeZone, 128),
  };
}

function calendarResult(value: Record<string, unknown>) {
  const collection = collectionResult(value, 50);
  const events = collection.items.map((raw) => {
    const item = asRecord(raw);
    const location =
      item.location === null || item.location === undefined ? null : asRecord(item.location);
    const organizer =
      item.organizer === null || item.organizer === undefined ? null : asRecord(item.organizer);
    const emailAddress =
      organizer === null || organizer.emailAddress === null || organizer.emailAddress === undefined
        ? null
        : asRecord(organizer.emailAddress);
    return {
      id: boundedString(item.id, 512),
      subject: boundedOptionalString(item.subject, 1_000),
      start: graphDateTime(item.start),
      end: graphDateTime(item.end),
      location: location === null ? null : boundedOptionalString(location.displayName, 1_000),
      organizer:
        emailAddress === null
          ? null
          : {
              name: boundedOptionalString(emailAddress.name, 512),
              address: boundedOptionalString(emailAddress.address, 320),
            },
      ...projectedPreview(item.bodyPreview),
      hasAttachments: requiredBoolean(item.hasAttachments),
    };
  });
  return boundedResult({ events, hasMore: collection.hasMore });
}

function graphAttendees(value: unknown) {
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error("Microsoft Graph returned an invalid attendee response.");
  }
  return value.map((raw) => {
    const item = asRecord(raw);
    return {
      emailAddress: graphEmailAddress(item.emailAddress),
      type: boundedString(item.type, 32),
    };
  });
}

function eventResult(value: Record<string, unknown>) {
  const location =
    value.location === null || value.location === undefined ? null : asRecord(value.location);
  return boundedResult({
    id: boundedString(value.id, 512),
    subject: boundedOptionalString(value.subject, 1_000),
    start: graphDateTime(value.start),
    end: graphDateTime(value.end),
    location: location === null ? null : boundedOptionalString(location.displayName, 1_000),
    attendees: graphAttendees(value.attendees),
    webLink: boundedOptionalHttpsUrl(value.webLink, 2_048, OUTLOOK_WEB_HOSTS),
    ...(value.body === null || value.body === undefined ? {} : { body: projectedBody(value.body) }),
  });
}

function chatsResult(value: Record<string, unknown>, limit: number) {
  const collection = collectionResult(value, limit);
  const chats = collection.items.map((raw) => {
    const item = asRecord(raw);
    return {
      id: boundedString(item.id, 512),
      topic: boundedOptionalString(item.topic, 1_000),
      chatType: boundedString(item.chatType, 64),
      createdDateTime: boundedOptionalString(item.createdDateTime, 64),
      lastUpdatedDateTime: boundedOptionalString(item.lastUpdatedDateTime, 64),
      webUrl: boundedOptionalHttpsUrl(item.webUrl, 2_048, TEAMS_WEB_HOSTS),
    };
  });
  return boundedResult({ chats, hasMore: collection.hasMore });
}

function projectChatMessage(value: Record<string, unknown>) {
  const from = value.from === null || value.from === undefined ? null : asRecord(value.from);
  const user = from?.user === null || from?.user === undefined ? null : asRecord(from.user);
  return {
    id: boundedString(value.id, 512),
    createdDateTime: boundedString(value.createdDateTime, 64),
    lastModifiedDateTime: boundedOptionalString(value.lastModifiedDateTime, 64),
    from:
      user === null
        ? null
        : {
            id: boundedOptionalString(user.id, 512),
            displayName: boundedOptionalString(user.displayName, 512),
          },
    body: projectedChatBody(value.body),
    webUrl: boundedOptionalHttpsUrl(value.webUrl, 2_048, TEAMS_WEB_HOSTS),
  };
}

function chatMessagesResult(value: Record<string, unknown>, limit: number) {
  const collection = collectionResult(value, limit);
  const messages: Array<ReturnType<typeof projectChatMessage>> = [];
  let locallyOmitted = false;
  for (const [index, raw] of collection.items.entries()) {
    const message = projectChatMessage(asRecord(raw));
    const candidate = {
      messages: [...messages, message],
      hasMore: collection.hasMore || index < collection.items.length - 1,
    };
    if (utf8Length(JSON.stringify(candidate)) > MAX_RESULT_BYTES) {
      locallyOmitted = true;
      break;
    }
    messages.push(message);
  }
  return boundedResult({ messages, hasMore: collection.hasMore || locallyOmitted });
}

function chatMessageResult(value: Record<string, unknown>) {
  return boundedResult(projectChatMessage(value));
}

type AttachmentKind = "file" | "item" | "reference";

function graphODataType(value: unknown): string {
  const type = boundedString(value, 64);
  return type.startsWith("#") ? type.slice(1) : type;
}

function attachmentKind(value: unknown): AttachmentKind {
  switch (graphODataType(value)) {
    case "microsoft.graph.fileAttachment":
      return "file";
    case "microsoft.graph.itemAttachment":
      return "item";
    case "microsoft.graph.referenceAttachment":
      return "reference";
    default:
      throw new Error("Microsoft Graph returned an unsupported attachment type.");
  }
}

function attachmentMetadata(value: Record<string, unknown>) {
  return {
    kind: attachmentKind(value["@odata.type"]),
    id: boundedString(value.id, 512),
    name: boundedOptionalString(value.name, 1_000),
    contentType: boundedOptionalString(value.contentType, 255),
    size: boundedInteger(value.size, 0, Number.MAX_SAFE_INTEGER),
    isInline: requiredBoolean(value.isInline),
    lastModifiedDateTime: boundedOptionalString(value.lastModifiedDateTime, 64),
  };
}

function attachmentListResult(value: Record<string, unknown>, limit: number) {
  const collection = collectionResult(value, limit);
  return boundedResult({
    attachments: collection.items.map((item) => attachmentMetadata(asRecord(item))),
    hasMore: collection.hasMore,
  });
}

function optionalGraphDateTime(value: unknown) {
  return value === null || value === undefined ? null : graphDateTime(value);
}

function projectedAttachedItemId(value: unknown): string | null {
  const id = boundedOptionalString(value, 512);
  return id === "" ? null : id;
}

function projectedAttachedItem(value: unknown) {
  const item = asRecord(value);
  switch (graphODataType(item["@odata.type"])) {
    case "microsoft.graph.message":
    case "microsoft.graph.eventMessage":
    case "microsoft.graph.eventMessageRequest":
    case "microsoft.graph.eventMessageResponse":
    case "microsoft.graph.calendarSharingMessage":
      return {
        kind: "message" as const,
        id: projectedAttachedItemId(item.id),
        subject: boundedOptionalString(item.subject, 1_000),
        from: graphSender(item.from),
        receivedDateTime: boundedOptionalString(item.receivedDateTime, 64),
        isRead:
          item.isRead === null || item.isRead === undefined ? null : requiredBoolean(item.isRead),
        body: item.body === null || item.body === undefined ? null : projectedBody(item.body),
      };
    case "microsoft.graph.event": {
      const location =
        item.location === null || item.location === undefined ? null : asRecord(item.location);
      return {
        kind: "event" as const,
        id: projectedAttachedItemId(item.id),
        subject: boundedOptionalString(item.subject, 1_000),
        start: optionalGraphDateTime(item.start),
        end: optionalGraphDateTime(item.end),
        location: location === null ? null : boundedOptionalString(location.displayName, 1_000),
        body: item.body === null || item.body === undefined ? null : projectedBody(item.body),
      };
    }
    case "microsoft.graph.contact": {
      const emailAddresses = item.emailAddresses ?? [];
      if (!Array.isArray(emailAddresses) || emailAddresses.length > 50) {
        throw new Error("Microsoft Graph returned an invalid contact response.");
      }
      return {
        kind: "contact" as const,
        id: projectedAttachedItemId(item.id),
        displayName: boundedOptionalString(item.displayName, 1_000),
        emailAddresses: emailAddresses.map((address) => graphEmailAddress(address)),
      };
    }
    default:
      throw new Error("Microsoft Graph returned an unsupported attached item type.");
  }
}

function attachmentResult(value: Record<string, unknown>) {
  const metadata = attachmentMetadata(value);
  if (metadata.kind === "file") {
    if (
      typeof value.contentBytes !== "string" ||
      utf8Length(value.contentBytes) > MAX_ATTACHMENT_CONTENT_BASE64_BYTES ||
      !BASE64_PATTERN.test(value.contentBytes)
    ) {
      throw new Error("Microsoft Graph returned invalid attachment content.");
    }
    return boundedResult({ ...metadata, contentBytes: value.contentBytes });
  }
  if (metadata.kind === "item") {
    return boundedResult({ ...metadata, item: projectedAttachedItem(value.item) });
  }
  return boundedResult(metadata);
}

function mailFolderReceipt(value: Record<string, unknown>) {
  return {
    id: boundedString(value.id, 512),
    displayName: boundedString(value.displayName, 255),
    parentFolderId: boundedOptionalString(value.parentFolderId, 512),
  };
}

function mailMoveReceipt(value: Record<string, unknown>) {
  return {
    id: boundedString(value.id, 512),
    parentFolderId: boundedString(value.parentFolderId, 512),
  };
}

function recipients(addresses: ReadonlyArray<string>) {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

function attendees(
  values: ReadonlyArray<{
    readonly address: string;
    readonly name?: string;
    readonly type: "required" | "optional" | "resource";
  }>,
) {
  return values.map(({ address, name, type }) => ({
    emailAddress: { address, ...(name === undefined ? {} : { name }) },
    type,
  }));
}

function graphUtcDateTime(value: string) {
  return { dateTime: isoTimestamp(value).replace(/Z$/u, ""), timeZone: "UTC" };
}

function calendarRange(startValue: string, endValue: string) {
  const start = isoTimestamp(startValue);
  const end = isoTimestamp(endValue);
  const range = Date.parse(end) - Date.parse(start);
  if (range <= 0 || range > MAX_CALENDAR_RANGE_MS) {
    throw new IntegrationProviderPublicError(
      "Calendar range must be positive and no longer than 31 days.",
    );
  }
  return { start, end };
}

function eventBody(values: {
  readonly subject: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly body?: string;
  readonly attendees?: ReadonlyArray<{
    readonly address: string;
    readonly name?: string;
    readonly type: "required" | "optional" | "resource";
  }>;
}) {
  calendarRange(values.start, values.end);
  return {
    subject: values.subject,
    start: graphUtcDateTime(values.start),
    end: graphUtcDateTime(values.end),
    ...(values.location === undefined ? {} : { location: { displayName: values.location } }),
    ...(values.body === undefined ? {} : { body: { contentType: "text", content: values.body } }),
    ...(values.attendees === undefined ? {} : { attendees: attendees(values.attendees) }),
  };
}

export class MicrosoftGraphProvider implements IntegrationProvider {
  readonly id = MICROSOFT_GRAPH_PROVIDER_ID;
  readonly tools = MICROSOFT_GRAPH_TOOLS;
  readonly #secrets: IntegrationSecretStore;
  readonly #clientId: string;
  readonly #loginRoot: string;
  readonly #fetch: Fetch;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingFlow>();
  readonly #polling = new Set<string>();
  readonly #requestControllers = new Set<AbortController>();
  #accessToken: AccessToken | null = null;
  #generation = 0;
  #connectAttempt = 0;
  #credentialRevision = 0;
  #closed = false;
  #disconnecting = false;
  #uncertainCredentialState = false;
  #credentialMutation: Promise<void> = Promise.resolve();

  constructor(
    secrets: IntegrationSecretStore,
    configuration: MicrosoftGraphConfiguration,
    fetchImplementation: Fetch = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.#secrets = secrets;
    this.#clientId = validateEntraIdentifier(configuration.clientId, "client ID");
    const tenantId = validateEntraIdentifier(configuration.tenantId, "tenant ID");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new Error("Microsoft 365 requires a bounded request timeout.");
    }
    this.#loginRoot = `${IDENTITY_ORIGIN}/${tenantId}/oauth2/v2.0`;
    this.#fetch = fetchImplementation;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async #request(
    input: string,
    init: RequestInit,
    maximumBytes: number,
    inspectResponse?: (response: Response) => void,
  ) {
    if (this.#closed) throw new Error("Microsoft 365 is closed.");
    const controller = new AbortController();
    this.#requestControllers.add(controller);
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const signals = [controller.signal, timeoutSignal];
    if (init.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    try {
      const response = await this.#fetch(input, {
        ...init,
        redirect: "error",
        signal,
      });
      inspectResponse?.(response);
      return { response, json: await readJson(response, maximumBytes) };
    } catch (error) {
      if (init.signal?.aborted)
        throw new Error("Microsoft request was cancelled.", { cause: error });
      if (controller.signal.aborted)
        throw new Error("Microsoft provider was closed.", { cause: error });
      if (timeoutSignal.aborted) throw new Error("Microsoft request timed out.", { cause: error });
      throw error;
    } finally {
      this.#requestControllers.delete(controller);
    }
  }

  #postForm(
    path: "devicecode" | "token",
    form: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) {
    return this.#request(
      `${this.#loginRoot}/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
        signal: signal ?? null,
      },
      IDENTITY_RESPONSE_BYTES,
    );
  }

  #serializeCredential<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#credentialMutation.then(operation, operation);
    this.#credentialMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #readCredential(signal?: AbortSignal): Promise<Credential | null> {
    const value = await Effect.runPromise(this.#secrets.get(MICROSOFT_GRAPH_SECRET_SUFFIX), {
      signal,
    });
    return Option.isSome(value) ? parseCredential(value.value) : null;
  }

  #writeCredential(credential: Credential, signal: AbortSignal): Promise<void> {
    return Effect.runPromise(
      this.#secrets.set(MICROSOFT_GRAPH_SECRET_SUFFIX, encoder.encode(JSON.stringify(credential))),
      { signal },
    );
  }

  async #beginCommit(context?: IntegrationLifecycleContext): Promise<AbortSignal> {
    if (!context || typeof context.beginCommit !== "function") {
      throw new Error("Microsoft credential mutation requires Harness commit admission.");
    }
    return context.beginCommit();
  }

  async status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus> {
    if (this.#uncertainCredentialState) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Credential state is uncertain. Disconnect to verify reset before reconnecting.",
      };
    }
    if (this.#closed) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The Microsoft 365 provider is closed.",
      };
    }
    if (this.#disconnecting) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Microsoft 365 is disconnecting.",
      };
    }
    const generation = this.#generation;
    const credentialRevision = this.#credentialRevision;
    try {
      const credential = await this.#readCredential(context?.signal);
      if (this.#closed) {
        return {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "The Microsoft 365 provider is closed.",
        };
      }
      if (this.#uncertainCredentialState) {
        return {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "Credential state is uncertain. Disconnect to verify reset before reconnecting.",
        };
      }
      if (
        this.#disconnecting ||
        generation !== this.#generation ||
        credentialRevision !== this.#credentialRevision
      ) {
        return {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "Microsoft connection state changed while status was being checked.",
        };
      }
      const now = Date.now();
      for (const [flowId, flow] of this.#pending) {
        if (flow.expiresAt <= now && !this.#polling.has(flowId)) this.#pending.delete(flowId);
      }
      if (!credential) {
        return {
          state: this.#pending.size > 0 ? "connecting" : "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message: null,
        };
      }
      return {
        state: "connected",
        accountLabel: null,
        grantedCapabilities: credential.grantedCapabilities,
        message: "Connected with delegated access for the selected capabilities.",
      };
    } catch {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The stored Microsoft connection could not be verified. Disconnect to reset it.",
      };
    }
  }

  async connect(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationDeviceCodeConnectResult> {
    if (submission !== undefined) throw new Error("Microsoft device sign-in rejects submissions.");
    if (this.#closed || this.#disconnecting) throw new Error("Microsoft 365 is unavailable.");
    if (this.#uncertainCredentialState) throw new Error("Microsoft credential state is uncertain.");
    if (context?.signal.aborted) throw new Error("Microsoft sign-in was cancelled.");
    if (
      capabilities.length === 0 ||
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) => !CAPABILITY_NAMES.has(capability))
    ) {
      throw new Error("Unsupported Microsoft 365 capability.");
    }
    const generation = this.#generation;
    const connectAttempt = ++this.#connectAttempt;
    const credentialRevisionBeforeRead = this.#credentialRevision;
    const existing = await this.#readCredential(context?.signal);
    if (credentialRevisionBeforeRead !== this.#credentialRevision) {
      throw new Error("Microsoft credential changed while sign-in was starting.");
    }
    const credentialRevision = this.#credentialRevision;
    const requestedCapabilities = [
      ...new Set([
        ...(existing?.grantedCapabilities ?? []),
        ...(capabilities as ReadonlyArray<keyof typeof CAPABILITY_SCOPES>),
      ]),
    ].toSorted();
    const requestedScopes = [
      ...new Set(requestedCapabilities.map((capability) => CAPABILITY_SCOPES[capability])),
    ].toSorted();
    const { response, json } = await this.#postForm(
      "devicecode",
      { client_id: this.#clientId, scope: [OFFLINE_SCOPE, ...requestedScopes].join(" ") },
      context?.signal,
    );
    if (!response.ok) {
      throw new IntegrationProviderPublicError(
        "Microsoft sign-in could not start. Try again later.",
      );
    }
    const deviceCode = boundedString(json.device_code, MAX_TOKEN_CHARS);
    const userCode = boundedString(json.user_code, 128);
    const verificationUri = safeVerificationUrl(json.verification_uri);
    const verificationUriComplete =
      json.verification_uri_complete === undefined
        ? null
        : safeVerificationUrl(json.verification_uri_complete);
    const intervalSeconds = boundedInteger(json.interval, 1, 60, 5);
    const expiresInSeconds = boundedInteger(json.expires_in, 60, 1_800);
    if (
      this.#closed ||
      this.#disconnecting ||
      this.#uncertainCredentialState ||
      generation !== this.#generation ||
      connectAttempt !== this.#connectAttempt ||
      credentialRevision !== this.#credentialRevision
    ) {
      throw new Error("Microsoft sign-in was superseded while starting.");
    }
    this.#pending.clear();
    const flowId = crypto.randomUUID();
    const expiresAt = Date.now() + expiresInSeconds * 1_000;
    this.#pending.set(flowId, {
      deviceCode,
      requestedScopes,
      requestedCapabilities,
      expiresAt,
      intervalSeconds,
      generation,
    });
    return {
      kind: "device_code",
      flowId,
      verificationUri,
      verificationUriComplete,
      userCode,
      message: `Open ${verificationUri} and enter the displayed code.`,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds,
    };
  }

  async poll(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult> {
    const flow = this.#pending.get(flowId);
    if (!flow) throw new IntegrationProviderPublicError("Microsoft sign-in flow was not found.");
    if (this.#polling.has(flowId)) {
      throw new IntegrationProviderPublicError("Microsoft sign-in is already being checked.");
    }
    if (flow.expiresAt <= Date.now()) {
      this.#pending.delete(flowId);
      return {
        state: "expired",
        retryAfterSeconds: null,
        message: "Sign-in expired. Start again.",
      };
    }
    if (this.#uncertainCredentialState) throw new Error("Microsoft credential state is uncertain.");
    this.#polling.add(flowId);
    let admitted = false;
    let tokenResponseSettled = false;
    let credentialIssued = false;
    try {
      const commitSignal = await this.#beginCommit(context);
      admitted = true;
      const { response, json } = await this.#postForm(
        "token",
        {
          client_id: this.#clientId,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: flow.deviceCode,
        },
        commitSignal,
      );
      tokenResponseSettled = true;
      credentialIssued = response.ok;
      if (
        this.#closed ||
        this.#disconnecting ||
        flow.generation !== this.#generation ||
        !this.#pending.has(flowId)
      ) {
        throw new Error("Microsoft sign-in was superseded.");
      }
      if (!response.ok) {
        if (json.error === "authorization_pending") {
          return {
            state: "pending",
            retryAfterSeconds: flow.intervalSeconds,
            message: "Waiting for Microsoft sign-in.",
          };
        }
        if (json.error === "slow_down") {
          const retryAfterSeconds = Math.min(60, flow.intervalSeconds + 5);
          this.#pending.set(flowId, { ...flow, intervalSeconds: retryAfterSeconds });
          return {
            state: "pending",
            retryAfterSeconds,
            message: "Microsoft asked the client to poll more slowly.",
          };
        }
        this.#pending.delete(flowId);
        return {
          state: "failed",
          retryAfterSeconds: null,
          message: "Microsoft sign-in failed. Start again.",
        };
      }
      const accessToken = boundedString(json.access_token, MAX_TOKEN_CHARS);
      const refreshToken = boundedString(json.refresh_token, MAX_TOKEN_CHARS);
      const grantedScopes = canonicalScopes(json.scope, flow.requestedScopes);
      const expiresInSeconds = boundedInteger(json.expires_in, 60, 86_400);
      const credential: Credential = {
        version: 2,
        refreshToken,
        grantedScopes,
        grantedCapabilities: flow.requestedCapabilities,
        updatedAt: new Date().toISOString(),
      };
      await this.#serializeCredential(async () => {
        if (
          this.#closed ||
          this.#disconnecting ||
          this.#uncertainCredentialState ||
          flow.generation !== this.#generation ||
          !this.#pending.has(flowId)
        ) {
          throw new Error("Microsoft sign-in was superseded before credential commit.");
        }
        await this.#writeCredential(credential, commitSignal);
        this.#credentialRevision += 1;
        this.#generation += 1;
        this.#pending.clear();
        this.#accessToken = {
          value: accessToken,
          expiresAt: Date.now() + expiresInSeconds * 1_000,
          grantedScopes,
          grantedCapabilities: flow.requestedCapabilities,
        };
      });
      this.#pending.delete(flowId);
      return {
        state: "connected",
        retryAfterSeconds: null,
        message: "Microsoft 365 is connected.",
      };
    } catch (error) {
      if (
        admitted &&
        flow.generation === this.#generation &&
        (!tokenResponseSettled || credentialIssued)
      ) {
        this.#uncertainCredentialState = true;
      }
      throw error;
    } finally {
      this.#polling.delete(flowId);
    }
  }

  prepare(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      if (this.#uncertainCredentialState)
        throw new Error("Microsoft credential state is uncertain.");
      if (this.#closed || this.#disconnecting) throw new Error("Microsoft 365 is unavailable.");
      const access = this.#accessToken;
      if (access && access.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) return;
      const credential = await this.#readCredential(context?.signal);
      if (!credential) return;
      let admitted = false;
      try {
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        const { response, json } = await this.#postForm(
          "token",
          {
            client_id: this.#clientId,
            grant_type: "refresh_token",
            [REFRESH_TOKEN_FIELD]: credential.refreshToken,
            scope: [OFFLINE_SCOPE, ...credential.grantedScopes].join(" "),
          },
          commitSignal,
        );
        if (!response.ok) {
          throw new IntegrationProviderPublicError(
            "Microsoft access could not be refreshed. Disconnect and reconnect.",
          );
        }
        const accessToken = boundedString(json.access_token, MAX_TOKEN_CHARS);
        const rotatedValue = boundedString(
          json[REFRESH_TOKEN_FIELD] ?? credential.refreshToken,
          MAX_TOKEN_CHARS,
        );
        const grantedScopes = canonicalScopes(json.scope, credential.grantedScopes);
        const expiresInSeconds = boundedInteger(json.expires_in, 60, 86_400);
        await this.#writeCredential(
          {
            version: 2,
            [refreshValueField]: rotatedValue,
            grantedScopes,
            grantedCapabilities: credential.grantedCapabilities,
            updatedAt: new Date().toISOString(),
          },
          commitSignal,
        );
        this.#credentialRevision += 1;
        this.#accessToken = {
          value: accessToken,
          expiresAt: Date.now() + expiresInSeconds * 1_000,
          grantedScopes,
          grantedCapabilities: credential.grantedCapabilities,
        };
      } catch (error) {
        if (admitted) this.#uncertainCredentialState = true;
        throw error;
      }
    });
  }

  disconnect(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      this.#disconnecting = true;
      this.#generation += 1;
      this.#pending.clear();
      this.#accessToken = null;
      let admitted = false;
      try {
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        await Effect.runPromise(this.#secrets.remove(MICROSOFT_GRAPH_SECRET_SUFFIX), {
          signal: commitSignal,
        });
        this.#credentialRevision += 1;
        this.#uncertainCredentialState = false;
      } catch (error) {
        if (admitted) this.#uncertainCredentialState = true;
        throw error;
      } finally {
        this.#disconnecting = false;
      }
    });
  }

  #assertInvocationCurrent(generation: number) {
    if (
      this.#closed ||
      this.#disconnecting ||
      this.#uncertainCredentialState ||
      generation !== this.#generation
    ) {
      throw new Error("Microsoft access was revoked or became uncertain.");
    }
  }

  #requireCapability(access: AccessToken, capability: keyof typeof CAPABILITY_SCOPES) {
    if (!access.grantedCapabilities.includes(capability)) {
      throw new IntegrationProviderPublicError(
        `Microsoft 365 ${capability} access is not granted.`,
      );
    }
  }

  async #graph(
    path: string,
    accessToken: string,
    options: {
      readonly method?: "GET" | "POST" | "PATCH";
      readonly body?: unknown;
      readonly preferPlainTextBody?: boolean;
      readonly signal?: AbortSignal;
      readonly maximumResponseBytes?: number;
    } = {},
  ) {
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.preferPlainTextBody === true) {
      headers.prefer = 'outlook.body-content-type="text"';
    }
    const { response, json } = await this.#request(
      `${GRAPH_API_ROOT}${path}`,
      {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal ?? null,
      },
      options.maximumResponseBytes ?? GRAPH_RESPONSE_BYTES,
      (received) => {
        if (received.status === 401 && this.#accessToken?.value === accessToken) {
          this.#accessToken = null;
        }
      },
    );
    if (!response.ok) {
      if (response.status === 401) {
        throw new IntegrationProviderPublicError(
          "The Microsoft 365 session expired. Refresh access and try again.",
        );
      }
      if (response.status === 403) {
        throw new IntegrationProviderPublicError(
          "Microsoft 365 denied this request. Check the enabled access and reconnect if needed.",
        );
      }
      if (response.status === 404) {
        throw new IntegrationProviderPublicError("The requested Microsoft 365 item was not found.");
      }
      if (response.status === 409) {
        throw new IntegrationProviderPublicError(
          "Microsoft 365 could not complete the request because the item changed or conflicts with current state.",
        );
      }
      if (response.status === 429) {
        throw new IntegrationProviderPublicError(
          "Microsoft 365 is temporarily rate limiting requests. Try again later.",
        );
      }
      if (response.status >= 400 && response.status < 500) {
        throw new IntegrationProviderPublicError("Microsoft 365 could not accept this request.");
      }
      throw new Error(`Microsoft Graph request failed with HTTP ${response.status}.`);
    }
    return json;
  }

  async #beginInvocationCommit(
    context: IntegrationInvocationContext | undefined,
  ): Promise<AbortSignal> {
    if (context?.writeApproved !== true || typeof context.beginCommit !== "function") {
      throw new Error("Microsoft 365 writes require Harness commit admission.");
    }
    return context.beginCommit();
  }

  async #assertMailFolderOutsideDeletionHierarchy(
    folderId: string,
    accessToken: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deletionFolderError = () =>
      new IntegrationProviderPublicError(
        "Microsoft 365 mail organization cannot use a deletion folder.",
      );
    const initialFolderId = folderId.trim();
    if (DELETION_MOVE_DESTINATIONS.has(initialFolderId.toLowerCase())) {
      throw deletionFolderError();
    }

    const deletionFolderIds = new Set<string>();
    const selectId = new URLSearchParams({ $select: "id" });
    for (const wellKnownName of DELETION_MOVE_DESTINATIONS) {
      const folder = await this.#graph(
        `/me/mailFolders/${wellKnownName}?${selectId.toString()}`,
        accessToken,
        { signal },
      );
      this.#assertInvocationCurrent(generation);
      deletionFolderIds.add(boundedString(folder.id, 512));
    }

    const visitedFolderIds = new Set<string>();
    const selectAncestry = new URLSearchParams({ $select: "id,parentFolderId" });
    let currentFolderId = initialFolderId;
    for (let depth = 0; depth < MAX_MAIL_FOLDER_ANCESTRY_DEPTH; depth += 1) {
      if (deletionFolderIds.has(currentFolderId)) throw deletionFolderError();
      if (visitedFolderIds.has(currentFolderId)) {
        throw new IntegrationProviderPublicError(
          "Microsoft 365 could not safely verify the mail folder hierarchy.",
        );
      }
      visitedFolderIds.add(currentFolderId);

      const folder = await this.#graph(
        `/me/mailFolders/${encodeURIComponent(currentFolderId)}?${selectAncestry.toString()}`,
        accessToken,
        { signal },
      );
      this.#assertInvocationCurrent(generation);
      const resolvedFolderId = boundedString(folder.id, 512);
      if (deletionFolderIds.has(resolvedFolderId)) throw deletionFolderError();
      if (resolvedFolderId !== currentFolderId) {
        if (visitedFolderIds.has(resolvedFolderId)) {
          throw new IntegrationProviderPublicError(
            "Microsoft 365 could not safely verify the mail folder hierarchy.",
          );
        }
        visitedFolderIds.add(resolvedFolderId);
      }
      if (folder.parentFolderId === null || folder.parentFolderId === undefined) return;
      currentFolderId = boundedString(folder.parentFolderId, 512);
    }

    throw new IntegrationProviderPublicError(
      "Microsoft 365 could not safely verify the mail folder hierarchy.",
    );
  }

  async invoke(
    toolName: string,
    input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown> {
    if (this.#closed || this.#disconnecting || this.#uncertainCredentialState) {
      throw new Error("Microsoft 365 is unavailable.");
    }
    if (context?.signal.aborted) throw new Error("Microsoft request was cancelled.");
    const access = this.#accessToken;
    if (!access || access.expiresAt - ACCESS_TOKEN_SKEW_MS <= Date.now()) {
      throw new IntegrationProviderPublicError(
        "The Microsoft 365 session needs a safe refresh. Disconnect and reconnect.",
      );
    }
    const generation = this.#generation;
    if (toolName === "microsoft365.mail.search") {
      this.#requireCapability(access, "mail.read");
      const values = await decodeMailSearchInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const query = values.query?.trim() ?? "";
      const limit = values.limit ?? 10;
      const params = new URLSearchParams({
        $select: "id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments",
        $top: String(limit),
      });
      if (query) {
        params.set("$search", '"' + query.replaceAll('"', " ").replaceAll("\\", " ") + '"');
      } else params.set("$orderby", "receivedDateTime desc");
      const result = await this.#graph(`/me/messages?${params.toString()}`, access.value, {
        signal: context?.signal,
      });
      this.#assertInvocationCurrent(generation);
      return mailSearchResult(result, limit);
    }
    if (toolName === "microsoft365.mail.get") {
      this.#requireCapability(access, "mail.read");
      const values = await decodeMailGetInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const params = new URLSearchParams({
        $select: "id,subject,from,receivedDateTime,isRead,body",
      });
      const result = await this.#graph(
        `/me/messages/${encodeURIComponent(values.messageId)}?${params.toString()}`,
        access.value,
        { preferPlainTextBody: true, signal: context?.signal },
      );
      this.#assertInvocationCurrent(generation);
      return mailGetResult(result);
    }
    if (toolName === "microsoft365.mail.folders.list") {
      this.#requireCapability(access, "mail.read");
      const values = await decodeMailFolderListInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const limit = values.limit ?? 50;
      const basePath = values.parentFolderId
        ? `/me/mailFolders/${encodeURIComponent(values.parentFolderId)}/childFolders`
        : "/me/mailFolders";
      const params = new URLSearchParams({
        $top: String(limit),
        $select:
          "id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount,isHidden",
        includeHiddenFolders: "true",
      });
      const result = await this.#graph(`${basePath}?${params.toString()}`, access.value, {
        signal: context?.signal,
      });
      this.#assertInvocationCurrent(generation);
      return collectionResult(result, limit);
    }
    if (toolName === "microsoft365.mail.folder.create") {
      this.#requireCapability(access, "mail.organize");
      const values = await decodeMailFolderCreateInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const basePath = values.parentFolderId
        ? `/me/mailFolders/${encodeURIComponent(values.parentFolderId)}/childFolders`
        : "/me/mailFolders";
      const commitSignal = await this.#beginInvocationCommit(context);
      this.#assertInvocationCurrent(generation);
      if (values.parentFolderId) {
        await this.#assertMailFolderOutsideDeletionHierarchy(
          values.parentFolderId,
          access.value,
          generation,
          commitSignal,
        );
      }
      const result = await this.#graph(basePath, access.value, {
        method: "POST",
        body: { displayName: values.displayName.trim() },
        signal: commitSignal,
      });
      this.#assertInvocationCurrent(generation);
      return mailFolderReceipt(result);
    }
    if (toolName === "microsoft365.mail.message.move") {
      this.#requireCapability(access, "mail.organize");
      const values = await decodeMailMessageMoveInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const destinationFolderId = values.destinationFolderId.trim();
      const commitSignal = await this.#beginInvocationCommit(context);
      this.#assertInvocationCurrent(generation);
      await this.#assertMailFolderOutsideDeletionHierarchy(
        destinationFolderId,
        access.value,
        generation,
        commitSignal,
      );
      const result = await this.#graph(
        `/me/messages/${encodeURIComponent(values.messageId)}/move`,
        access.value,
        {
          method: "POST",
          body: { destinationId: destinationFolderId },
          signal: commitSignal,
        },
      );
      this.#assertInvocationCurrent(generation);
      return mailMoveReceipt(result);
    }
    if (toolName === "microsoft365.mail.attachments.list") {
      this.#requireCapability(access, "mail.read");
      const values = await decodeMailAttachmentListInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const limit = values.limit ?? 25;
      const params = new URLSearchParams({
        $top: String(limit),
        $select: "id,name,contentType,size,isInline,lastModifiedDateTime",
      });
      const result = await this.#graph(
        `/me/messages/${encodeURIComponent(values.messageId)}/attachments?${params.toString()}`,
        access.value,
        { signal: context?.signal },
      );
      this.#assertInvocationCurrent(generation);
      return attachmentListResult(result, limit);
    }
    if (toolName === "microsoft365.mail.attachment.get") {
      this.#requireCapability(access, "mail.read");
      const values = await decodeMailAttachmentGetInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const result = await this.#graph(
        `/me/messages/${encodeURIComponent(values.messageId)}/attachments/${encodeURIComponent(values.attachmentId)}?$expand=microsoft.graph.itemattachment/item`,
        access.value,
        {
          signal: context?.signal,
          maximumResponseBytes: GRAPH_ATTACHMENT_RESPONSE_BYTES,
        },
      );
      this.#assertInvocationCurrent(generation);
      return attachmentResult(result);
    }
    if (toolName === "microsoft365.mail.draft.create") {
      this.#requireCapability(access, "mail.draft.create");
      const values = await decodeMailDraftCreateInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const body = {
        subject: values.subject,
        body: { contentType: "text", content: values.body },
        toRecipients: recipients(values.to),
        ccRecipients: recipients(values.cc ?? []),
        bccRecipients: recipients(values.bcc ?? []),
        ...(values.attachments === undefined
          ? {}
          : {
              attachments: values.attachments.map((attachment) => ({
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: attachment.name,
                contentBytes: attachment.contentBytes,
                ...(attachment.contentType === undefined
                  ? {}
                  : { contentType: attachment.contentType }),
              })),
            }),
      };
      if (encoder.encode(JSON.stringify(body)).byteLength > MAX_DRAFT_REQUEST_BYTES) {
        throw new IntegrationProviderPublicError(
          "Mail draft is too large; its encoded request must be at most 4 MB.",
        );
      }
      const commitSignal = await this.#beginInvocationCommit(context);
      this.#assertInvocationCurrent(generation);
      const result = await this.#graph("/me/messages", access.value, {
        method: "POST",
        body,
        signal: commitSignal,
      });
      this.#assertInvocationCurrent(generation);
      return mailDraftResult(result);
    }
    if (toolName === "microsoft365.calendar.events") {
      this.#requireCapability(access, "calendar.read");
      const values = await decodeCalendarEventsInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const defaultStart = isoTimestamp(values.start ?? new Date().toISOString());
      const { start, end } = calendarRange(
        defaultStart,
        values.end ?? new Date(Date.parse(defaultStart) + 7 * 86_400_000).toISOString(),
      );
      const params = new URLSearchParams({
        startDateTime: start,
        endDateTime: end,
        $top: "50",
        $orderby: "start/dateTime",
        $select: "id,subject,start,end,location,organizer,bodyPreview,hasAttachments",
      });
      const result = await this.#graph(`/me/calendarView?${params.toString()}`, access.value, {
        signal: context?.signal,
      });
      this.#assertInvocationCurrent(generation);
      return calendarResult(result);
    }
    if (toolName === "microsoft365.calendar.event.get") {
      this.#requireCapability(access, "calendar.read");
      const values = await decodeCalendarEventGetInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const result = await this.#graph(
        `/me/events/${encodeURIComponent(values.eventId)}`,
        access.value,
        { signal: context?.signal },
      );
      this.#assertInvocationCurrent(generation);
      return eventResult(result);
    }
    if (toolName === "microsoft365.calendar.event.attachments.list") {
      this.#requireCapability(access, "calendar.read");
      const values = await decodeCalendarAttachmentListInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const limit = values.limit ?? 25;
      const params = new URLSearchParams({
        $top: String(limit),
        $select: "id,name,contentType,size,isInline,lastModifiedDateTime",
      });
      const result = await this.#graph(
        `/me/events/${encodeURIComponent(values.eventId)}/attachments?${params.toString()}`,
        access.value,
        { signal: context?.signal },
      );
      this.#assertInvocationCurrent(generation);
      return attachmentListResult(result, limit);
    }
    if (toolName === "microsoft365.calendar.event.attachment.get") {
      this.#requireCapability(access, "calendar.read");
      const values = await decodeCalendarAttachmentGetInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const result = await this.#graph(
        `/me/events/${encodeURIComponent(values.eventId)}/attachments/${encodeURIComponent(values.attachmentId)}?$expand=microsoft.graph.itemattachment/item`,
        access.value,
        {
          signal: context?.signal,
          maximumResponseBytes: GRAPH_ATTACHMENT_RESPONSE_BYTES,
        },
      );
      this.#assertInvocationCurrent(generation);
      return attachmentResult(result);
    }
    if (toolName === "microsoft365.calendar.event.create") {
      this.#requireCapability(access, "calendar.write");
      const values = await decodeCalendarEventCreateInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const body = eventBody(values);
      const commitSignal = await this.#beginInvocationCommit(context);
      this.#assertInvocationCurrent(generation);
      const result = await this.#graph("/me/events", access.value, {
        method: "POST",
        body,
        signal: commitSignal,
      });
      this.#assertInvocationCurrent(generation);
      return eventResult(result);
    }
    if (toolName === "microsoft365.calendar.event.update") {
      this.#requireCapability(access, "calendar.write");
      const values = await decodeCalendarEventUpdateInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const hasStart = values.start !== undefined;
      const hasEnd = values.end !== undefined;
      if (hasStart !== hasEnd) {
        throw new IntegrationProviderPublicError(
          "Calendar event updates must provide start and end together.",
        );
      }
      const hasMutation = [values.subject, values.start, values.location, values.attendees].some(
        (value) => value !== undefined,
      );
      if (!hasMutation) {
        throw new IntegrationProviderPublicError(
          "Calendar event update must include at least one changed field.",
        );
      }
      if (values.start !== undefined && values.end !== undefined) {
        calendarRange(values.start, values.end);
      }
      const body = {
        ...(values.subject === undefined ? {} : { subject: values.subject }),
        ...(values.start === undefined ? {} : { start: graphUtcDateTime(values.start) }),
        ...(values.end === undefined ? {} : { end: graphUtcDateTime(values.end) }),
        ...(values.location === undefined ? {} : { location: { displayName: values.location } }),
        ...(values.attendees === undefined ? {} : { attendees: attendees(values.attendees) }),
      };
      const commitSignal = await this.#beginInvocationCommit(context);
      this.#assertInvocationCurrent(generation);
      const result = await this.#graph(
        `/me/events/${encodeURIComponent(values.eventId)}`,
        access.value,
        { method: "PATCH", body, signal: commitSignal },
      );
      this.#assertInvocationCurrent(generation);
      return eventResult(result);
    }
    if (toolName === "microsoft365.chat.list") {
      this.#requireCapability(access, "chat.read");
      const values = await decodeChatListInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const limit = values.limit ?? 10;
      const params = new URLSearchParams({ $top: String(limit) });
      const result = await this.#graph(`/me/chats?${params.toString()}`, access.value, {
        signal: context?.signal,
      });
      this.#assertInvocationCurrent(generation);
      return chatsResult(result, limit);
    }
    if (toolName === "microsoft365.chat.messages") {
      this.#requireCapability(access, "chat.read");
      const values = await decodeChatMessagesInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const limit = values.limit ?? 20;
      const params = new URLSearchParams({
        $top: String(limit),
        $orderby: "createdDateTime desc",
      });
      const result = await this.#graph(
        `/chats/${encodeURIComponent(values.chatId)}/messages?${params.toString()}`,
        access.value,
        { signal: context?.signal },
      );
      this.#assertInvocationCurrent(generation);
      return chatMessagesResult(result, limit);
    }
    if (toolName === "microsoft365.chat.message.send") {
      this.#requireCapability(access, "chat.write");
      const values = await decodeChatMessageSendInput(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      const body = { body: { contentType: "text", content: values.body } };
      if (encoder.encode(JSON.stringify(body)).byteLength > MAX_CHAT_REQUEST_BYTES) {
        throw new IntegrationProviderPublicError(
          "Chat message is too large; its encoded request must be at most 28 KB.",
        );
      }
      const commitSignal = await this.#beginInvocationCommit(context);
      this.#assertInvocationCurrent(generation);
      const result = await this.#graph(
        `/chats/${encodeURIComponent(values.chatId)}/messages`,
        access.value,
        {
          method: "POST",
          body,
          signal: commitSignal,
        },
      );
      this.#assertInvocationCurrent(generation);
      return chatMessageResult(result);
    }
    throw new Error("Unsupported Microsoft 365 tool.");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#pending.clear();
    this.#accessToken = null;
    for (const controller of this.#requestControllers) controller.abort();
    await this.#credentialMutation;
  }
}
