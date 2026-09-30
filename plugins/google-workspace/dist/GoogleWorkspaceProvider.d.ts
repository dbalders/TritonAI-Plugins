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
    readonly name: "googleworkspace.drive.folder.create";
    readonly description: "Create one Drive folder through files.create without sharing it.";
    readonly input: Schema.Struct<{
        readonly name: Schema.String;
        readonly parentId: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.file.create";
    readonly description: "Create one Drive file through files.create, optionally importing it as a native Docs, Sheets, or Slides file.";
    readonly input: Schema.Struct<{
        readonly name: Schema.String;
        readonly parentId: Schema.optionalKey<Schema.String>;
        readonly content: Schema.optionalKey<Schema.String>;
        readonly contentEncoding: Schema.optionalKey<Schema.Literals<readonly ["text", "base64"]>>;
        readonly contentType: Schema.optionalKey<Schema.String>;
        readonly convertTo: Schema.optionalKey<Schema.Literals<readonly ["document", "spreadsheet", "presentation"]>>;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.file.update";
    readonly description: "Replace the content of one exact Drive file through a files.update media upload.";
    readonly input: Schema.Struct<{
        readonly content: Schema.String;
        readonly contentEncoding: Schema.optionalKey<Schema.Literals<readonly ["text", "base64"]>>;
        readonly contentType: Schema.String;
        readonly itemId: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.item.update";
    readonly description: "Rename or describe one exact Drive item through files.update.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
        readonly name: Schema.optionalKey<Schema.String>;
        readonly description: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.docs.text.append";
    readonly description: "Append plain text to the end of one exact Google Doc through documents.batchUpdate.";
    readonly input: Schema.Struct<{
        readonly documentId: Schema.String;
        readonly text: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.docs.text.replace";
    readonly description: "Replace every match of exact text in one Google Doc through documents.batchUpdate.";
    readonly input: Schema.Struct<{
        readonly documentId: Schema.String;
        readonly find: Schema.String;
        readonly replaceWith: Schema.String;
        readonly matchCase: Schema.optionalKey<Schema.Boolean>;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.sheets.values.update";
    readonly description: "Overwrite one bounded A1 range with literal values through values.update.";
    readonly input: Schema.Struct<{
        readonly spreadsheetId: Schema.String;
        readonly range: Schema.String;
        readonly values: Schema.$Array<Schema.$Array<Schema.Union<readonly [Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]>>>;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.sheets.values.append";
    readonly description: "Append literal rows after the table in one A1 range through values.append.";
    readonly input: Schema.Struct<{
        readonly spreadsheetId: Schema.String;
        readonly range: Schema.String;
        readonly values: Schema.$Array<Schema.$Array<Schema.Union<readonly [Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]>>>;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.slides.text.replace";
    readonly description: "Replace every match of exact text in one presentation through presentations.batchUpdate.";
    readonly input: Schema.Struct<{
        readonly presentationId: Schema.String;
        readonly find: Schema.String;
        readonly replaceWith: Schema.String;
        readonly matchCase: Schema.optionalKey<Schema.Boolean>;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.slides.text.insert";
    readonly description: "Insert plain text into one exact slide shape, not a table, through presentations.batchUpdate.";
    readonly input: Schema.Struct<{
        readonly presentationId: Schema.String;
        readonly objectId: Schema.String;
        readonly text: Schema.String;
        readonly insertionIndex: Schema.optionalKey<Schema.Int>;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.slides.slide.create";
    readonly description: "Add one slide with a predefined layout through presentations.batchUpdate.";
    readonly input: Schema.Struct<{
        readonly presentationId: Schema.String;
        readonly layout: Schema.optionalKey<Schema.Literals<readonly ["BLANK", "CAPTION_ONLY", "TITLE", "TITLE_AND_BODY", "TITLE_AND_TWO_COLUMNS", "TITLE_ONLY", "SECTION_HEADER", "SECTION_TITLE_AND_DESCRIPTION", "ONE_COLUMN_TEXT", "MAIN_POINT", "BIG_NUMBER"]>>;
        readonly insertionIndex: Schema.optionalKey<Schema.Int>;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.slides.object.delete";
    readonly description: "Delete one exact slide or page element through presentations.batchUpdate.";
    readonly input: Schema.Struct<{
        readonly presentationId: Schema.String;
        readonly objectId: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.item.move";
    readonly description: "Move one exact Drive item into one destination folder through files.update.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
        readonly folderId: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.item.trash";
    readonly description: "Move one exact Drive item to the trash through files.update.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.item.restore";
    readonly description: "Restore one exact Drive item from the trash through files.update.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.item.delete";
    readonly description: "Permanently delete one exact Drive item through files.delete, bypassing the trash.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.permissions.list";
    readonly description: "List bounded sharing permissions for one exact Drive item through permissions.list.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
        readonly limit: Schema.optionalKey<Schema.Int>;
        readonly cursor: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.permission.create";
    readonly description: "Share one exact Drive item with a user, group, domain, or anyone through permissions.create.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
        readonly type: Schema.Literals<readonly ["user", "group", "domain", "anyone"]>;
        readonly role: Schema.Literals<readonly ["reader", "commenter", "writer"]>;
        readonly emailAddress: Schema.optionalKey<Schema.String>;
        readonly domain: Schema.optionalKey<Schema.String>;
        readonly notify: Schema.optionalKey<Schema.Boolean>;
    }>;
    readonly readOnly: false;
    readonly destructive: false;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.permission.update";
    readonly description: "Change the role of one exact Drive permission through permissions.update.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
        readonly permissionId: Schema.String;
        readonly role: Schema.Literals<readonly ["reader", "commenter", "writer"]>;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
    readonly openWorld: true;
}, {
    readonly name: "googleworkspace.drive.permission.delete";
    readonly description: "Remove one exact Drive permission through permissions.delete.";
    readonly input: Schema.Struct<{
        readonly itemId: Schema.String;
        readonly permissionId: Schema.String;
    }>;
    readonly readOnly: false;
    readonly destructive: true;
    readonly idempotent: false;
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
        readonly name: "googleworkspace.drive.folder.create";
        readonly description: "Create one Drive folder through files.create without sharing it.";
        readonly input: Schema.Struct<{
            readonly name: Schema.String;
            readonly parentId: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.file.create";
        readonly description: "Create one Drive file through files.create, optionally importing it as a native Docs, Sheets, or Slides file.";
        readonly input: Schema.Struct<{
            readonly name: Schema.String;
            readonly parentId: Schema.optionalKey<Schema.String>;
            readonly content: Schema.optionalKey<Schema.String>;
            readonly contentEncoding: Schema.optionalKey<Schema.Literals<readonly ["text", "base64"]>>;
            readonly contentType: Schema.optionalKey<Schema.String>;
            readonly convertTo: Schema.optionalKey<Schema.Literals<readonly ["document", "spreadsheet", "presentation"]>>;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.file.update";
        readonly description: "Replace the content of one exact Drive file through a files.update media upload.";
        readonly input: Schema.Struct<{
            readonly content: Schema.String;
            readonly contentEncoding: Schema.optionalKey<Schema.Literals<readonly ["text", "base64"]>>;
            readonly contentType: Schema.String;
            readonly itemId: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.item.update";
        readonly description: "Rename or describe one exact Drive item through files.update.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
            readonly name: Schema.optionalKey<Schema.String>;
            readonly description: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.docs.text.append";
        readonly description: "Append plain text to the end of one exact Google Doc through documents.batchUpdate.";
        readonly input: Schema.Struct<{
            readonly documentId: Schema.String;
            readonly text: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.docs.text.replace";
        readonly description: "Replace every match of exact text in one Google Doc through documents.batchUpdate.";
        readonly input: Schema.Struct<{
            readonly documentId: Schema.String;
            readonly find: Schema.String;
            readonly replaceWith: Schema.String;
            readonly matchCase: Schema.optionalKey<Schema.Boolean>;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.sheets.values.update";
        readonly description: "Overwrite one bounded A1 range with literal values through values.update.";
        readonly input: Schema.Struct<{
            readonly spreadsheetId: Schema.String;
            readonly range: Schema.String;
            readonly values: Schema.$Array<Schema.$Array<Schema.Union<readonly [Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]>>>;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.sheets.values.append";
        readonly description: "Append literal rows after the table in one A1 range through values.append.";
        readonly input: Schema.Struct<{
            readonly spreadsheetId: Schema.String;
            readonly range: Schema.String;
            readonly values: Schema.$Array<Schema.$Array<Schema.Union<readonly [Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]>>>;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.slides.text.replace";
        readonly description: "Replace every match of exact text in one presentation through presentations.batchUpdate.";
        readonly input: Schema.Struct<{
            readonly presentationId: Schema.String;
            readonly find: Schema.String;
            readonly replaceWith: Schema.String;
            readonly matchCase: Schema.optionalKey<Schema.Boolean>;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.slides.text.insert";
        readonly description: "Insert plain text into one exact slide shape, not a table, through presentations.batchUpdate.";
        readonly input: Schema.Struct<{
            readonly presentationId: Schema.String;
            readonly objectId: Schema.String;
            readonly text: Schema.String;
            readonly insertionIndex: Schema.optionalKey<Schema.Int>;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.slides.slide.create";
        readonly description: "Add one slide with a predefined layout through presentations.batchUpdate.";
        readonly input: Schema.Struct<{
            readonly presentationId: Schema.String;
            readonly layout: Schema.optionalKey<Schema.Literals<readonly ["BLANK", "CAPTION_ONLY", "TITLE", "TITLE_AND_BODY", "TITLE_AND_TWO_COLUMNS", "TITLE_ONLY", "SECTION_HEADER", "SECTION_TITLE_AND_DESCRIPTION", "ONE_COLUMN_TEXT", "MAIN_POINT", "BIG_NUMBER"]>>;
            readonly insertionIndex: Schema.optionalKey<Schema.Int>;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.slides.object.delete";
        readonly description: "Delete one exact slide or page element through presentations.batchUpdate.";
        readonly input: Schema.Struct<{
            readonly presentationId: Schema.String;
            readonly objectId: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.item.move";
        readonly description: "Move one exact Drive item into one destination folder through files.update.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
            readonly folderId: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.item.trash";
        readonly description: "Move one exact Drive item to the trash through files.update.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.item.restore";
        readonly description: "Restore one exact Drive item from the trash through files.update.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.item.delete";
        readonly description: "Permanently delete one exact Drive item through files.delete, bypassing the trash.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.permissions.list";
        readonly description: "List bounded sharing permissions for one exact Drive item through permissions.list.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
            readonly limit: Schema.optionalKey<Schema.Int>;
            readonly cursor: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.permission.create";
        readonly description: "Share one exact Drive item with a user, group, domain, or anyone through permissions.create.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
            readonly type: Schema.Literals<readonly ["user", "group", "domain", "anyone"]>;
            readonly role: Schema.Literals<readonly ["reader", "commenter", "writer"]>;
            readonly emailAddress: Schema.optionalKey<Schema.String>;
            readonly domain: Schema.optionalKey<Schema.String>;
            readonly notify: Schema.optionalKey<Schema.Boolean>;
        }>;
        readonly readOnly: false;
        readonly destructive: false;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.permission.update";
        readonly description: "Change the role of one exact Drive permission through permissions.update.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
            readonly permissionId: Schema.String;
            readonly role: Schema.Literals<readonly ["reader", "commenter", "writer"]>;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
        readonly openWorld: true;
    }, {
        readonly name: "googleworkspace.drive.permission.delete";
        readonly description: "Remove one exact Drive permission through permissions.delete.";
        readonly input: Schema.Struct<{
            readonly itemId: Schema.String;
            readonly permissionId: Schema.String;
        }>;
        readonly readOnly: false;
        readonly destructive: true;
        readonly idempotent: false;
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
