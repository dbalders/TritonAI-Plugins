import * as Schema from "effect/Schema";
import { type IntegrationAuthorizationUrlConnectResult, type IntegrationConnectionSubmission, type IntegrationInvocationContext, type IntegrationLifecycleContext, type IntegrationProvider, type IntegrationProviderPollResult, type IntegrationProviderStatus, type IntegrationSecretStore } from "./host-contract.js";
/** Package-local suffix; Harness adds the collision-free package namespace. */
export declare const GOOGLE_WORKSPACE_SECRET_SUFFIX = "oauth";
export declare const GOOGLE_WORKSPACE_PROVIDER_ID = "google-workspace";
export interface GoogleWorkspaceConfiguration {
    readonly clientId: string;
    readonly clientSecret: string;
}
export declare const GOOGLE_WORKSPACE_TOOLS: readonly [{
    readonly name: "googleworkspace.identity.get";
    readonly description: "Read the verified connected Google identity without returning OAuth material.";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.search";
    readonly description: "Search Drive through one fixed files.list endpoint and structured filters.";
    readonly input: Schema.Struct<{
        readonly text: Schema.optionalKey<Schema.String>;
        readonly kind: Schema.optionalKey<Schema.Literals<readonly ["any", "folder", "document", "spreadsheet", "presentation", "pdf"]>>;
        readonly limit: Schema.optionalKey<Schema.Int>;
        readonly cursor: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.item.get";
    readonly description: "Read metadata for one exact Drive item through files.get.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.content.get";
    readonly description: "Read bounded content for one exact Drive item through files.get or files.export.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
        readonly format: Schema.optionalKey<Schema.Literals<readonly ["auto", "text", "csv", "pdf"]>>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.docs.get";
    readonly description: "Read one exact document through the fixed Google Docs endpoint.";
    readonly input: Schema.Struct<{
        readonly documentId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.sheets.get";
    readonly description: "Read one exact spreadsheet or A1 range through fixed Google Sheets endpoints.";
    readonly input: Schema.Struct<{
        readonly spreadsheetId: Schema.String;
        readonly range: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.slides.get";
    readonly description: "Read one exact presentation through the fixed Google Slides endpoint.";
    readonly input: Schema.Struct<{
        readonly presentationId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.mail.search";
    readonly description: "Search Gmail through messages.list using structured bounded filters.";
    readonly input: Schema.Struct<{
        readonly text: Schema.optionalKey<Schema.String>;
        readonly from: Schema.optionalKey<Schema.String>;
        readonly to: Schema.optionalKey<Schema.String>;
        readonly after: Schema.optionalKey<Schema.String>;
        readonly before: Schema.optionalKey<Schema.String>;
        readonly hasAttachment: Schema.optionalKey<Schema.Boolean>;
        readonly labelIds: Schema.optionalKey<Schema.$Array<Schema.String>>;
        readonly limit: Schema.optionalKey<Schema.Int>;
        readonly cursor: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.mail.message.get";
    readonly description: "Read one exact Gmail message through messages.get.";
    readonly input: Schema.Struct<{
        readonly messageId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.mail.thread.get";
    readonly description: "Read one exact Gmail thread through threads.get.";
    readonly input: Schema.Struct<{
        readonly threadId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.mail.labels.list";
    readonly description: "List Gmail label metadata through labels.list.";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.mail.attachment.get";
    readonly description: "Read one bounded attachment through Gmail attachments.get.";
    readonly input: Schema.Struct<{
        readonly messageId: Schema.String;
        readonly attachmentId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.mail.draft.create";
    readonly description: "Create one unsent plain-text Gmail draft through drafts.create.";
    readonly input: Schema.Struct<{
        readonly to: Schema.$Array<Schema.String>;
        readonly cc: Schema.optionalKey<Schema.$Array<Schema.String>>;
        readonly bcc: Schema.optionalKey<Schema.$Array<Schema.String>>;
        readonly subject: Schema.String;
        readonly body: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.calendar.list";
    readonly description: "List bounded calendar metadata through calendarList.list.";
    readonly input: Schema.Struct<{
        readonly limit: Schema.optionalKey<Schema.Int>;
        readonly cursor: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.calendar.events.list";
    readonly description: "List events in one bounded range through events.list.";
    readonly input: Schema.Struct<{
        readonly calendarId: Schema.optionalKey<Schema.String>;
        readonly start: Schema.String;
        readonly end: Schema.String;
        readonly limit: Schema.optionalKey<Schema.Int>;
        readonly cursor: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.calendar.event.get";
    readonly description: "Read one exact event through events.get.";
    readonly input: Schema.Struct<{
        readonly calendarId: Schema.optionalKey<Schema.String>;
        readonly eventId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.calendar.event.create";
    readonly description: "Create one narrow event through events.insert with sendUpdates disabled and no attendees.";
    readonly input: Schema.Struct<{
        readonly summary: Schema.String;
        readonly start: Schema.String;
        readonly end: Schema.String;
        readonly location: Schema.optionalKey<Schema.String>;
        readonly description: Schema.optionalKey<Schema.String>;
        readonly calendarId: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.calendar.event.update";
    readonly description: "Patch narrow fields on one event through events.patch with sendUpdates disabled.";
    readonly input: Schema.Struct<{
        readonly calendarId: Schema.optionalKey<Schema.String>;
        readonly eventId: Schema.String;
        readonly summary: Schema.optionalKey<Schema.String>;
        readonly start: Schema.optionalKey<Schema.String>;
        readonly end: Schema.optionalKey<Schema.String>;
        readonly location: Schema.optionalKey<Schema.String>;
        readonly description: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}];
type Fetch = typeof globalThis.fetch;
export declare class GoogleWorkspaceProvider implements IntegrationProvider {
    #private;
    readonly id = "google-workspace";
    readonly tools: readonly [{
        readonly name: "googleworkspace.identity.get";
        readonly description: "Read the verified connected Google identity without returning OAuth material.";
        readonly input: Schema.$Record<Schema.String, Schema.Never>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.search";
        readonly description: "Search Drive through one fixed files.list endpoint and structured filters.";
        readonly input: Schema.Struct<{
            readonly text: Schema.optionalKey<Schema.String>;
            readonly kind: Schema.optionalKey<Schema.Literals<readonly ["any", "folder", "document", "spreadsheet", "presentation", "pdf"]>>;
            readonly limit: Schema.optionalKey<Schema.Int>;
            readonly cursor: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.item.get";
        readonly description: "Read metadata for one exact Drive item through files.get.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.content.get";
        readonly description: "Read bounded content for one exact Drive item through files.get or files.export.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
            readonly format: Schema.optionalKey<Schema.Literals<readonly ["auto", "text", "csv", "pdf"]>>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.docs.get";
        readonly description: "Read one exact document through the fixed Google Docs endpoint.";
        readonly input: Schema.Struct<{
            readonly documentId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.sheets.get";
        readonly description: "Read one exact spreadsheet or A1 range through fixed Google Sheets endpoints.";
        readonly input: Schema.Struct<{
            readonly spreadsheetId: Schema.String;
            readonly range: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.slides.get";
        readonly description: "Read one exact presentation through the fixed Google Slides endpoint.";
        readonly input: Schema.Struct<{
            readonly presentationId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.mail.search";
        readonly description: "Search Gmail through messages.list using structured bounded filters.";
        readonly input: Schema.Struct<{
            readonly text: Schema.optionalKey<Schema.String>;
            readonly from: Schema.optionalKey<Schema.String>;
            readonly to: Schema.optionalKey<Schema.String>;
            readonly after: Schema.optionalKey<Schema.String>;
            readonly before: Schema.optionalKey<Schema.String>;
            readonly hasAttachment: Schema.optionalKey<Schema.Boolean>;
            readonly labelIds: Schema.optionalKey<Schema.$Array<Schema.String>>;
            readonly limit: Schema.optionalKey<Schema.Int>;
            readonly cursor: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.mail.message.get";
        readonly description: "Read one exact Gmail message through messages.get.";
        readonly input: Schema.Struct<{
            readonly messageId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.mail.thread.get";
        readonly description: "Read one exact Gmail thread through threads.get.";
        readonly input: Schema.Struct<{
            readonly threadId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.mail.labels.list";
        readonly description: "List Gmail label metadata through labels.list.";
        readonly input: Schema.$Record<Schema.String, Schema.Never>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.mail.attachment.get";
        readonly description: "Read one bounded attachment through Gmail attachments.get.";
        readonly input: Schema.Struct<{
            readonly messageId: Schema.String;
            readonly attachmentId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.mail.draft.create";
        readonly description: "Create one unsent plain-text Gmail draft through drafts.create.";
        readonly input: Schema.Struct<{
            readonly to: Schema.$Array<Schema.String>;
            readonly cc: Schema.optionalKey<Schema.$Array<Schema.String>>;
            readonly bcc: Schema.optionalKey<Schema.$Array<Schema.String>>;
            readonly subject: Schema.String;
            readonly body: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.calendar.list";
        readonly description: "List bounded calendar metadata through calendarList.list.";
        readonly input: Schema.Struct<{
            readonly limit: Schema.optionalKey<Schema.Int>;
            readonly cursor: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.calendar.events.list";
        readonly description: "List events in one bounded range through events.list.";
        readonly input: Schema.Struct<{
            readonly calendarId: Schema.optionalKey<Schema.String>;
            readonly start: Schema.String;
            readonly end: Schema.String;
            readonly limit: Schema.optionalKey<Schema.Int>;
            readonly cursor: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.calendar.event.get";
        readonly description: "Read one exact event through events.get.";
        readonly input: Schema.Struct<{
            readonly calendarId: Schema.optionalKey<Schema.String>;
            readonly eventId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.calendar.event.create";
        readonly description: "Create one narrow event through events.insert with sendUpdates disabled and no attendees.";
        readonly input: Schema.Struct<{
            readonly summary: Schema.String;
            readonly start: Schema.String;
            readonly end: Schema.String;
            readonly location: Schema.optionalKey<Schema.String>;
            readonly description: Schema.optionalKey<Schema.String>;
            readonly calendarId: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.calendar.event.update";
        readonly description: "Patch narrow fields on one event through events.patch with sendUpdates disabled.";
        readonly input: Schema.Struct<{
            readonly calendarId: Schema.optionalKey<Schema.String>;
            readonly eventId: Schema.String;
            readonly summary: Schema.optionalKey<Schema.String>;
            readonly start: Schema.optionalKey<Schema.String>;
            readonly end: Schema.optionalKey<Schema.String>;
            readonly location: Schema.optionalKey<Schema.String>;
            readonly description: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }];
    constructor(secrets: IntegrationSecretStore, configuration: GoogleWorkspaceConfiguration, fetchImplementation?: Fetch, requestTimeoutMs?: number);
    status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus>;
    connect(capabilities: ReadonlyArray<string>, context?: IntegrationLifecycleContext, submission?: IntegrationConnectionSubmission): Promise<IntegrationAuthorizationUrlConnectResult | {
        readonly kind: "connected";
        readonly flowId: string;
        readonly message: string;
    }>;
    poll(flowId: string, context?: IntegrationLifecycleContext): Promise<IntegrationProviderPollResult>;
    prepare(context?: IntegrationLifecycleContext): Promise<void>;
    disconnect(context?: IntegrationLifecycleContext): Promise<void>;
    invoke(toolName: string, input: unknown, context?: IntegrationInvocationContext): Promise<unknown>;
    close(): Promise<void>;
}
export {};
