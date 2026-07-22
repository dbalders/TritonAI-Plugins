import * as Schema from "effect/Schema";
import { type IntegrationConnectionSubmission, type IntegrationDeviceCodeConnectResult, type IntegrationInvocationContext, type IntegrationLifecycleContext, type IntegrationProvider, type IntegrationProviderPollResult, type IntegrationProviderStatus, type IntegrationSecretStore } from "./host-contract.js";
/** Package-local suffix; the Harness adds the collision-free package namespace. */
export declare const MICROSOFT_GRAPH_SECRET_SUFFIX = "oauth";
export declare const MICROSOFT_GRAPH_PROVIDER_ID = "microsoft-graph";
export interface MicrosoftGraphConfiguration {
    readonly clientId: string;
    readonly tenantId: string;
}
export declare const MICROSOFT_GRAPH_TOOLS: readonly [{
    readonly name: "microsoft365.mail.search";
    readonly description: "Search Microsoft 365 mail through the fixed read-only messages endpoint with bounded input and output.";
    readonly input: Schema.Struct<{
        readonly query: Schema.optionalKey<Schema.String>;
        readonly limit: Schema.optionalKey<Schema.Int>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.mail.get";
    readonly description: "Read one exact Microsoft 365 mail message through the fixed messages endpoint.";
    readonly input: Schema.Struct<{
        readonly messageId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.mail.draft.create";
    readonly description: "Create one unsent Microsoft 365 mail draft with a plain-text body and optional file attachments through a fixed endpoint.";
    readonly input: Schema.Struct<{
        readonly to: Schema.$Array<Schema.String>;
        readonly cc: Schema.optionalKey<Schema.$Array<Schema.String>>;
        readonly bcc: Schema.optionalKey<Schema.$Array<Schema.String>>;
        readonly subject: Schema.String;
        readonly body: Schema.String;
        readonly attachments: Schema.optionalKey<Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly contentBytes: Schema.String;
            readonly contentType: Schema.optionalKey<Schema.String>;
        }>>>;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.mail.attachments.list";
    readonly description: "List attachments on one exact Microsoft 365 mail message.";
    readonly input: Schema.Struct<{
        readonly messageId: Schema.String;
        readonly limit: Schema.optionalKey<Schema.Int>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.mail.attachment.get";
    readonly description: "Read one exact attachment from one exact Microsoft 365 mail message, including file bytes or an expanded attached item, within a 5 MB response.";
    readonly input: Schema.Struct<{
        readonly messageId: Schema.String;
        readonly attachmentId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.calendar.events";
    readonly description: "Read Microsoft 365 calendar events through the fixed calendar-view endpoint in a bounded timestamp range.";
    readonly input: Schema.Struct<{
        readonly start: Schema.optionalKey<Schema.String>;
        readonly end: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.calendar.event.get";
    readonly description: "Read one exact Microsoft 365 calendar event through the fixed events endpoint.";
    readonly input: Schema.Struct<{
        readonly eventId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.calendar.event.create";
    readonly description: "Create one Microsoft 365 calendar event through the fixed events endpoint.";
    readonly input: Schema.Struct<{
        subject: Schema.String;
        start: Schema.String;
        end: Schema.String;
        location: Schema.optionalKey<Schema.String>;
        body: Schema.optionalKey<Schema.String>;
        attendees: Schema.optionalKey<Schema.$Array<Schema.Struct<{
            readonly address: Schema.String;
            readonly type: Schema.Literals<readonly ["required", "optional", "resource"]>;
            readonly name: Schema.optionalKey<Schema.String>;
        }>>>;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.calendar.event.attachments.list";
    readonly description: "List attachments on one exact Microsoft 365 calendar event.";
    readonly input: Schema.Struct<{
        readonly eventId: Schema.String;
        readonly limit: Schema.optionalKey<Schema.Int>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.calendar.event.attachment.get";
    readonly description: "Read one exact attachment from one exact Microsoft 365 calendar event, including file bytes or an expanded attached item, within a 5 MB response.";
    readonly input: Schema.Struct<{
        readonly eventId: Schema.String;
        readonly attachmentId: Schema.String;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.calendar.event.update";
    readonly description: "Update the subject, time, location, or attendee list on one Microsoft 365 calendar event.";
    readonly input: Schema.Struct<{
        readonly eventId: Schema.String;
        readonly subject: Schema.optionalKey<Schema.String>;
        readonly start: Schema.optionalKey<Schema.String>;
        readonly end: Schema.optionalKey<Schema.String>;
        readonly location: Schema.optionalKey<Schema.String>;
        readonly attendees: Schema.optionalKey<Schema.$Array<Schema.Struct<{
            readonly address: Schema.String;
            readonly type: Schema.Literals<readonly ["required", "optional", "resource"]>;
            readonly name: Schema.optionalKey<Schema.String>;
        }>>>;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.chat.list";
    readonly description: "List a bounded number of Microsoft 365 chats through the fixed chats endpoint.";
    readonly input: Schema.Struct<{
        readonly limit: Schema.optionalKey<Schema.Int>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.chat.messages";
    readonly description: "Read bounded message history from one exact Microsoft 365 chat.";
    readonly input: Schema.Struct<{
        readonly chatId: Schema.String;
        readonly limit: Schema.optionalKey<Schema.Int>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.chat.message.send";
    readonly description: "Send one plain-text message to one existing Microsoft 365 chat.";
    readonly input: Schema.Struct<{
        readonly chatId: Schema.String;
        readonly body: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}];
type Fetch = typeof globalThis.fetch;
export declare class MicrosoftGraphProvider implements IntegrationProvider {
    #private;
    readonly id = "microsoft-graph";
    readonly tools: readonly [{
        readonly name: "microsoft365.mail.search";
        readonly description: "Search Microsoft 365 mail through the fixed read-only messages endpoint with bounded input and output.";
        readonly input: Schema.Struct<{
            readonly query: Schema.optionalKey<Schema.String>;
            readonly limit: Schema.optionalKey<Schema.Int>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.mail.get";
        readonly description: "Read one exact Microsoft 365 mail message through the fixed messages endpoint.";
        readonly input: Schema.Struct<{
            readonly messageId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.mail.draft.create";
        readonly description: "Create one unsent Microsoft 365 mail draft with a plain-text body and optional file attachments through a fixed endpoint.";
        readonly input: Schema.Struct<{
            readonly to: Schema.$Array<Schema.String>;
            readonly cc: Schema.optionalKey<Schema.$Array<Schema.String>>;
            readonly bcc: Schema.optionalKey<Schema.$Array<Schema.String>>;
            readonly subject: Schema.String;
            readonly body: Schema.String;
            readonly attachments: Schema.optionalKey<Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly contentBytes: Schema.String;
                readonly contentType: Schema.optionalKey<Schema.String>;
            }>>>;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.mail.attachments.list";
        readonly description: "List attachments on one exact Microsoft 365 mail message.";
        readonly input: Schema.Struct<{
            readonly messageId: Schema.String;
            readonly limit: Schema.optionalKey<Schema.Int>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.mail.attachment.get";
        readonly description: "Read one exact attachment from one exact Microsoft 365 mail message, including file bytes or an expanded attached item, within a 5 MB response.";
        readonly input: Schema.Struct<{
            readonly messageId: Schema.String;
            readonly attachmentId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.calendar.events";
        readonly description: "Read Microsoft 365 calendar events through the fixed calendar-view endpoint in a bounded timestamp range.";
        readonly input: Schema.Struct<{
            readonly start: Schema.optionalKey<Schema.String>;
            readonly end: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.calendar.event.get";
        readonly description: "Read one exact Microsoft 365 calendar event through the fixed events endpoint.";
        readonly input: Schema.Struct<{
            readonly eventId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.calendar.event.create";
        readonly description: "Create one Microsoft 365 calendar event through the fixed events endpoint.";
        readonly input: Schema.Struct<{
            subject: Schema.String;
            start: Schema.String;
            end: Schema.String;
            location: Schema.optionalKey<Schema.String>;
            body: Schema.optionalKey<Schema.String>;
            attendees: Schema.optionalKey<Schema.$Array<Schema.Struct<{
                readonly address: Schema.String;
                readonly type: Schema.Literals<readonly ["required", "optional", "resource"]>;
                readonly name: Schema.optionalKey<Schema.String>;
            }>>>;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.calendar.event.attachments.list";
        readonly description: "List attachments on one exact Microsoft 365 calendar event.";
        readonly input: Schema.Struct<{
            readonly eventId: Schema.String;
            readonly limit: Schema.optionalKey<Schema.Int>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.calendar.event.attachment.get";
        readonly description: "Read one exact attachment from one exact Microsoft 365 calendar event, including file bytes or an expanded attached item, within a 5 MB response.";
        readonly input: Schema.Struct<{
            readonly eventId: Schema.String;
            readonly attachmentId: Schema.String;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.calendar.event.update";
        readonly description: "Update the subject, time, location, or attendee list on one Microsoft 365 calendar event.";
        readonly input: Schema.Struct<{
            readonly eventId: Schema.String;
            readonly subject: Schema.optionalKey<Schema.String>;
            readonly start: Schema.optionalKey<Schema.String>;
            readonly end: Schema.optionalKey<Schema.String>;
            readonly location: Schema.optionalKey<Schema.String>;
            readonly attendees: Schema.optionalKey<Schema.$Array<Schema.Struct<{
                readonly address: Schema.String;
                readonly type: Schema.Literals<readonly ["required", "optional", "resource"]>;
                readonly name: Schema.optionalKey<Schema.String>;
            }>>>;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.chat.list";
        readonly description: "List a bounded number of Microsoft 365 chats through the fixed chats endpoint.";
        readonly input: Schema.Struct<{
            readonly limit: Schema.optionalKey<Schema.Int>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.chat.messages";
        readonly description: "Read bounded message history from one exact Microsoft 365 chat.";
        readonly input: Schema.Struct<{
            readonly chatId: Schema.String;
            readonly limit: Schema.optionalKey<Schema.Int>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.chat.message.send";
        readonly description: "Send one plain-text message to one existing Microsoft 365 chat.";
        readonly input: Schema.Struct<{
            readonly chatId: Schema.String;
            readonly body: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }];
    constructor(secrets: IntegrationSecretStore, configuration: MicrosoftGraphConfiguration, fetchImplementation?: Fetch, requestTimeoutMs?: number);
    status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus>;
    connect(capabilities: ReadonlyArray<string>, context?: IntegrationLifecycleContext, submission?: IntegrationConnectionSubmission): Promise<IntegrationDeviceCodeConnectResult>;
    poll(flowId: string, context?: IntegrationLifecycleContext): Promise<IntegrationProviderPollResult>;
    prepare(context?: IntegrationLifecycleContext): Promise<void>;
    disconnect(context?: IntegrationLifecycleContext): Promise<void>;
    invoke(toolName: string, input: unknown, context?: IntegrationInvocationContext): Promise<unknown>;
    close(): Promise<void>;
}
export {};
