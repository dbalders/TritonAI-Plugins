// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off cryptoRandomUUID:off
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import {
  type IntegrationAuthorizationUrlConnectResult,
  type IntegrationConnectionSubmission,
  type IntegrationInvocationContext,
  type IntegrationLifecycleContext,
  type IntegrationProvider,
  IntegrationProviderPublicError,
  type IntegrationProviderPollResult,
  type IntegrationProviderStatus,
  type IntegrationProviderTool,
  type IntegrationSecretStore,
} from "./host-contract.js";

/** Package-local suffix; Harness adds the collision-free package namespace. */
export const GOOGLE_WORKSPACE_SECRET_SUFFIX = "oauth";
export const GOOGLE_WORKSPACE_PROVIDER_ID = "google-workspace";

const HOSTED_DOMAIN = "ucsd.edu";
const GOOGLE_ISSUER = "https://accounts.google.com";
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const DOCS_API = "https://docs.googleapis.com/v1";
const SHEETS_API = "https://sheets.googleapis.com/v4";
const SLIDES_API = "https://slides.googleapis.com/v1";
const CALLBACK_PATH = "/oauth2/callback";

const SCOPE_OPENID = "openid";
const SCOPE_EMAIL = "email";
const SCOPE_PROFILE = "profile";
const SCOPE_DRIVE_READ = "https://www.googleapis.com/auth/drive.readonly";
const SCOPE_DOCS_READ = "https://www.googleapis.com/auth/documents.readonly";
const SCOPE_SHEETS_READ = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SCOPE_SLIDES_READ = "https://www.googleapis.com/auth/presentations.readonly";
const SCOPE_GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const SCOPE_GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const SCOPE_CALENDAR_LIST_READ = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const SCOPE_CALENDAR_EVENTS_READ = "https://www.googleapis.com/auth/calendar.events.readonly";
const SCOPE_CALENDAR_EVENTS_WRITE = "https://www.googleapis.com/auth/calendar.events";

const CAPABILITY_SCOPES = {
  "identity.read": [SCOPE_OPENID, SCOPE_EMAIL, SCOPE_PROFILE],
  "drive.read": [SCOPE_DRIVE_READ, SCOPE_DOCS_READ, SCOPE_SHEETS_READ, SCOPE_SLIDES_READ],
  "mail.read": [SCOPE_GMAIL_READ],
  "mail.draft.create": [SCOPE_GMAIL_COMPOSE],
  "calendar.read": [SCOPE_CALENDAR_LIST_READ, SCOPE_CALENDAR_EVENTS_READ],
  "calendar.write": [SCOPE_CALENDAR_EVENTS_WRITE],
} as const;

const CAPABILITY_NAMES = new Set<string>(Object.keys(CAPABILITY_SCOPES));
const ALL_SCOPES = new Set<string>(Object.values(CAPABILITY_SCOPES).flat());
const WRITE_TOOLS = new Set([
  "googleworkspace.mail.draft.create",
  "googleworkspace.calendar.event.create",
  "googleworkspace.calendar.event.update",
]);

const GOOGLE_CLIENT_ID = /^\d{6,30}-[a-z0-9]{8,128}\.apps\.googleusercontent\.com$/u;
const GOOGLE_CLIENT_SECRET = /^[A-Za-z0-9_-]{16,256}$/u;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const FLOW_LIFETIME_MS = 5 * 60_000;
const FLOW_POLL_SECONDS = 2;
const CURSOR_LIFETIME_MS = 15 * 60_000;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const IDENTITY_RESPONSE_BYTES = 256 * 1024;
const JSON_RESPONSE_BYTES = 1024 * 1024;
const MAIL_THREAD_RESPONSE_BYTES = 4 * 1024 * 1024;
const LARGE_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_TOKEN_CHARS = 16_384;
const MAX_BODY_CHARS = 100_000;
const MAX_CALENDAR_RANGE_MS = 31 * 86_400_000;
const MAX_CURSOR_CHARS = 4_096;
const MAX_PAGE_TOKEN_CHARS = 2_048;
const MAX_DRAFT_REQUEST_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface GoogleWorkspaceConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
}

const BoundedResourceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[^\s/?#]+$/u),
);

const OptionalCursor = Schema.optionalKey(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CURSOR_CHARS),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
  ).annotate({ description: "Opaque cursor returned by the same tool and query." }),
);

const Limit = Schema.optionalKey(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
    description: "Maximum number of results (1-50).",
  }),
);

const EmailAddress = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
).annotate({ description: "One email address." });

const DriveSearchInput = Schema.Struct({
  text: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description: "Text that must occur in indexed Drive content or the item name.",
    }),
  ),
  kind: Schema.optionalKey(
    Schema.Literals(["any", "folder", "document", "spreadsheet", "presentation", "pdf"]).annotate({
      description: "Optional fixed Drive item type filter.",
    }),
  ),
  limit: Limit,
  cursor: OptionalCursor,
});

const DriveItemGetInput = Schema.Struct({
  itemId: BoundedResourceId.annotate({ description: "Exact Google Drive item identifier." }),
});

const DriveContentGetInput = Schema.Struct({
  itemId: BoundedResourceId.annotate({ description: "Exact Google Drive item identifier." }),
  format: Schema.optionalKey(
    Schema.Literals(["auto", "text", "csv", "pdf"]).annotate({
      description: "Fixed export format for native Workspace files; defaults to auto.",
    }),
  ),
});

const DocsGetInput = Schema.Struct({
  documentId: BoundedResourceId.annotate({ description: "Exact Google Docs document identifier." }),
});

const SheetsGetInput = Schema.Struct({
  spreadsheetId: BoundedResourceId.annotate({
    description: "Exact Google Sheets spreadsheet identifier.",
  }),
  range: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(256),
      Schema.isPattern(/^[^\p{Cc}]+$/u),
    ).annotate({ description: "Optional bounded A1 range." }),
  ),
});

const SlidesGetInput = Schema.Struct({
  presentationId: BoundedResourceId.annotate({
    description: "Exact Google Slides presentation identifier.",
  }),
});

const GmailSearchInput = Schema.Struct({
  text: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description: "Plain text to search for in Gmail.",
    }),
  ),
  from: Schema.optionalKey(EmailAddress),
  to: Schema.optionalKey(EmailAddress),
  after: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)).annotate({
      description: "Inclusive sent date in YYYY-MM-DD form.",
    }),
  ),
  before: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)).annotate({
      description: "Exclusive sent date in YYYY-MM-DD form.",
    }),
  ),
  hasAttachment: Schema.optionalKey(Schema.Boolean),
  labelIds: Schema.optionalKey(
    Schema.Array(BoundedResourceId).check(Schema.isMaxLength(10)).annotate({
      description: "Exact Gmail label identifiers (0-10).",
    }),
  ),
  limit: Limit,
  cursor: OptionalCursor,
});

const GmailMessageGetInput = Schema.Struct({
  messageId: BoundedResourceId.annotate({ description: "Exact Gmail message identifier." }),
});

const GmailThreadGetInput = Schema.Struct({
  threadId: BoundedResourceId.annotate({ description: "Exact Gmail thread identifier." }),
});

const GmailAttachmentGetInput = Schema.Struct({
  messageId: BoundedResourceId.annotate({ description: "Exact Gmail message identifier." }),
  attachmentId: BoundedResourceId.annotate({ description: "Exact Gmail attachment identifier." }),
});

const GmailDraftCreateInput = Schema.Struct({
  to: Schema.Array(EmailAddress).check(Schema.isMinLength(1), Schema.isMaxLength(20)).annotate({
    description: "Primary recipients (1-20).",
  }),
  cc: Schema.optionalKey(
    Schema.Array(EmailAddress).check(Schema.isMaxLength(20)).annotate({
      description: "Optional CC recipients (0-20).",
    }),
  ),
  bcc: Schema.optionalKey(
    Schema.Array(EmailAddress).check(Schema.isMaxLength(20)).annotate({
      description: "Optional BCC recipients (0-20).",
    }),
  ),
  subject: Schema.String.check(Schema.isMaxLength(998)).annotate({
    description: "Draft subject (maximum 998 characters).",
  }),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50_000)).annotate({
    description: "Plain-text draft body.",
  }),
});

const CalendarListInput = Schema.Struct({
  limit: Limit,
  cursor: OptionalCursor,
});

const CalendarId = Schema.optionalKey(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_024),
    Schema.isPattern(/^[^\p{Cc}/?#]+$/u),
  ).annotate({ description: "Exact calendar identifier; defaults to primary." }),
);

const IsoTimestamp = Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(64)).annotate({
  description: "ISO 8601 timestamp with an explicit offset.",
});

const CalendarEventsListInput = Schema.Struct({
  calendarId: CalendarId,
  start: IsoTimestamp.annotate({ description: "Inclusive ISO 8601 start timestamp." }),
  end: IsoTimestamp.annotate({
    description: "Exclusive ISO 8601 end timestamp, no more than 31 days after start.",
  }),
  limit: Limit,
  cursor: OptionalCursor,
});

const CalendarEventGetInput = Schema.Struct({
  calendarId: CalendarId,
  eventId: BoundedResourceId.annotate({ description: "Exact Google Calendar event identifier." }),
});

const CalendarEventFields = {
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)).annotate({
    description: "Event title.",
  }),
  start: IsoTimestamp.annotate({ description: "Inclusive event start." }),
  end: IsoTimestamp.annotate({ description: "Exclusive event end." }),
  location: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(1_000)).annotate({
      description: "Optional location.",
    }),
  ),
  description: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(50_000)).annotate({
      description: "Optional plain-text event description.",
    }),
  ),
};

const CalendarEventCreateInput = Schema.Struct({
  calendarId: CalendarId,
  ...CalendarEventFields,
});

const CalendarEventUpdateInput = Schema.Struct({
  calendarId: CalendarId,
  eventId: BoundedResourceId.annotate({ description: "Exact Google Calendar event identifier." }),
  summary: Schema.optionalKey(CalendarEventFields.summary),
  start: Schema.optionalKey(CalendarEventFields.start),
  end: Schema.optionalKey(CalendarEventFields.end),
  location: CalendarEventFields.location,
  description: CalendarEventFields.description,
});

// Effect's empty Struct also accepts arrays; this is the exact empty object contract.
const EmptyInput = Schema.Record(Schema.String, Schema.Never);

