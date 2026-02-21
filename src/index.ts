#!/usr/bin/env node
/**
 * Proton Bridge MCP Server (read-only).
 * Exposes mail via MCP tools for use with Ollama or other MCP clients.
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadImapConfig, loadMailConfig } from "./config.js";
import * as imap from "./imap.js";

const IMAP_CONFIG = loadImapConfig();
const MAIL_CONFIG = loadMailConfig();

const server = new Server(
  {
    name: "proton-bridge-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const COMMON_LIST_OPTIONS_SCHEMA = {
  sort: {
    type: "string",
    enum: ["asc", "desc"],
    description: "Sort by UID (default: desc/newest-first)",
    default: "desc",
  },
  cursor: {
    type: "string",
    description: "Opaque pagination cursor from previous response",
  },
  includeSnippet: {
    type: "boolean",
    description: "Include short plain-text snippet per message",
    default: false,
  },
  returnPage: {
    type: "boolean",
    description: "Return {items,nextCursor} instead of raw array",
    default: false,
  },
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "mail_list_folders",
        description: "List all mail folders (mailboxes). Use this to see INBOX, Sent, etc.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "mail_list_messages",
        description:
          "List recent messages in a folder (envelope only by default). Supports sort/cursor/snippet options.",
        inputSchema: {
          type: "object",
          properties: {
            mailbox: {
              type: "string",
              description: "Folder name, e.g. INBOX or Sent",
            },
            limit: {
              type: "number",
              description: "Max number of messages to return (default 50, capped globally)",
              default: 50,
            },
            ...COMMON_LIST_OPTIONS_SCHEMA,
          },
          required: ["mailbox"],
        },
      },
      {
        name: "mail_get_message",
        description: "Fetch one full message by folder and UID (envelope + body text).",
        inputSchema: {
          type: "object",
          properties: {
            mailbox: { type: "string", description: "Folder name" },
            uid: { type: "number", description: "Message UID from mail_list_messages or mail_search" },
          },
          required: ["mailbox", "uid"],
        },
      },
      {
        name: "mail_search",
        description:
          "Convenience folder search by basic fields. Prefer mail_search_advanced for richer filters and agent reliability.",
        inputSchema: {
          type: "object",
          properties: {
            mailbox: { type: "string", description: "Folder to search (e.g. INBOX)" },
            from: { type: "string", description: "Sender contains" },
            to: { type: "string", description: "Recipient contains" },
            subject: { type: "string", description: "Subject contains" },
            body: { type: "string", description: "Body contains" },
            since: { type: "string", description: "Date since (ISO)" },
            before: { type: "string", description: "Date before (ISO)" },
            unseen: { type: "boolean", description: "Only unread" },
            limit: { type: "number", description: "Max results (default 50, capped globally)", default: 50 },
            ...COMMON_LIST_OPTIONS_SCHEMA,
          },
          required: ["mailbox"],
        },
      },
      {
        name: "mail_search_advanced",
        description:
          "Primary advanced search tool: keyword, sender/receiver, subject/body, date/date-range, sent-date-range, read state, message-id.",
        inputSchema: {
          type: "object",
          properties: {
            mailbox: { type: "string", description: "Folder to search (e.g. INBOX)" },
            keyword: { type: "string", description: "Match any text in headers and body" },
            sender: { type: "string", description: "Sender contains (alias for from)" },
            receiver: { type: "string", description: "Receiver contains (alias for to)" },
            subject: { type: "string", description: "Subject contains" },
            body: { type: "string", description: "Body contains" },
            cc: { type: "string", description: "CC contains" },
            bcc: { type: "string", description: "BCC contains" },
            date: { type: "string", description: "Received on date (ISO, e.g. 2026-02-21)" },
            dateFrom: { type: "string", description: "Received since date/time (ISO)" },
            dateTo: { type: "string", description: "Received until date/time (ISO). Date-only is inclusive." },
            sentDate: { type: "string", description: "Sent on date (ISO)" },
            sentDateFrom: { type: "string", description: "Sent since date/time (ISO)" },
            sentDateTo: { type: "string", description: "Sent until date/time (ISO). Date-only is inclusive." },
            seen: { type: "boolean", description: "Only read messages" },
            unseen: { type: "boolean", description: "Only unread messages" },
            messageId: { type: "string", description: "Message-ID header contains" },
            limit: { type: "number", description: "Max results (default 50, capped globally)", default: 50 },
            ...COMMON_LIST_OPTIONS_SCHEMA,
          },
          required: ["mailbox"],
        },
      },
      {
        name: "mail_get_mailbox_status",
        description: "Get message counters for one folder (messages, unseen, recent, UID metadata).",
        inputSchema: {
          type: "object",
          properties: {
            mailbox: { type: "string", description: "Folder name, e.g. INBOX" },
          },
          required: ["mailbox"],
        },
      },
      {
        name: "mail_list_unread",
        description:
          "List unread messages in a folder (envelope only by default). Supports sort/cursor/snippet options.",
        inputSchema: {
          type: "object",
          properties: {
            mailbox: { type: "string", description: "Folder name, e.g. INBOX" },
            limit: {
              type: "number",
              description: "Max number of unread messages to return (default 50, capped globally)",
              default: 50,
            },
            ...COMMON_LIST_OPTIONS_SCHEMA,
          },
          required: ["mailbox"],
        },
      },
      {
        name: "mail_list_attachments",
        description: "List attachment metadata for one message by folder and UID (no binary download).",
        inputSchema: {
          type: "object",
          properties: {
            mailbox: { type: "string", description: "Folder name" },
            uid: { type: "number", description: "Message UID from mail_list_messages or mail_search" },
          },
          required: ["mailbox", "uid"],
        },
      },
      {
        name: "mail_query_by_folder",
        description:
          "Convenience free-text query in one folder. Prefer mail_search_advanced for canonical searches.",
        inputSchema: {
          type: "object",
          properties: {
            mailbox: { type: "string", description: "Folder name, e.g. INBOX" },
            query: { type: "string", description: "Free-text query to match" },
            fields: {
              type: "array",
              description: "Fields to search. Defaults to subject, body, from, to.",
              items: {
                type: "string",
                enum: ["subject", "body", "from", "to"],
              },
            },
            limit: {
              type: "number",
              description: "Max results (default 50, capped globally)",
              default: 50,
            },
            ...COMMON_LIST_OPTIONS_SCHEMA,
          },
          required: ["mailbox", "query"],
        },
      },
      {
        name: "mail_get_thread_context",
        description:
          "Get related messages in the same thread context using Message-ID/References/In-Reply-To. Includes snippets by default.",
        inputSchema: {
          type: "object",
          properties: {
            mailbox: { type: "string", description: "Folder name" },
            uid: { type: "number", description: "Message UID to anchor thread context" },
            limit: {
              type: "number",
              description: "Max related messages to return (default 20, capped globally)",
              default: 20,
            },
            sort: {
              type: "string",
              enum: ["asc", "desc"],
              description: "Sort by UID (default: desc/newest-first)",
              default: "desc",
            },
            cursor: {
              type: "string",
              description: "Opaque pagination cursor from previous thread-context response",
            },
            includeSnippet: {
              type: "boolean",
              description: "Include short plain-text snippet per message (default true)",
              default: true,
            },
          },
          required: ["mailbox", "uid"],
        },
      },
    ],
  };
});

function toOptString(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function buildListOptions(a: Record<string, unknown>, defaultLimit: number): imap.ListQueryOptions {
  const sortRaw = toOptString(a.sort);
  const sort = sortRaw === "asc" ? "asc" : "desc";
  const limit = imap.clampToolLimit(a.limit, MAIL_CONFIG, defaultLimit);
  return {
    limit,
    sort,
    cursor: toOptString(a.cursor),
    includeSnippet: a.includeSnippet === true,
    maxResults: MAIL_CONFIG.maxResults,
    snippetLength: MAIL_CONFIG.snippetLength,
  };
}

function pageOrItems(
  page: imap.PagedMessageEnvelopeResult,
  returnPage: boolean
): imap.PagedMessageEnvelopeResult | imap.MessageEnvelope[] {
  return returnPage ? page : page.items;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args as Record<string, unknown>) ?? {};

  try {
    if (name === "mail_list_folders") {
      const folders = await imap.listFolders(IMAP_CONFIG);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(folders, null, 2),
          },
        ],
        isError: false,
      };
    }

    if (name === "mail_list_messages") {
      const mailbox = String(a.mailbox ?? "");
      const options = buildListOptions(a, 50);
      const page = await imap.listMessagesPage(IMAP_CONFIG, mailbox, options);
      const out = pageOrItems(page, a.returnPage === true || options.cursor != null);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
        isError: false,
      };
    }

    if (name === "mail_get_message") {
      const mailbox = String(a.mailbox ?? "");
      const uid = Number(a.uid);
      if (!uid) {
        return {
          content: [{ type: "text" as const, text: "Error: uid must be a number" }],
          isError: true,
        };
      }
      const msg = await imap.getMessage(IMAP_CONFIG, MAIL_CONFIG, mailbox, uid);
      if (!msg) {
        return {
          content: [{ type: "text" as const, text: `Message not found: ${mailbox} UID ${uid}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(msg, null, 2) }],
        isError: false,
      };
    }

    if (name === "mail_search") {
      const mailbox = String(a.mailbox ?? "");
      const options = buildListOptions(a, 50);
      const criteria: imap.SearchCriteria = {
        from: toOptString(a.from),
        to: toOptString(a.to),
        subject: toOptString(a.subject),
        body: toOptString(a.body),
        since: toOptString(a.since),
        before: toOptString(a.before),
        unseen: a.unseen === true,
      };
      const page = await imap.searchMailPage(IMAP_CONFIG, mailbox, criteria, options);
      const out = pageOrItems(page, a.returnPage === true || options.cursor != null);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
        isError: false,
      };
    }

    if (name === "mail_search_advanced") {
      const mailbox = String(a.mailbox ?? "");
      const options = buildListOptions(a, 50);
      const criteria: imap.AdvancedSearchCriteria = {
        keyword: toOptString(a.keyword),
        sender: toOptString(a.sender),
        receiver: toOptString(a.receiver),
        subject: toOptString(a.subject),
        body: toOptString(a.body),
        cc: toOptString(a.cc),
        bcc: toOptString(a.bcc),
        date: toOptString(a.date),
        dateFrom: toOptString(a.dateFrom),
        dateTo: toOptString(a.dateTo),
        sentDate: toOptString(a.sentDate),
        sentDateFrom: toOptString(a.sentDateFrom),
        sentDateTo: toOptString(a.sentDateTo),
        seen: a.seen === true ? true : undefined,
        unseen: a.unseen === true ? true : undefined,
        messageId: toOptString(a.messageId),
      };

      const hasFilter =
        criteria.keyword != null ||
        criteria.sender != null ||
        criteria.receiver != null ||
        criteria.subject != null ||
        criteria.body != null ||
        criteria.cc != null ||
        criteria.bcc != null ||
        criteria.date != null ||
        criteria.dateFrom != null ||
        criteria.dateTo != null ||
        criteria.sentDate != null ||
        criteria.sentDateFrom != null ||
        criteria.sentDateTo != null ||
        criteria.seen === true ||
        criteria.unseen === true ||
        criteria.messageId != null;
      if (!hasFilter) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Error: provide at least one filter (keyword, sender, receiver, subject, body, date/date range, seen/unseen, or messageId)",
          }],
          isError: true,
        };
      }

      const page = await imap.searchMailAdvancedPage(IMAP_CONFIG, mailbox, criteria, options);
      const out = pageOrItems(page, a.returnPage === true || options.cursor != null);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
        isError: false,
      };
    }

    if (name === "mail_get_mailbox_status") {
      const mailbox = String(a.mailbox ?? "");
      const status = await imap.getMailboxStatus(IMAP_CONFIG, mailbox);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        isError: false,
      };
    }

    if (name === "mail_list_unread") {
      const mailbox = String(a.mailbox ?? "");
      const options = buildListOptions(a, 50);
      const page = await imap.listUnreadMessagesPage(IMAP_CONFIG, mailbox, options);
      const out = pageOrItems(page, a.returnPage === true || options.cursor != null);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
        isError: false,
      };
    }

    if (name === "mail_list_attachments") {
      const mailbox = String(a.mailbox ?? "");
      const uid = Number(a.uid);
      if (!uid) {
        return {
          content: [{ type: "text" as const, text: "Error: uid must be a number" }],
          isError: true,
        };
      }
      const attachments = await imap.listAttachments(IMAP_CONFIG, mailbox, uid);
      if (!attachments) {
        return {
          content: [{ type: "text" as const, text: `Message not found: ${mailbox} UID ${uid}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(attachments, null, 2) }],
        isError: false,
      };
    }

    if (name === "mail_query_by_folder") {
      const mailbox = String(a.mailbox ?? "");
      const query = String(a.query ?? "").trim();
      if (!query) {
        return {
          content: [{ type: "text" as const, text: "Error: query must be a non-empty string" }],
          isError: true,
        };
      }

      const fields = Array.isArray(a.fields)
        ? a.fields
            .map((v) => String(v))
            .filter((v): v is imap.FolderQueryField =>
              v === "subject" || v === "body" || v === "from" || v === "to"
            )
        : undefined;
      const options = buildListOptions(a, 50);
      const page = await imap.queryByFolderPage(IMAP_CONFIG, mailbox, query, fields, options);
      const out = pageOrItems(page, a.returnPage === true || options.cursor != null);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
        isError: false,
      };
    }

    if (name === "mail_get_thread_context") {
      const mailbox = String(a.mailbox ?? "");
      const uid = Number(a.uid);
      if (!uid) {
        return {
          content: [{ type: "text" as const, text: "Error: uid must be a number" }],
          isError: true,
        };
      }

      const options = buildListOptions(
        {
          ...a,
          includeSnippet: a.includeSnippet == null ? true : a.includeSnippet,
          limit: a.limit == null ? 20 : a.limit,
        },
        20
      );
      const thread = await imap.getThreadContext(IMAP_CONFIG, mailbox, uid, options);
      if (!thread) {
        return {
          content: [{ type: "text" as const, text: `Message not found: ${mailbox} UID ${uid}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(thread, null, 2) }],
        isError: false,
      };
    }

    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const ex = e as Error & { responseText?: string; responseStatus?: string; code?: string };
    const parts = [e.message];
    if (ex.responseText) parts.push(ex.responseText);
    if (ex.responseStatus) parts.push(`(${ex.responseStatus})`);
    if (ex.code) parts.push(`code: ${ex.code}`);
    return {
      content: [{ type: "text" as const, text: `Error: ${parts.join(" ")}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