const decodeDriveSearchInput = Schema.decodeUnknownPromise(DriveSearchInput);
const decodeDriveItemGetInput = Schema.decodeUnknownPromise(DriveItemGetInput);
const decodeDriveContentGetInput = Schema.decodeUnknownPromise(DriveContentGetInput);
const decodeDocsGetInput = Schema.decodeUnknownPromise(DocsGetInput);
const decodeSheetsGetInput = Schema.decodeUnknownPromise(SheetsGetInput);
const decodeSlidesGetInput = Schema.decodeUnknownPromise(SlidesGetInput);
const decodeGmailSearchInput = Schema.decodeUnknownPromise(GmailSearchInput);
const decodeGmailMessageGetInput = Schema.decodeUnknownPromise(GmailMessageGetInput);
const decodeGmailThreadGetInput = Schema.decodeUnknownPromise(GmailThreadGetInput);
const decodeGmailAttachmentGetInput = Schema.decodeUnknownPromise(GmailAttachmentGetInput);
const decodeGmailDraftCreateInput = Schema.decodeUnknownPromise(GmailDraftCreateInput);
const decodeCalendarListInput = Schema.decodeUnknownPromise(CalendarListInput);
const decodeCalendarEventsListInput = Schema.decodeUnknownPromise(CalendarEventsListInput);
const decodeCalendarEventGetInput = Schema.decodeUnknownPromise(CalendarEventGetInput);
const decodeCalendarEventCreateInput = Schema.decodeUnknownPromise(CalendarEventCreateInput);
const decodeCalendarEventUpdateInput = Schema.decodeUnknownPromise(CalendarEventUpdateInput);
const decodeEmptyInput = Schema.decodeUnknownPromise(EmptyInput);

export const GOOGLE_WORKSPACE_TOOLS = [
  {
    name: "googleworkspace.identity.get",
    description: "Read the verified connected Google identity without returning OAuth material.",
    input: EmptyInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.drive.search",
    description: "Search Drive through one fixed files.list endpoint and structured filters.",
    input: DriveSearchInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.drive.item.get",
    description: "Read metadata for one exact Drive item through files.get.",
    input: DriveItemGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.drive.content.get",
    description: "Read bounded content for one exact Drive item through files.get or files.export.",
    input: DriveContentGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.docs.get",
    description: "Read one exact document through the fixed Google Docs endpoint.",
    input: DocsGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.sheets.get",
    description: "Read one exact spreadsheet or A1 range through fixed Google Sheets endpoints.",
    input: SheetsGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.slides.get",
    description: "Read one exact presentation through the fixed Google Slides endpoint.",
    input: SlidesGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.mail.search",
    description: "Search Gmail through messages.list using structured bounded filters.",
    input: GmailSearchInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.mail.message.get",
    description: "Read one exact Gmail message through messages.get.",
    input: GmailMessageGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.mail.thread.get",
    description: "Read one exact Gmail thread through threads.get.",
    input: GmailThreadGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.mail.labels.list",
    description: "List Gmail label metadata through labels.list.",
    input: EmptyInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.mail.attachment.get",
    description: "Read one bounded attachment through Gmail attachments.get.",
    input: GmailAttachmentGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.mail.draft.create",
    description: "Create one unsent plain-text Gmail draft through drafts.create.",
    input: GmailDraftCreateInput,
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  {
    name: "googleworkspace.calendar.list",
    description: "List bounded calendar metadata through calendarList.list.",
    input: CalendarListInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.calendar.events.list",
    description: "List events in one bounded range through events.list.",
    input: CalendarEventsListInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.calendar.event.get",
    description: "Read one exact event through events.get.",
    input: CalendarEventGetInput,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  {
    name: "googleworkspace.calendar.event.create",
    description:
      "Create one narrow event through events.insert with sendUpdates disabled and no attendees.",
    input: CalendarEventCreateInput,
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  {
    name: "googleworkspace.calendar.event.update",
    description: "Patch narrow fields on one event through events.patch with sendUpdates disabled.",
    input: CalendarEventUpdateInput,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
] as const satisfies ReadonlyArray<IntegrationProviderTool>;

interface Credential {
  readonly version: 1;
  readonly refreshToken: string;
  readonly grantedScopes: ReadonlyArray<string>;
  readonly subject: string;
  readonly email: string;
  readonly updatedAt: string;
}

interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly grantedScopes: ReadonlyArray<string>;
  readonly subject: string;
  readonly email: string;
}

interface AuthorizationCodeResult {
  readonly kind: "code";
  readonly code: string;
}

interface AuthorizationErrorResult {
  readonly kind: "error";
  readonly error: string;
}

interface PendingFlow {
  readonly flowId: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly requestedScopes: ReadonlyArray<string>;
  readonly expectedSubject: string | null;
  readonly expectedEmail: string | null;
  readonly existingCredential: Credential | null;
  readonly expiresAt: number;
  readonly generation: number;
  readonly server: NodeHttp.Server;
  readonly timer: NodeJS.Timeout;
  callback: AuthorizationCodeResult | AuthorizationErrorResult | null;
  consumed: boolean;
  closePromise: Promise<void> | null;
}

interface CursorPayload {
  readonly version: 1;
  readonly tool: string;
  readonly binding: string;
  readonly subject: string;
  readonly pageToken: string;
  readonly expiresAt: number;
}

type Fetch = typeof globalThis.fetch;

function validateClientId(value: string): string {
  const normalized = value.trim();
  if (!GOOGLE_CLIENT_ID.test(normalized)) {
    throw new Error("Google Workspace requires a valid public desktop OAuth client ID.");
  }
  return normalized;
}

function validateClientSecret(value: string): string {
  const normalized = value.trim();
  if (!GOOGLE_CLIENT_SECRET.test(normalized)) {
    throw new Error("Google Workspace requires a valid desktop OAuth client credential.");
  }
  return normalized;
}

function asRecord(value: unknown, label = "Google response"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum: number, label = "Google response"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedOptionalString(
  value: unknown,
  maximum: number,
  label = "Google response",
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label = "Google response",
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

function parseIsoTimestamp(value: string, label: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds)) {
    throw new IntegrationProviderPublicError(`${label} must be an ISO 8601 timestamp.`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHours = zone === "Z" ? 0 : Number(zone?.slice(1, 3));
  const offsetMinutes = zone === "Z" ? 0 : Number(zone?.slice(4, 6));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] ?? 0) ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    throw new IntegrationProviderPublicError(`${label} must be an ISO 8601 timestamp.`);
  }
  return new Date(milliseconds).toISOString();
}

function calendarRange(startValue: string, endValue: string) {
  const start = parseIsoTimestamp(startValue, "Calendar start");
  const end = parseIsoTimestamp(endValue, "Calendar end");
  const range = Date.parse(end) - Date.parse(start);
  if (range <= 0 || range > MAX_CALENDAR_RANGE_MS) {
    throw new IntegrationProviderPublicError(
      "Calendar range must be positive and no longer than 31 days.",
    );
  }
  return { start, end };
}

function normalizeScope(scope: string): string {
  if (scope === "https://www.googleapis.com/auth/userinfo.email") return SCOPE_EMAIL;
  if (scope === "https://www.googleapis.com/auth/userinfo.profile") return SCOPE_PROFILE;
  return scope;
}

function canonicalGrantedScopes(
  value: unknown,
  requested: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (value === undefined) return [...new Set(requested)].toSorted();
  const raw = boundedString(value, 8_192).split(/\s+/u).filter(Boolean).map(normalizeScope);
  if (
    raw.length === 0 ||
    new Set(raw).size !== raw.length ||
    requested.some((scope) => !raw.includes(scope))
  ) {
    throw new Error("Google returned an unexpected OAuth scope grant.");
  }
  return [...new Set(requested)].toSorted();
}

function capabilitiesFromScopes(scopes: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.entries(CAPABILITY_SCOPES)
    .filter(([, required]) => required.every((scope) => scopes.includes(scope)))
    .map(([capability]) => capability)
    .toSorted();
}

function requestedScopesForCapabilities(
  capabilities: ReadonlyArray<string>,
  existing: Credential | null,
): ReadonlyArray<string> {
  const scopes = new Set(existing?.grantedScopes ?? []);
  for (const scope of CAPABILITY_SCOPES["identity.read"]) scopes.add(scope);
  for (const capability of capabilities) {
    for (const scope of CAPABILITY_SCOPES[capability as keyof typeof CAPABILITY_SCOPES]) {
      scopes.add(scope);
    }
  }
  return [...scopes].toSorted();
}

function parseCredential(bytes: Uint8Array): Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("Stored Google Workspace credential is invalid.");
  }
  const value = asRecord(parsed, "Stored Google Workspace credential");
  if (
    !exactKeys(
      value,
      new Set(["version", "refreshToken", "grantedScopes", "subject", "email", "updatedAt"]),
    ) ||
    value.version !== 1 ||
    !Array.isArray(value.grantedScopes) ||
    value.grantedScopes.length === 0 ||
    value.grantedScopes.some((scope) => typeof scope !== "string" || !ALL_SCOPES.has(scope)) ||
    new Set(value.grantedScopes).size !== value.grantedScopes.length ||
    typeof value.subject !== "string" ||
    value.subject.length === 0 ||
    value.subject.length > 255 ||
    typeof value.email !== "string" ||
    value.email.length > 320 ||
    !value.email.toLowerCase().endsWith(`@${HOSTED_DOMAIN}`) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error("Stored Google Workspace credential is invalid.");
  }
  return {
    version: 1,
    refreshToken: boundedString(
      value.refreshToken,
      MAX_TOKEN_CHARS,
      "Stored Google Workspace credential",
    ),
    grantedScopes: [...value.grantedScopes].toSorted() as ReadonlyArray<string>,
    subject: value.subject,
    email: value.email.toLowerCase(),
    updatedAt: value.updatedAt,
  };
}

async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("Google response exceeded the allowed size.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Google response exceeded the allowed size.");
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
  return bytes;
}

function parseJsonResponse(response: Response, bytes: Uint8Array): Record<string, unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json")) {
    throw new Error("Google returned an invalid content type.");
  }
  try {
    return asRecord(JSON.parse(decoder.decode(bytes)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Google ")) throw error;
    throw new Error("Google returned invalid JSON.");
  }
}

function randomBase64Url(bytes: number): string {
  return NodeCrypto.randomBytes(bytes).toString("base64url");
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

function stableBinding(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function googleSearchLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function gmailSearchLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function assertValidDate(value: string, label: string): string {
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    throw new IntegrationProviderPublicError(`${label} must be a real YYYY-MM-DD date.`);
  }
  return value;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseBase64UrlJson(value: string, maximumBytes: number): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > Math.ceil((maximumBytes * 4) / 3) + 4) {
    throw new Error("Encoded Google value is invalid.");
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.byteLength > maximumBytes) throw new Error("Encoded Google value is invalid.");
    return asRecord(JSON.parse(decoder.decode(bytes)));
  } catch (error) {
    if (error instanceof Error && error.message.includes("Encoded Google")) throw error;
    throw new Error("Encoded Google value is invalid.");
  }
}

function projectDriveFile(value: unknown) {
  const item = asRecord(value, "Google Drive item");
  const ownerValues = item.owners;
  const owners =
    ownerValues === undefined
      ? []
      : Array.isArray(ownerValues) && ownerValues.length <= 20
        ? ownerValues.map((owner) => {
            const record = asRecord(owner, "Google Drive owner");
            return {
              displayName: boundedOptionalString(record.displayName, 512, "Google Drive owner"),
              emailAddress: boundedOptionalString(record.emailAddress, 320, "Google Drive owner"),
            };
          })
        : (() => {
            throw new Error("Google Drive owner list is invalid.");
          })();
  return {
    id: boundedString(item.id, 1_024, "Google Drive item"),
    name: boundedString(item.name, 32_768, "Google Drive item"),
    mimeType: boundedString(item.mimeType, 255, "Google Drive item"),
    createdTime: boundedOptionalString(item.createdTime, 64, "Google Drive item"),
    modifiedTime: boundedOptionalString(item.modifiedTime, 64, "Google Drive item"),
    size: boundedOptionalString(item.size, 32, "Google Drive item"),
    driveId: boundedOptionalString(item.driveId, 1_024, "Google Drive item"),
    parents:
      item.parents === undefined
        ? []
        : Array.isArray(item.parents) && item.parents.length <= 100
          ? item.parents.map((parent) => boundedString(parent, 1_024, "Google Drive parent"))
          : (() => {
              throw new Error("Google Drive parent list is invalid.");
            })(),
    shared: item.shared === true,
    starred: item.starred === true,
    owners,
  };
}

function projectCalendarEvent(value: unknown) {
  const event = asRecord(value, "Google Calendar event");
  const projectDate = (raw: unknown) => {
    const date = asRecord(raw, "Google Calendar date");
    return {
      dateTime: boundedOptionalString(date.dateTime, 64, "Google Calendar date"),
      date: boundedOptionalString(date.date, 32, "Google Calendar date"),
      timeZone: boundedOptionalString(date.timeZone, 255, "Google Calendar date"),
    };
  };
  const projectIdentity = (raw: unknown) => {
    if (raw === undefined || raw === null) return null;
    const identity = asRecord(raw, "Google Calendar identity");
    return {
      id: boundedOptionalString(identity.id, 1_024, "Google Calendar identity"),
      email: boundedOptionalString(identity.email, 320, "Google Calendar identity"),
      displayName: boundedOptionalString(identity.displayName, 512, "Google Calendar identity"),
      self: identity.self === true,
    };
  };
  const conference =
    event.conferenceData === undefined || event.conferenceData === null
      ? null
      : (() => {
          const data = asRecord(event.conferenceData, "Google Calendar conference");
          const solution =
            data.conferenceSolution === undefined
              ? null
              : asRecord(data.conferenceSolution, "Google Calendar conference");
          const key =
            solution?.key === undefined
              ? null
              : asRecord(solution.key, "Google Calendar conference");
          const entryPoints = Array.isArray(data.entryPoints)
            ? data.entryPoints.slice(0, 20).map((raw) => {
                const entry = asRecord(raw, "Google Calendar conference");
                const uri = boundedOptionalString(entry.uri, 2_048, "Google Calendar conference");
                if (uri !== null) {
                  const parsed = new URL(uri);
                  if (!["https:", "tel:"].includes(parsed.protocol)) {
                    throw new Error("Google Calendar conference URI is invalid.");
                  }
                }
                return {
                  type: boundedOptionalString(
                    entry.entryPointType,
                    64,
                    "Google Calendar conference",
                  ),
                  uri,
                  label: boundedOptionalString(entry.label, 512, "Google Calendar conference"),
                };
              })
            : [];
          return {
            conferenceId: boundedOptionalString(
              data.conferenceId,
              512,
              "Google Calendar conference",
            ),
            solutionName: boundedOptionalString(solution?.name, 512, "Google Calendar conference"),
            solutionType: boundedOptionalString(key?.type, 128, "Google Calendar conference"),
            entryPoints,
          };
        })();
  const attachments = Array.isArray(event.attachments)
    ? event.attachments.slice(0, 25).map((raw) => {
        const attachment = asRecord(raw, "Google Calendar attachment");
        return {
          fileId: boundedOptionalString(attachment.fileId, 1_024, "Google Calendar attachment"),
          title: boundedOptionalString(attachment.title, 32_768, "Google Calendar attachment"),
          mimeType: boundedOptionalString(attachment.mimeType, 255, "Google Calendar attachment"),
        };
      })
    : [];
  return {
    id: boundedString(event.id, 1_024, "Google Calendar event"),
    status: boundedOptionalString(event.status, 64, "Google Calendar event"),
    summary: boundedOptionalString(event.summary, 1_000, "Google Calendar event"),
    description: boundedOptionalString(event.description, 50_000, "Google Calendar event"),
    location: boundedOptionalString(event.location, 1_000, "Google Calendar event"),
    start: projectDate(event.start),
    end: projectDate(event.end),
    organizer: projectIdentity(event.organizer),
    creator: projectIdentity(event.creator),
    recurringEventId: boundedOptionalString(event.recurringEventId, 1_024, "Google Calendar event"),
    hangoutLink: boundedOptionalString(event.hangoutLink, 2_048, "Google Calendar event"),
    conference,
    attachments,
  };
}

function gmailHeaderMap(value: unknown): Readonly<Record<string, string>> {
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error("Gmail headers are invalid.");
  }
  const allowed = new Set(["from", "to", "cc", "bcc", "subject", "date", "message-id", "reply-to"]);
  const result: Record<string, string> = Object.create(null);
  for (const raw of value) {
    const header = asRecord(raw, "Gmail header");
    const name = boundedString(header.name, 128, "Gmail header").toLowerCase();
    if (!allowed.has(name) || Object.hasOwn(result, name)) continue;
    result[name] = boundedString(header.value, 16_384, "Gmail header");
  }
  return result;
}

function decodeGmailText(value: unknown): string {
  if (typeof value !== "string" || value.length > 2 * 1024 * 1024) {
    throw new Error("Gmail body data is invalid.");
  }
  try {
    return decoder.decode(Buffer.from(value, "base64url")).slice(0, MAX_BODY_CHARS);
  } catch {
    throw new Error("Gmail body data is invalid.");
  }
}

function projectGmailMessage(value: unknown) {
  const message = asRecord(value, "Gmail message");
  const payload = asRecord(message.payload, "Gmail payload");
  const attachments: Array<{
    partId: string | null;
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
  }> = [];
  const text: string[] = [];
  const html: string[] = [];
  let partCount = 0;
  const visit = (raw: unknown, depth: number): void => {
    if (depth > 12 || partCount >= 250) throw new Error("Gmail message structure is too large.");
    partCount += 1;
    const part = asRecord(raw, "Gmail message part");
    const mimeType = boundedOptionalString(part.mimeType, 255, "Gmail message part") ?? "";
    const filename = boundedOptionalString(part.filename, 1_024, "Gmail message part") ?? "";
    const body = asRecord(part.body ?? {}, "Gmail message part");
    const attachmentId = boundedOptionalString(body.attachmentId, 1_024, "Gmail message part");
    const size =
      body.size === undefined ? 0 : boundedInteger(body.size, 0, 100 * 1024 * 1024, "Gmail part");
    if (attachmentId !== null) {
      attachments.push({
        partId: boundedOptionalString(part.partId, 512, "Gmail message part"),
        filename,
        mimeType,
        attachmentId,
        size,
      });
    } else if (body.data !== undefined && (mimeType === "text/plain" || mimeType === "text/html")) {
      const content = decodeGmailText(body.data);
      (mimeType === "text/plain" ? text : html).push(content);
    }
    if (part.parts !== undefined) {
      if (!Array.isArray(part.parts) || part.parts.length > 250) {
        throw new Error("Gmail message structure is too large.");
      }
      for (const child of part.parts) visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return {
    id: boundedString(message.id, 1_024, "Gmail message"),
    threadId: boundedString(message.threadId, 1_024, "Gmail message"),
    labelIds:
      message.labelIds === undefined
        ? []
        : Array.isArray(message.labelIds) && message.labelIds.length <= 100
          ? message.labelIds.map((label) => boundedString(label, 1_024, "Gmail label"))
          : (() => {
              throw new Error("Gmail label list is invalid.");
            })(),
    snippet: boundedOptionalString(message.snippet, 1_024, "Gmail message"),
    internalDate: boundedOptionalString(message.internalDate, 32, "Gmail message"),
    headers: gmailHeaderMap(payload.headers ?? []),
    body: {
      text: text.join("\n").slice(0, MAX_BODY_CHARS),
      html: html.join("\n").slice(0, MAX_BODY_CHARS),
    },
    attachments: attachments.slice(0, 100),
  };
}

function draftRawMessage(input: {
  readonly to: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string>;
  readonly bcc?: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
}): string {
  if (/[\r\n]/u.test(input.subject)) {
    throw new IntegrationProviderPublicError("Draft subject cannot contain line breaks.");
  }
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = input.body.replace(/\r?\n/gu, "\r\n");
  const raw = `${headers.join("\r\n")}\r\n\r\n${body}`;
  if (Buffer.byteLength(raw) > MAX_DRAFT_REQUEST_BYTES) {
    throw new IntegrationProviderPublicError("Draft exceeds the 128 KB request limit.");
  }
  return Buffer.from(raw).toString("base64url");
}

function eventBody(values: {
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly description?: string;
}) {
  const { start, end } = calendarRange(values.start, values.end);
  return {
    summary: values.summary,
    start: { dateTime: start },
    end: { dateTime: end },
    ...(values.location === undefined ? {} : { location: values.location }),
    ...(values.description === undefined ? {} : { description: values.description }),
  };
}

function verifyGoogleIdToken(
  idToken: string,
  jwks: Record<string, unknown>,
  clientId: string,
  nonce: string,
  expectedSubject: string | null,
): { readonly subject: string; readonly email: string } {
  if (idToken.length > MAX_TOKEN_CHARS) throw new Error("Google ID token is invalid.");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Google ID token is invalid.");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = parseBase64UrlJson(encodedHeader, 8 * 1024);
  const claims = parseBase64UrlJson(encodedClaims, 64 * 1024);
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.kid.length === 0 ||
    header.kid.length > 512
  ) {
    throw new Error("Google ID token header is invalid.");
  }
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0 || jwks.keys.length > 20) {
    throw new Error("Google signing keys are invalid.");
  }
  const rawKey = jwks.keys.find((candidate) => {
    const key = asRecord(candidate, "Google signing key");
    return key.kid === header.kid;
  });
  if (!rawKey) throw new Error("Google ID token signing key was not found.");
  const key = asRecord(rawKey, "Google signing key");
  if (
    key.kty !== "RSA" ||
    key.alg !== "RS256" ||
    key.use !== "sig" ||
    typeof key.n !== "string" ||
    typeof key.e !== "string" ||
    key.n.length > 2_048 ||
    key.e.length > 32
  ) {
    throw new Error("Google signing key is invalid.");
  }
  let publicKey: NodeCrypto.KeyObject;
  try {
    publicKey = NodeCrypto.createPublicKey({
      key: {
        kty: "RSA",
        kid: key.kid as string,
        alg: "RS256",
        use: "sig",
        n: key.n,
        e: key.e,
      },
      format: "jwk",
    });
  } catch {
    throw new Error("Google signing key is invalid.");
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error("Google ID token signature is invalid.");
  }
  if (
    signature.byteLength < 128 ||
    signature.byteLength > 1_024 ||
    !NodeCrypto.verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
      publicKey,
      signature,
    )
  ) {
    throw new Error("Google ID token signature is invalid.");
  }

  const nowSeconds = Math.floor(Date.now() / 1_000);
  const issuer = claims.iss;
  const audience = claims.aud;
  const expiresAt = claims.exp;
  const issuedAt = claims.iat;
  const subject = claims.sub;
  const email = claims.email;
  if (
    (issuer !== GOOGLE_ISSUER && issuer !== "accounts.google.com") ||
    audience !== clientId ||
    (claims.azp !== undefined && claims.azp !== clientId) ||
    !Number.isInteger(expiresAt) ||
    (expiresAt as number) <= nowSeconds - 60 ||
    (expiresAt as number) > nowSeconds + 86_400 ||
    !Number.isInteger(issuedAt) ||
    (issuedAt as number) > nowSeconds + 60 ||
    (issuedAt as number) < nowSeconds - 86_400 ||
    !timingSafeTextEqual(boundedString(claims.nonce, 512, "Google ID token"), nonce) ||
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.length > 255 ||
    (expectedSubject !== null && !timingSafeTextEqual(subject, expectedSubject)) ||
    typeof email !== "string" ||
    email.length > 320 ||
    claims.email_verified !== true ||
    claims.hd !== HOSTED_DOMAIN ||
    !email.toLowerCase().endsWith(`@${HOSTED_DOMAIN}`)
  ) {
    throw new Error("Google ID token identity is not an authorized UC San Diego account.");
  }
  return { subject, email: email.toLowerCase() };
}

export class GoogleWorkspaceProvider implements IntegrationProvider {
  readonly id = GOOGLE_WORKSPACE_PROVIDER_ID;
  readonly tools = GOOGLE_WORKSPACE_TOOLS;
  readonly #secrets: IntegrationSecretStore;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: Fetch;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingFlow>();
  readonly #polling = new Set<string>();
  readonly #requestControllers = new Set<AbortController>();
  readonly #cursorKey = NodeCrypto.randomBytes(32);
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
    configuration: GoogleWorkspaceConfiguration,
    fetchImplementation: Fetch = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.#secrets = secrets;
    this.#clientId = validateClientId(configuration.clientId);
    this.#clientSecret = validateClientSecret(configuration.clientSecret);
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new Error("Google Workspace requires a bounded request timeout.");
    }
    this.#fetch = fetchImplementation;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  #serializeCredential<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#credentialMutation.then(operation, operation);
    this.#credentialMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #request(
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<{ readonly response: Response; readonly bytes: Uint8Array }> {
    if (this.#closed) throw new Error("Google Workspace is closed.");
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    this.#requestControllers.add(controller);
    const signals = [controller.signal, timeoutSignal];
    if (init.signal) signals.push(init.signal);
    try {
      const response = await this.#fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
      return { response, bytes: await readResponseBytes(response, maximumBytes) };
    } catch (error) {
      if (init.signal?.aborted) {
        throw new Error("Google Workspace request was cancelled.", { cause: error });
      }
      if (controller.signal.aborted) {
        throw new Error("Google Workspace provider was closed.", { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new IntegrationProviderPublicError("Google Workspace request timed out.");
      }
      throw error;
    } finally {
      this.#requestControllers.delete(controller);
    }
  }

  async #requestJson(
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<{ readonly response: Response; readonly json: Record<string, unknown> }> {
    const { response, bytes } = await this.#request(url, init, maximumBytes);
    return { response, json: parseJsonResponse(response, bytes) };
  }

  async #apiJson(
    url: URL,
    accessToken: string,
    options: {
      readonly method?: "GET" | "POST" | "PATCH";
      readonly body?: unknown;
      readonly signal?: AbortSignal;
      readonly maximumBytes?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const { response, json } = await this.#requestJson(
      url.toString(),
      {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal ?? null,
      },
      options.maximumBytes ?? JSON_RESPONSE_BYTES,
    );
    if (response.ok) return json;
    throw this.#publicApiError(response, json);
  }

  async #apiBytes(
    url: URL,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<{ readonly response: Response; readonly bytes: Uint8Array }> {
    const { response, bytes } = await this.#request(
      url.toString(),
      {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
        signal: signal ?? null,
      },
      LARGE_RESPONSE_BYTES,
    );
    if (!response.ok) throw this.#publicApiError(response);
    return { response, bytes };
  }

  #publicApiError(
    response: Response,
    json?: Record<string, unknown>,
  ): IntegrationProviderPublicError {
    if (response.status === 401) {
      return new IntegrationProviderPublicError(
        "Google Workspace authorization expired. Disconnect and reconnect.",
      );
    }
    const error = json?.error;
    const reasons =
      error && typeof error === "object" && !Array.isArray(error)
        ? (error as Record<string, unknown>).errors
        : undefined;
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        Array.isArray(reasons) &&
        reasons.slice(0, 20).some((raw) => {
          const reason =
            raw && typeof raw === "object" && !Array.isArray(raw)
              ? (raw as Record<string, unknown>).reason
              : undefined;
          return (
            reason === "rateLimitExceeded" ||
            reason === "userRateLimitExceeded" ||
            reason === "quotaExceeded"
          );
        }));
    if (rateLimited) {
      const rawRetry = Number(response.headers.get("retry-after"));
      const retry =
        Number.isInteger(rawRetry) && rawRetry >= 1 && rawRetry <= 3_600
          ? ` Retry after about ${rawRetry} seconds.`
          : "";
      return new IntegrationProviderPublicError(
        `Google Workspace is rate limiting requests.${retry}`,
      );
    }
    if (response.status === 404) {
      return new IntegrationProviderPublicError(
        "The requested Google Workspace resource was not found or is not accessible.",
      );
    }
    if (response.status === 403) {
      return new IntegrationProviderPublicError(
        "Google Workspace denied this operation. The account, scope, or administrator policy may not allow it.",
      );
    }
    if (response.status === 400) {
      return new IntegrationProviderPublicError("Google Workspace rejected the bounded request.");
    }
    return new IntegrationProviderPublicError(
      "Google Workspace could not complete the operation. Try again later.",
    );
  }

  async #readCredential(signal?: AbortSignal): Promise<Credential | null> {
    const value = await Effect.runPromise(this.#secrets.get(GOOGLE_WORKSPACE_SECRET_SUFFIX), {
      signal,
    });
    return Option.isSome(value) ? parseCredential(value.value) : null;
  }

  #writeCredential(credential: Credential, signal: AbortSignal): Promise<void> {
    return Effect.runPromise(
      this.#secrets.set(GOOGLE_WORKSPACE_SECRET_SUFFIX, encoder.encode(JSON.stringify(credential))),
      { signal },
    );
  }

  async #beginCommit(context?: IntegrationLifecycleContext): Promise<AbortSignal> {
    if (!context || typeof context.beginCommit !== "function") {
      throw new Error("Google credential mutation requires Harness commit admission.");
    }
    return context.beginCommit();
  }

  async #closeFlowListener(flow: PendingFlow, clearExpiryTimer: boolean): Promise<void> {
    if (clearExpiryTimer) clearTimeout(flow.timer);
    if (flow.closePromise) {
      if (clearExpiryTimer) flow.server.closeAllConnections();
      return flow.closePromise;
    }
    flow.closePromise = new Promise<void>((resolve) => {
      if (!flow.server.listening) {
        resolve();
        return;
      }
      flow.server.close(() => resolve());
      flow.server.closeIdleConnections();
      if (clearExpiryTimer) flow.server.closeAllConnections();
    });
    return flow.closePromise;
  }

  async #removeFlow(flowId: string): Promise<void> {
    const flow = this.#pending.get(flowId);
    if (!flow) return;
    this.#pending.delete(flowId);
    await this.#closeFlowListener(flow, true);
  }

  async #clearPendingFlows(): Promise<void> {
    const flows = [...this.#pending.values()];
    this.#pending.clear();
    await Promise.all(flows.map((flow) => this.#closeFlowListener(flow, true)));
  }

  #writeCallbackPage(response: NodeHttp.ServerResponse, status: number, message: string): void {
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>TritonAI Harness</title></head><body><main><h1>${message}</h1><p>You can close this window and return to TritonAI Harness.</p></main></body></html>`;
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      connection: "close",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  #handleCallback(
    flow: PendingFlow,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ): void {
    const address = flow.server.address();
    const expectedHost = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
    const remote = request.socket.remoteAddress;
    if (
      request.method !== "GET" ||
      request.headers.host !== expectedHost ||
      (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") ||
      flow.expiresAt <= Date.now() ||
      flow.generation !== this.#generation ||
      this.#closed ||
      this.#disconnecting ||
      this.#pending.get(flow.flowId) !== flow
    ) {
      this.#writeCallbackPage(response, 400, "This sign-in callback is not valid.");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", `http://${expectedHost}`);
    } catch {
      this.#writeCallbackPage(response, 400, "This sign-in callback is not valid.");
      return;
    }
    const allowed = new Set([
      "state",
      "iss",
      "code",
      "scope",
      "authuser",
      "prompt",
      "hd",
      "error",
      "error_description",
      "error_uri",
    ]);
    if (
      url.pathname !== CALLBACK_PATH ||
      [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
      [...new Set(url.searchParams.keys())].some((key) => url.searchParams.getAll(key).length !== 1)
    ) {
      this.#writeCallbackPage(response, 400, "This sign-in callback is not valid.");
      return;
    }
    const responseIssuer = url.searchParams.get("iss");
    if (responseIssuer !== GOOGLE_ISSUER) {
      this.#writeCallbackPage(response, 400, "This sign-in callback is not valid.");
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    if (!timingSafeTextEqual(state, flow.state) || flow.consumed) {
      this.#writeCallbackPage(response, 400, "This sign-in callback is not valid.");
      return;
    }
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if ((code === null) === (oauthError === null)) {
      this.#writeCallbackPage(response, 400, "This sign-in callback is not valid.");
      return;
    }
    if (code !== null) {
      if (code.length === 0 || code.length > MAX_TOKEN_CHARS) {
        this.#writeCallbackPage(response, 400, "This sign-in callback is not valid.");
        return;
      }
      flow.consumed = true;
      flow.callback = { kind: "code", code };
      this.#writeCallbackPage(response, 200, "Google Workspace sign-in received.");
    } else {
      const errorCode =
        oauthError && oauthError.length <= 256 ? oauthError : "authorization_denied";
      flow.consumed = true;
      flow.callback = { kind: "error", error: errorCode };
      this.#writeCallbackPage(response, 200, "Google Workspace sign-in was not completed.");
    }
    response.once("finish", () => {
      void this.#closeFlowListener(flow, false);
    });
  }

  async #startFlowListener(
    input: Omit<
      PendingFlow,
      "server" | "timer" | "redirectUri" | "callback" | "consumed" | "closePromise"
    >,
    signal?: AbortSignal,
  ): Promise<PendingFlow> {
    let flow: PendingFlow | null = null;
    const server = NodeHttp.createServer((request, response) => {
      if (!flow) {
        this.#writeCallbackPage(response, 503, "This sign-in callback is not ready.");
        return;
      }
      this.#handleCallback(flow, request, response);
    });
    server.maxHeadersCount = 32;
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 1;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("Google loopback listener did not bind safely.");
    }
    const timer = setTimeout(
      () => {
        if (this.#pending.get(input.flowId) === flow) {
          this.#pending.delete(input.flowId);
          if (flow) void this.#closeFlowListener(flow, true);
        }
      },
      Math.max(1, input.expiresAt - Date.now()),
    );
    timer.unref();
    flow = {
      ...input,
      server,
      timer,
      redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
      callback: null,
      consumed: false,
      closePromise: null,
    };
    if (signal?.aborted || this.#closed || this.#disconnecting) {
      await this.#closeFlowListener(flow, true);
      throw new Error("Google sign-in was cancelled.");
    }
    return flow;
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
        message: "The Google Workspace provider is closed.",
      };
    }
    if (this.#disconnecting) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Google Workspace is disconnecting.",
      };
    }
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    try {
      const credential = await this.#readCredential(context?.signal);
      if (
        this.#closed ||
        this.#disconnecting ||
        this.#uncertainCredentialState ||
        generation !== this.#generation ||
        revision !== this.#credentialRevision
      ) {
        return {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "Google Workspace connection changed during its status check.",
        };
      }
      const expired = [...this.#pending.values()].filter(
        (flow) => flow.expiresAt <= Date.now() && !this.#polling.has(flow.flowId),
      );
      await Promise.all(expired.map((flow) => this.#removeFlow(flow.flowId)));
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
        accountLabel: credential.email,
        grantedCapabilities: capabilitiesFromScopes(credential.grantedScopes),
        message: `Connected to the verified ${HOSTED_DOMAIN} hosted domain.`,
      };
    } catch {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message:
          "The stored Google Workspace connection could not be verified. Disconnect to reset it.",
      };
    }
  }

  async connect(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<
    | IntegrationAuthorizationUrlConnectResult
    | {
        readonly kind: "connected";
        readonly flowId: string;
        readonly message: string;
      }
  > {
    if (submission !== undefined) {
      throw new Error("Google native-browser sign-in rejects credential submissions.");
    }
    if (this.#closed || this.#disconnecting) throw new Error("Google Workspace is unavailable.");
    if (this.#uncertainCredentialState) throw new Error("Google credential state is uncertain.");
    if (context?.signal.aborted) throw new Error("Google sign-in was cancelled.");
    if (
      capabilities.length === 0 ||
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) => !CAPABILITY_NAMES.has(capability))
    ) {
      throw new Error("Unsupported Google Workspace capability.");
    }
    const generation = this.#generation;
    const attempt = ++this.#connectAttempt;
    const revision = this.#credentialRevision;
    const existing = await this.#readCredential(context?.signal);
    if (
      generation !== this.#generation ||
      revision !== this.#credentialRevision ||
      attempt !== this.#connectAttempt
    ) {
      throw new Error("Google sign-in was superseded while starting.");
    }
    const requestedScopes = requestedScopesForCapabilities(capabilities, existing);
    await this.#clearPendingFlows();
    if (existing && requestedScopes.every((scope) => existing.grantedScopes.includes(scope))) {
      return {
        kind: "connected",
        flowId: NodeCrypto.randomUUID(),
        message: `Google Workspace is already authorized for ${existing.email}.`,
      };
    }
    const flowId = NodeCrypto.randomUUID();
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const codeChallenge = NodeCrypto.createHash("sha256")
      .update(codeVerifier, "ascii")
      .digest("base64url");
    const expiresAt = Date.now() + FLOW_LIFETIME_MS;
    const flow = await this.#startFlowListener(
      {
        flowId,
        state,
        nonce,
        codeVerifier,
        requestedScopes,
        expectedSubject: existing?.subject ?? null,
        expectedEmail: existing?.email ?? null,
        existingCredential: existing,
        expiresAt,
        generation,
      },
      context?.signal,
    );
    if (
      this.#closed ||
      this.#disconnecting ||
      this.#uncertainCredentialState ||
      generation !== this.#generation ||
      attempt !== this.#connectAttempt ||
      revision !== this.#credentialRevision
    ) {
      await this.#closeFlowListener(flow, true);
      throw new Error("Google sign-in was superseded while starting.");
    }
    this.#pending.set(flowId, flow);
    const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
    authorizationUrl.searchParams.set("client_id", this.#clientId);
    authorizationUrl.searchParams.set("redirect_uri", flow.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", requestedScopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set("include_granted_scopes", "true");
    authorizationUrl.searchParams.set("hd", HOSTED_DOMAIN);
    if (existing) authorizationUrl.searchParams.set("login_hint", existing.email);
    return {
      kind: "authorization_url",
      flowId,
      authorizationUrl: authorizationUrl.toString(),
      message: "Continue in your system browser with an authorized UC San Diego Google account.",
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: FLOW_POLL_SECONDS,
    };
  }

  async #revokeToken(token: string, signal: AbortSignal): Promise<void> {
    const { response } = await this.#request(
      REVOCATION_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal,
      },
      64 * 1024,
    );
    if (!response.ok) {
      throw new IntegrationProviderPublicError(
        "Google Workspace could not revoke the credential. Try disconnecting again.",
      );
    }
  }

  async poll(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult> {
    const flow = this.#pending.get(flowId);
    if (!flow) {
      throw new IntegrationProviderPublicError("Google Workspace sign-in flow was not found.");
    }
    if (this.#polling.has(flowId)) {
      throw new IntegrationProviderPublicError(
        "Google Workspace sign-in is already being checked.",
      );
    }
    if (flow.expiresAt <= Date.now()) {
      await this.#removeFlow(flowId);
      return {
        state: "expired",
        retryAfterSeconds: null,
        message: "Google Workspace sign-in expired. Start again.",
      };
    }
    if (flow.callback === null) {
      return {
        state: "pending",
        retryAfterSeconds: FLOW_POLL_SECONDS,
        message: "Waiting for Google Workspace sign-in.",
      };
    }
    if (flow.callback.kind === "error") {
      await this.#removeFlow(flowId);
      return {
        state: "failed",
        retryAfterSeconds: null,
        message:
          flow.callback.error === "access_denied"
            ? "Google Workspace sign-in was cancelled."
            : "Google Workspace sign-in did not complete. Start again.",
      };
    }
    if (this.#uncertainCredentialState) throw new Error("Google credential state is uncertain.");
    this.#polling.add(flowId);
    let admitted = false;
    let tokenResponseSettled = false;
    let credentialIssued = false;
    try {
      const { response: jwksResponse, json: jwks } = await this.#requestJson(
        JWKS_ENDPOINT,
        { method: "GET", signal: context?.signal ?? null },
        IDENTITY_RESPONSE_BYTES,
      );
      if (!jwksResponse.ok) {
        throw new IntegrationProviderPublicError(
          "Google identity verification is temporarily unavailable.",
        );
      }
      const commitSignal = await this.#beginCommit(context);
      admitted = true;
      const { response, json } = await this.#requestJson(
        TOKEN_ENDPOINT,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: this.#clientId,
            client_secret: this.#clientSecret,
            code: flow.callback.code,
            code_verifier: flow.codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: flow.redirectUri,
          }),
          signal: commitSignal,
        },
        IDENTITY_RESPONSE_BYTES,
      );
      tokenResponseSettled = true;
      if (
        this.#closed ||
        this.#disconnecting ||
        flow.generation !== this.#generation ||
        this.#pending.get(flowId) !== flow ||
        flow.expiresAt <= Date.now()
      ) {
        throw new Error("Google sign-in was superseded.");
      }
      if (!response.ok) {
        await this.#removeFlow(flowId);
        return {
          state: "failed",
          retryAfterSeconds: null,
          message: "Google Workspace sign-in failed. Start again.",
        };
      }
      credentialIssued = true;
      const accessToken = boundedString(json.access_token, MAX_TOKEN_CHARS);
      let validated:
        | {
            readonly expiresIn: number;
            readonly grantedScopes: ReadonlyArray<string>;
            readonly identity: { readonly subject: string; readonly email: string };
            readonly refreshToken: string;
          }
        | undefined;
      try {
        const expiresIn = boundedInteger(json.expires_in, 60, 86_400);
        const grantedScopes = canonicalGrantedScopes(json.scope, flow.requestedScopes);
        const identity = verifyGoogleIdToken(
          boundedString(json.id_token, MAX_TOKEN_CHARS),
          jwks,
          this.#clientId,
          flow.nonce,
          flow.expectedSubject,
        );
        if (
          flow.expectedEmail !== null &&
          !timingSafeTextEqual(identity.email, flow.expectedEmail)
        ) {
          throw new Error("Google account changed during incremental authorization.");
        }
        const refreshToken =
          json.refresh_token === undefined
            ? flow.existingCredential?.subject === identity.subject
              ? flow.existingCredential.refreshToken
              : null
            : boundedString(json.refresh_token, MAX_TOKEN_CHARS);
        if (!refreshToken) throw new Error("Google did not issue offline access.");
        validated = { expiresIn, grantedScopes, identity, refreshToken };
      } catch {
        await this.#revokeToken(accessToken, commitSignal);
        credentialIssued = false;
        await this.#removeFlow(flowId);
        return {
          state: "failed",
          retryAfterSeconds: null,
          message: "Sign-in did not produce a valid authorized UC San Diego credential.",
        };
      }
      const { expiresIn, grantedScopes, identity, refreshToken } = validated;
      const credential: Credential = {
        version: 1,
        refreshToken,
        grantedScopes,
        subject: identity.subject,
        email: identity.email,
        updatedAt: new Date().toISOString(),
      };
      await this.#serializeCredential(async () => {
        if (
          this.#closed ||
          this.#disconnecting ||
          this.#uncertainCredentialState ||
          flow.generation !== this.#generation ||
          this.#pending.get(flowId) !== flow
        ) {
          throw new Error("Google sign-in was superseded before credential commit.");
        }
        await this.#writeCredential(credential, commitSignal);
        this.#credentialRevision += 1;
        this.#generation += 1;
        this.#accessToken = {
          value: accessToken,
          expiresAt: Date.now() + expiresIn * 1_000,
          grantedScopes,
          subject: identity.subject,
          email: identity.email,
        };
      });
      await this.#removeFlow(flowId);
      return {
        state: "connected",
        retryAfterSeconds: null,
        message: `Google Workspace is connected for ${identity.email}.`,
      };
    } catch (error) {
      if (admitted && (!tokenResponseSettled || credentialIssued)) {
        this.#uncertainCredentialState = true;
      }
      throw error;
    } finally {
      this.#polling.delete(flowId);
    }
  }

  prepare(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      if (this.#uncertainCredentialState) throw new Error("Google credential state is uncertain.");
      if (this.#closed || this.#disconnecting) throw new Error("Google Workspace is unavailable.");
      const access = this.#accessToken;
      if (access && access.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) return;
      const generation = this.#generation;
      const revision = this.#credentialRevision;
      const credential = await this.#readCredential(context?.signal);
      if (!credential) return;
      let admitted = false;
      let responseSettled = false;
      let accessIssued = false;
      try {
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        const { response, json } = await this.#requestJson(
          TOKEN_ENDPOINT,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: this.#clientId,
              client_secret: this.#clientSecret,
              grant_type: "refresh_token",
              refresh_token: credential.refreshToken,
            }),
            signal: commitSignal,
          },
          IDENTITY_RESPONSE_BYTES,
        );
        responseSettled = true;
        if (!response.ok) {
          throw new IntegrationProviderPublicError(
            "Google Workspace access could not be refreshed. Disconnect and reconnect.",
          );
        }
        accessIssued = true;
        const accessToken = boundedString(json.access_token, MAX_TOKEN_CHARS);
        const expiresIn = boundedInteger(json.expires_in, 60, 86_400);
        const grantedScopes = canonicalGrantedScopes(json.scope, credential.grantedScopes);
        const refreshToken =
          json.refresh_token === undefined
            ? credential.refreshToken
            : boundedString(json.refresh_token, MAX_TOKEN_CHARS);
        if (
          this.#closed ||
          this.#disconnecting ||
          generation !== this.#generation ||
          revision !== this.#credentialRevision
        ) {
          throw new Error("Google connection changed while access was refreshing.");
        }
        const updated: Credential = {
          ...credential,
          refreshToken,
          grantedScopes,
          updatedAt: new Date().toISOString(),
        };
        await this.#writeCredential(updated, commitSignal);
        this.#credentialRevision += 1;
        this.#accessToken = {
          value: accessToken,
          expiresAt: Date.now() + expiresIn * 1_000,
          grantedScopes,
          subject: credential.subject,
          email: credential.email,
        };
      } catch (error) {
        if (admitted && (!responseSettled || accessIssued)) {
          this.#uncertainCredentialState = true;
        }
        throw error;
      }
    });
  }

  disconnect(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      this.#disconnecting = true;
      this.#generation += 1;
      this.#connectAttempt += 1;
      this.#accessToken = null;
      await this.#clearPendingFlows();
      let admitted = false;
      try {
        const credential = await this.#readCredential(context?.signal);
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        if (credential) await this.#revokeToken(credential.refreshToken, commitSignal);
        await Effect.runPromise(this.#secrets.remove(GOOGLE_WORKSPACE_SECRET_SUFFIX), {
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

  #assertInvocationCurrent(generation: number): void {
    if (
      this.#closed ||
      this.#disconnecting ||
      this.#uncertainCredentialState ||
      generation !== this.#generation
    ) {
      throw new Error("Google Workspace access was revoked or became uncertain.");
    }
  }

  async #beginInvocationCommit(
    context: IntegrationInvocationContext | undefined,
  ): Promise<AbortSignal> {
    if (context?.writeApproved !== true || typeof context.beginCommit !== "function") {
      throw new Error("Google Workspace writes require Harness commit admission.");
    }
    return context.beginCommit();
  }

  #requireAccess(capability: keyof typeof CAPABILITY_SCOPES): AccessToken {
    const access = this.#accessToken;
    if (!access || access.expiresAt - ACCESS_TOKEN_SKEW_MS <= Date.now()) {
      throw new IntegrationProviderPublicError(
        "Google Workspace access is not prepared. Reconnect if this continues.",
      );
    }
    if (!CAPABILITY_SCOPES[capability].every((scope) => access.grantedScopes.includes(scope))) {
      throw new IntegrationProviderPublicError(
        `Google Workspace ${capability} access is not granted.`,
      );
    }
    return access;
  }

  #encodeCursor(tool: string, binding: string, subject: string, pageToken: string): string {
    const payload: CursorPayload = {
      version: 1,
      tool,
      binding,
      subject,
      pageToken: boundedString(pageToken, MAX_PAGE_TOKEN_CHARS, "Google page token"),
      expiresAt: Date.now() + CURSOR_LIFETIME_MS,
    };
    const encoded = base64UrlJson(payload);
    const signature = NodeCrypto.createHmac("sha256", this.#cursorKey)
      .update(encoded, "ascii")
      .digest("base64url");
    return Buffer.from(`${encoded}.${signature}`, "ascii").toString("base64url");
  }

  #decodeCursor(
    cursor: string | undefined,
    tool: string,
    binding: string,
    subject: string,
  ): string | null {
    if (cursor === undefined) return null;
    let envelope: string;
    try {
      envelope = Buffer.from(cursor, "base64url").toString("ascii");
    } catch {
      throw new IntegrationProviderPublicError("Pagination cursor is invalid.");
    }
    const parts = envelope.split(".");
    if (parts.length !== 2)
      throw new IntegrationProviderPublicError("Pagination cursor is invalid.");
    const [encoded, signature] = parts as [string, string];
    const expected = NodeCrypto.createHmac("sha256", this.#cursorKey)
      .update(encoded, "ascii")
      .digest("base64url");
    if (!timingSafeTextEqual(signature, expected)) {
      throw new IntegrationProviderPublicError("Pagination cursor is invalid.");
    }
    let payload: Record<string, unknown>;
    try {
      payload = parseBase64UrlJson(encoded, 8 * 1024);
    } catch {
      throw new IntegrationProviderPublicError("Pagination cursor is invalid.");
    }
    if (
      !exactKeys(
        payload,
        new Set(["version", "tool", "binding", "subject", "pageToken", "expiresAt"]),
      ) ||
      payload.version !== 1 ||
      payload.tool !== tool ||
      payload.binding !== binding ||
      payload.subject !== subject ||
      !Number.isInteger(payload.expiresAt) ||
      (payload.expiresAt as number) <= Date.now()
    ) {
      throw new IntegrationProviderPublicError(
        "Pagination cursor expired or belongs to another request.",
      );
    }
    return boundedString(payload.pageToken, MAX_PAGE_TOKEN_CHARS, "Pagination cursor");
  }

  async invoke(
    toolName: string,
    input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown> {
    if (context?.signal.aborted) throw new Error("Google Workspace invocation was cancelled.");
    if (WRITE_TOOLS.has(toolName) && context?.writeApproved !== true) {
      throw new IntegrationProviderPublicError(
        "This Google Workspace write requires task access approval.",
      );
    }
    const generation = this.#generation;

    if (toolName === "googleworkspace.identity.get") {
      await decodeEmptyInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("identity.read");
      return {
        subject: access.subject,
        email: access.email,
        hostedDomain: HOSTED_DOMAIN,
      };
    }

    if (toolName === "googleworkspace.drive.search") {
      const values = await decodeDriveSearchInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("drive.read");
      const limit = values.limit ?? 25;
      const binding = stableBinding({
        text: values.text ?? null,
        kind: values.kind ?? "any",
        limit,
      });
      const pageToken = this.#decodeCursor(values.cursor, toolName, binding, access.subject);
      const mimeTypes: Readonly<Record<string, string>> = {
        folder: "application/vnd.google-apps.folder",
        document: "application/vnd.google-apps.document",
        spreadsheet: "application/vnd.google-apps.spreadsheet",
        presentation: "application/vnd.google-apps.presentation",
        pdf: "application/pdf",
      };
      const clauses = ["trashed = false"];
      if (values.text !== undefined) {
        const literal = googleSearchLiteral(values.text.trim());
        clauses.push(`(fullText contains ${literal} or name contains ${literal})`);
      }
      if (values.kind !== undefined && values.kind !== "any") {
        clauses.push(`mimeType = ${googleSearchLiteral(mimeTypes[values.kind]!)}`);
      }
      const url = new URL(`${DRIVE_API}/files`);
      url.searchParams.set("q", clauses.join(" and "));
      url.searchParams.set("pageSize", String(limit));
      url.searchParams.set("orderBy", "modifiedTime desc");
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("corpora", "user");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set(
        "fields",
        "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,driveId,parents,shared,starred,owners(displayName,emailAddress))",
      );
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const json = await this.#apiJson(url, access.value, { signal: context?.signal });
      if (!Array.isArray(json.files) || json.files.length > limit) {
        throw new Error("Google Drive returned an invalid search result.");
      }
      const next =
        json.nextPageToken === undefined
          ? null
          : this.#encodeCursor(
              toolName,
              binding,
              access.subject,
              boundedString(json.nextPageToken, MAX_PAGE_TOKEN_CHARS, "Google Drive page token"),
            );
      this.#assertInvocationCurrent(generation);
      return {
        files: json.files.map(projectDriveFile),
        cursor: next,
      };
    }

    if (toolName === "googleworkspace.drive.item.get") {
      const values = await decodeDriveItemGetInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("drive.read");
      const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(values.itemId)}`);
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set(
        "fields",
        "id,name,mimeType,createdTime,modifiedTime,size,driveId,parents,shared,starred,owners(displayName,emailAddress)",
      );
      const result = projectDriveFile(
        await this.#apiJson(url, access.value, { signal: context?.signal }),
      );
      this.#assertInvocationCurrent(generation);
      return result;
    }

    if (toolName === "googleworkspace.drive.content.get") {
      const values = await decodeDriveContentGetInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("drive.read");
      const metadataUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(values.itemId)}`);
      metadataUrl.searchParams.set("supportsAllDrives", "true");
      metadataUrl.searchParams.set("fields", "id,name,mimeType,size,capabilities(canDownload)");
      const metadata = await this.#apiJson(metadataUrl, access.value, {
        signal: context?.signal,
      });
      const id = boundedString(metadata.id, 1_024, "Google Drive item");
      const name = boundedString(metadata.name, 32_768, "Google Drive item");
      const mimeType = boundedString(metadata.mimeType, 255, "Google Drive item");
      const capabilities = asRecord(metadata.capabilities ?? {}, "Google Drive capabilities");
      if (capabilities.canDownload === false) {
        throw new IntegrationProviderPublicError(
          "This Drive item does not permit content download or export.",
        );
      }
      const format = values.format ?? "auto";
      const nativeFormats: Readonly<Record<string, Readonly<Record<string, string>>>> = {
        "application/vnd.google-apps.document": {
          auto: "text/plain",
          text: "text/plain",
          pdf: "application/pdf",
        },
        "application/vnd.google-apps.spreadsheet": {
          auto: "text/csv",
          csv: "text/csv",
          pdf: "application/pdf",
        },
        "application/vnd.google-apps.presentation": {
          auto: "application/pdf",
          pdf: "application/pdf",
        },
      };
      const supported = nativeFormats[mimeType];
      let contentUrl: URL;
      let expectedContentType: string | null = null;
      if (supported) {
        const exportMime = supported[format];
        if (!exportMime) {
          throw new IntegrationProviderPublicError(
            "That export format is not supported for this Workspace file type.",
          );
        }
        contentUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(values.itemId)}/export`);
        contentUrl.searchParams.set("mimeType", exportMime);
        expectedContentType = exportMime;
      } else {
        if (format !== "auto") {
          throw new IntegrationProviderPublicError(
            "Explicit export formats apply only to native Docs, Sheets, and Slides files.",
          );
        }
        contentUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(values.itemId)}`);
        contentUrl.searchParams.set("alt", "media");
        contentUrl.searchParams.set("supportsAllDrives", "true");
      }
      const { response, bytes } = await this.#apiBytes(contentUrl, access.value, context?.signal);
      const contentType =
        boundedOptionalString(response.headers.get("content-type"), 255, "Google content type") ??
        expectedContentType ??
        "application/octet-stream";
      this.#assertInvocationCurrent(generation);
      return {
        id,
        name,
        mimeType,
        contentType,
        encoding: "base64",
        size: bytes.byteLength,
        contentBase64: Buffer.from(bytes).toString("base64"),
      };
    }

    if (toolName === "googleworkspace.docs.get") {
      const values = await decodeDocsGetInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("drive.read");
      const url = new URL(`${DOCS_API}/documents/${encodeURIComponent(values.documentId)}`);
      const result = await this.#apiJson(url, access.value, {
        signal: context?.signal,
        maximumBytes: JSON_RESPONSE_BYTES,
      });
      this.#assertInvocationCurrent(generation);
      return result;
    }

    if (toolName === "googleworkspace.sheets.get") {
      const values = await decodeSheetsGetInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("drive.read");
      const url =
        values.range === undefined
          ? new URL(`${SHEETS_API}/spreadsheets/${encodeURIComponent(values.spreadsheetId)}`)
          : new URL(
              `${SHEETS_API}/spreadsheets/${encodeURIComponent(values.spreadsheetId)}/values/${encodeURIComponent(values.range)}`,
            );
      if (values.range === undefined) {
        url.searchParams.set(
          "fields",
          "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,gridProperties))",
        );
        url.searchParams.set("includeGridData", "false");
      } else {
        url.searchParams.set("majorDimension", "ROWS");
        url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
        url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");
      }
      const result = await this.#apiJson(url, access.value, {
        signal: context?.signal,
        maximumBytes: JSON_RESPONSE_BYTES,
      });
      this.#assertInvocationCurrent(generation);
      return result;
    }

    if (toolName === "googleworkspace.slides.get") {
      const values = await decodeSlidesGetInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("drive.read");
      const url = new URL(
        `${SLIDES_API}/presentations/${encodeURIComponent(values.presentationId)}`,
      );
      const result = await this.#apiJson(url, access.value, {
        signal: context?.signal,
        maximumBytes: JSON_RESPONSE_BYTES,
      });
      this.#assertInvocationCurrent(generation);
      return result;
    }

    if (toolName === "googleworkspace.mail.search") {
      const values = await decodeGmailSearchInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("mail.read");
      const limit = values.limit ?? 25;
      const after = values.after === undefined ? null : assertValidDate(values.after, "After");
      const before = values.before === undefined ? null : assertValidDate(values.before, "Before");
      if (
        after !== null &&
        before !== null &&
        Date.parse(`${after}T00:00:00Z`) >= Date.parse(`${before}T00:00:00Z`)
      ) {
        throw new IntegrationProviderPublicError("Gmail before must be later than after.");
      }
      const binding = stableBinding({
        text: values.text ?? null,
        from: values.from ?? null,
        to: values.to ?? null,
        after,
        before,
        hasAttachment: values.hasAttachment ?? null,
        labelIds: values.labelIds ?? [],
        limit,
      });
      const pageToken = this.#decodeCursor(values.cursor, toolName, binding, access.subject);
      const query: string[] = [];
      if (values.text !== undefined) query.push(gmailSearchLiteral(values.text.trim()));
      if (values.from !== undefined) query.push(`from:${gmailSearchLiteral(values.from)}`);
      if (values.to !== undefined) query.push(`to:${gmailSearchLiteral(values.to)}`);
      if (after) query.push(`after:${after}`);
      if (before) query.push(`before:${before}`);
      if (values.hasAttachment === true) query.push("has:attachment");
      if (values.hasAttachment === false) query.push("-has:attachment");
      const url = new URL(`${GMAIL_API}/users/me/messages`);
      if (query.length > 0) url.searchParams.set("q", query.join(" "));
      url.searchParams.set("maxResults", String(limit));
      url.searchParams.set("includeSpamTrash", "false");
      for (const labelId of values.labelIds ?? []) url.searchParams.append("labelIds", labelId);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const json = await this.#apiJson(url, access.value, { signal: context?.signal });
      const messages =
        json.messages === undefined
          ? []
          : Array.isArray(json.messages) && json.messages.length <= limit
            ? json.messages.map((raw) => {
                const message = asRecord(raw, "Gmail search result");
                return {
                  id: boundedString(message.id, 1_024, "Gmail search result"),
                  threadId: boundedString(message.threadId, 1_024, "Gmail search result"),
                };
              })
            : (() => {
                throw new Error("Gmail returned an invalid search result.");
              })();
      const cursor =
        json.nextPageToken === undefined
          ? null
          : this.#encodeCursor(
              toolName,
              binding,
              access.subject,
              boundedString(json.nextPageToken, MAX_PAGE_TOKEN_CHARS, "Gmail page token"),
            );
      this.#assertInvocationCurrent(generation);
      return {
        messages,
        resultSizeEstimate:
          json.resultSizeEstimate === undefined
            ? null
            : boundedInteger(
                json.resultSizeEstimate,
                0,
                Number.MAX_SAFE_INTEGER,
                "Gmail result estimate",
              ),
        cursor,
      };
    }

    if (toolName === "googleworkspace.mail.message.get") {
      const values = await decodeGmailMessageGetInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("mail.read");
      const url = new URL(`${GMAIL_API}/users/me/messages/${encodeURIComponent(values.messageId)}`);
      url.searchParams.set("format", "full");
      const result = projectGmailMessage(
        await this.#apiJson(url, access.value, {
          signal: context?.signal,
          maximumBytes: MAIL_THREAD_RESPONSE_BYTES,
        }),
      );
      this.#assertInvocationCurrent(generation);
      return result;
    }

    if (toolName === "googleworkspace.mail.thread.get") {
      const values = await decodeGmailThreadGetInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("mail.read");
      const url = new URL(`${GMAIL_API}/users/me/threads/${encodeURIComponent(values.threadId)}`);
      url.searchParams.set("format", "full");
      const json = await this.#apiJson(url, access.value, {
        signal: context?.signal,
        maximumBytes: MAIL_THREAD_RESPONSE_BYTES,
      });
      if (!Array.isArray(json.messages) || json.messages.length > 100) {
        throw new Error("Gmail returned an invalid thread.");
      }
      const result = {
        id: boundedString(json.id, 1_024, "Gmail thread"),
        messages: json.messages.map(projectGmailMessage),
      };
      this.#assertInvocationCurrent(generation);
      return result;
    }

    if (toolName === "googleworkspace.mail.labels.list") {
      await decodeEmptyInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("mail.read");
      const url = new URL(`${GMAIL_API}/users/me/labels`);
      const json = await this.#apiJson(url, access.value, { signal: context?.signal });
      if (!Array.isArray(json.labels) || json.labels.length > 500) {
        throw new Error("Gmail returned an invalid label list.");
      }
      const labels = json.labels.map((raw) => {
        const label = asRecord(raw, "Gmail label");
        return {
          id: boundedString(label.id, 1_024, "Gmail label"),
          name: boundedString(label.name, 1_024, "Gmail label"),
          type: boundedOptionalString(label.type, 64, "Gmail label"),
          messagesTotal:
            label.messagesTotal === undefined
              ? null
              : boundedInteger(label.messagesTotal, 0, Number.MAX_SAFE_INTEGER, "Gmail label"),
          messagesUnread:
            label.messagesUnread === undefined
              ? null
              : boundedInteger(label.messagesUnread, 0, Number.MAX_SAFE_INTEGER, "Gmail label"),
          threadsTotal:
            label.threadsTotal === undefined
              ? null
              : boundedInteger(label.threadsTotal, 0, Number.MAX_SAFE_INTEGER, "Gmail label"),
          threadsUnread:
            label.threadsUnread === undefined
              ? null
              : boundedInteger(label.threadsUnread, 0, Number.MAX_SAFE_INTEGER, "Gmail label"),
        };
      });
      this.#assertInvocationCurrent(generation);
      return { labels };
    }

    if (toolName === "googleworkspace.mail.attachment.get") {
      const values = await decodeGmailAttachmentGetInput(input, {
        onExcessProperty: "error",
      });
      const access = this.#requireAccess("mail.read");
      const url = new URL(
        `${GMAIL_API}/users/me/messages/${encodeURIComponent(values.messageId)}/attachments/${encodeURIComponent(values.attachmentId)}`,
      );
      const json = await this.#apiJson(url, access.value, {
        signal: context?.signal,
        maximumBytes: LARGE_RESPONSE_BYTES,
      });
      const data = boundedString(json.data, LARGE_RESPONSE_BYTES, "Gmail attachment");
      if (!/^[A-Za-z0-9_-]+$/u.test(data)) {
        throw new Error("Gmail attachment data is invalid.");
      }
      const bytes = Buffer.from(data, "base64url");
      if (bytes.byteLength > 3_500_000) {
        throw new IntegrationProviderPublicError(
          "Gmail attachment exceeds the 3.5 MB decoded-content limit.",
        );
      }
      const declaredSize =
        json.size === undefined
          ? bytes.byteLength
          : boundedInteger(json.size, 0, 100 * 1024 * 1024, "Gmail attachment");
      if (declaredSize !== bytes.byteLength) {
        throw new Error("Gmail attachment size is inconsistent.");
      }
      this.#assertInvocationCurrent(generation);
      return {
        messageId: values.messageId,
        attachmentId: values.attachmentId,
        encoding: "base64",
        size: bytes.byteLength,
        contentBase64: bytes.toString("base64"),
      };
    }

    if (toolName === "googleworkspace.mail.draft.create") {
      const values = await decodeGmailDraftCreateInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("mail.draft.create");
      const url = new URL(`${GMAIL_API}/users/me/drafts`);
      const raw = draftRawMessage(values);
      const commitSignal = await this.#beginInvocationCommit(context);
      const json = await this.#apiJson(url, access.value, {
        method: "POST",
        body: { message: { raw } },
        signal: commitSignal,
      });
      const message = asRecord(json.message, "Gmail draft receipt");
      const result = {
        draftId: boundedString(json.id, 1_024, "Gmail draft receipt"),
        messageId: boundedString(message.id, 1_024, "Gmail draft receipt"),
        threadId: boundedOptionalString(message.threadId, 1_024, "Gmail draft receipt"),
        status: "draft-created",
        sent: false,
      };
      this.#assertInvocationCurrent(generation);
      return result;
    }

    if (toolName === "googleworkspace.calendar.list") {
      const values = await decodeCalendarListInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("calendar.read");
      const limit = values.limit ?? 25;
      const binding = stableBinding({ limit });
      const pageToken = this.#decodeCursor(values.cursor, toolName, binding, access.subject);
      const url = new URL(`${CALENDAR_API}/users/me/calendarList`);
      url.searchParams.set("maxResults", String(limit));
      url.searchParams.set("showDeleted", "false");
      url.searchParams.set("showHidden", "false");
      url.searchParams.set(
        "fields",
        "nextPageToken,items(id,summary,description,location,timeZone,accessRole,primary,selected,hidden)",
      );
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const json = await this.#apiJson(url, access.value, { signal: context?.signal });
      if (!Array.isArray(json.items) || json.items.length > limit) {
        throw new Error("Google Calendar returned an invalid calendar list.");
      }
      const calendars = json.items.map((raw) => {
        const calendar = asRecord(raw, "Google Calendar");
        return {
          id: boundedString(calendar.id, 1_024, "Google Calendar"),
          summary: boundedString(calendar.summary, 1_000, "Google Calendar"),
          description: boundedOptionalString(calendar.description, 50_000, "Google Calendar"),
          location: boundedOptionalString(calendar.location, 1_000, "Google Calendar"),
          timeZone: boundedOptionalString(calendar.timeZone, 255, "Google Calendar"),
          accessRole: boundedString(calendar.accessRole, 64, "Google Calendar"),
          primary: calendar.primary === true,
          selected: calendar.selected === true,
          hidden: calendar.hidden === true,
        };
      });
      const cursor =
        json.nextPageToken === undefined
          ? null
          : this.#encodeCursor(
              toolName,
              binding,
              access.subject,
              boundedString(json.nextPageToken, MAX_PAGE_TOKEN_CHARS, "Calendar page token"),
            );
      this.#assertInvocationCurrent(generation);
      return { calendars, cursor };
    }

    if (toolName === "googleworkspace.calendar.events.list") {
      const values = await decodeCalendarEventsListInput(input, {
        onExcessProperty: "error",
      });
      const access = this.#requireAccess("calendar.read");
      const calendarId = values.calendarId ?? "primary";
      const range = calendarRange(values.start, values.end);
      const limit = values.limit ?? 25;
      const binding = stableBinding({ calendarId, ...range, limit });
      const pageToken = this.#decodeCursor(values.cursor, toolName, binding, access.subject);
      const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set("timeMin", range.start);
      url.searchParams.set("timeMax", range.end);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("showDeleted", "false");
      url.searchParams.set("maxResults", String(limit));
      url.searchParams.set(
        "fields",
        "nextPageToken,items(id,status,summary,description,location,start,end,organizer,creator,recurringEventId,hangoutLink,conferenceData(conferenceId,conferenceSolution(key,type,name),entryPoints(entryPointType,uri,label)),attachments(fileId,title,mimeType))",
      );
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const json = await this.#apiJson(url, access.value, {
        signal: context?.signal,
        maximumBytes: JSON_RESPONSE_BYTES,
      });
      if (!Array.isArray(json.items) || json.items.length > limit) {
        throw new Error("Google Calendar returned an invalid event list.");
      }
      const events = json.items.map(projectCalendarEvent);
      const cursor =
        json.nextPageToken === undefined
          ? null
          : this.#encodeCursor(
              toolName,
              binding,
              access.subject,
              boundedString(json.nextPageToken, MAX_PAGE_TOKEN_CHARS, "Calendar page token"),
            );
      this.#assertInvocationCurrent(generation);
      return { calendarId, events, cursor };
    }

    if (toolName === "googleworkspace.calendar.event.get") {
      const values = await decodeCalendarEventGetInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("calendar.read");
      const calendarId = values.calendarId ?? "primary";
      const url = new URL(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(values.eventId)}`,
      );
      url.searchParams.set(
        "fields",
        "id,status,summary,description,location,start,end,organizer,creator,recurringEventId,hangoutLink,conferenceData(conferenceId,conferenceSolution(key,type,name),entryPoints(entryPointType,uri,label)),attachments(fileId,title,mimeType)",
      );
      const result = projectCalendarEvent(
        await this.#apiJson(url, access.value, {
          signal: context?.signal,
          maximumBytes: JSON_RESPONSE_BYTES,
        }),
      );
      this.#assertInvocationCurrent(generation);
      return result;
    }

    if (toolName === "googleworkspace.calendar.event.create") {
      const values = await decodeCalendarEventCreateInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("calendar.write");
      const calendarId = values.calendarId ?? "primary";
      const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set("sendUpdates", "none");
      url.searchParams.set("conferenceDataVersion", "0");
      const body = eventBody(values);
      const commitSignal = await this.#beginInvocationCommit(context);
      const result = await this.#apiJson(url, access.value, {
        method: "POST",
        body,
        signal: commitSignal,
      });
      this.#assertInvocationCurrent(generation);
      return {
        status: "event-created",
        calendarId,
        eventId: boundedString(result.id, 1_024, "Google Calendar write receipt"),
      };
    }

    if (toolName === "googleworkspace.calendar.event.update") {
      const values = await decodeCalendarEventUpdateInput(input, { onExcessProperty: "error" });
      const access = this.#requireAccess("calendar.write");
      const calendarId = values.calendarId ?? "primary";
      const hasStart = values.start !== undefined;
      const hasEnd = values.end !== undefined;
      if (hasStart !== hasEnd) {
        throw new IntegrationProviderPublicError(
          "Calendar event start and end must be updated together.",
        );
      }
      const body: Record<string, unknown> = {};
      if (values.summary !== undefined) body.summary = values.summary;
      if (values.location !== undefined) body.location = values.location;
      if (values.description !== undefined) body.description = values.description;
      if (values.start !== undefined && values.end !== undefined) {
        const range = calendarRange(values.start, values.end);
        body.start = { dateTime: range.start };
        body.end = { dateTime: range.end };
      }
      if (Object.keys(body).length === 0) {
        throw new IntegrationProviderPublicError(
          "Calendar event update must include at least one supported field.",
        );
      }
      const url = new URL(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(values.eventId)}`,
      );
      url.searchParams.set("sendUpdates", "none");
      url.searchParams.set("conferenceDataVersion", "0");
      const commitSignal = await this.#beginInvocationCommit(context);
      const result = await this.#apiJson(url, access.value, {
        method: "PATCH",
        body,
        signal: commitSignal,
      });
      this.#assertInvocationCurrent(generation);
      return {
        status: "event-updated",
        calendarId,
        eventId: boundedString(result.id, 1_024, "Google Calendar write receipt"),
      };
    }

    throw new IntegrationProviderPublicError("Google Workspace tool is not supported.");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#connectAttempt += 1;
    this.#accessToken = null;
    for (const controller of this.#requestControllers) controller.abort();
    await this.#clearPendingFlows();
  }
}
