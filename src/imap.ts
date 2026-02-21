/**
 * Read-only IMAP client for Proton Bridge.
 * Only list, fetch, and search — no write operations.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Attachment, ParsedMail } from "mailparser";
import type { FetchMessageObject, MessageStructureObject } from "imapflow";
import type { ImapConfig, MailConfig } from "./config.js";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  normalizeSort,
  paginateUids,
  type SortOrder,
  toSnippet,
} from "./query.js";

export interface MailboxInfo {
  path: string;
  name: string;
  messages?: number;
  unseen?: number;
}

export interface MessageEnvelope {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string;
  messageId?: string;
  snippet?: string;
}

export interface MessageContent {
  envelope: MessageEnvelope;
  /** Plain-text body (or stripped HTML). Truncated per config. */
  bodyText: string;
}

export interface MailboxStatus {
  path: string;
  messages: number;
  unseen: number;
  recent: number;
  uidNext?: number;
  uidValidity?: string;
  highestModseq?: string;
}

export interface MessageAttachmentInfo {
  filename: string;
  contentType: string;
  contentDisposition: string;
  size: number;
  checksum: string;
  contentId?: string;
  cid?: string;
  related?: boolean;
}

export type SearchCriteria = {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string; // ISO date
  before?: string;
  unseen?: boolean;
};

export type FolderQueryField = "subject" | "body" | "from" | "to";

export interface AdvancedSearchCriteria {
  keyword?: string;
  sender?: string;
  receiver?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  sentDate?: string;
  sentDateFrom?: string;
  sentDateTo?: string;
  seen?: boolean;
  unseen?: boolean;
  messageId?: string;
}

export interface ListQueryOptions {
  limit?: number;
  sort?: SortOrder;
  cursor?: string;
  includeSnippet?: boolean;
  maxResults?: number;
  snippetLength?: number;
}

export interface PagedMessageEnvelopeResult {
  items: MessageEnvelope[];
  nextCursor?: string;
}

export interface ThreadContextResult {
  targetUid: number;
  items: MessageEnvelope[];
  nextCursor?: string;
}

export type ImapClientLike = {
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(options?: unknown): Promise<Array<Record<string, unknown>>>;
  getMailboxLock(mailbox: string, options?: unknown): Promise<{ release(): void }>;
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[] | false>;
  fetch(
    range: string | number[] | Record<string, unknown>,
    query: Record<string, unknown>,
    options?: { uid?: boolean }
  ): AsyncIterableIterator<FetchMessageObject>;
  fetchOne(
    range: string,
    query: Record<string, unknown>,
    options?: { uid?: boolean }
  ): Promise<FetchMessageObject | false>;
  status(path: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
  mailbox?: { exists?: number };
};

type ImapClientFactory = (config: ImapConfig) => ImapClientLike;

function defaultClientFactory(config: ImapConfig): ImapClientLike {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    // Accept self-signed cert for both direct TLS and STARTTLS (Proton Bridge). Set IMAP_TLS_REJECT_UNAUTHORIZED=true to enforce.
    tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
    logger: false,
  }) as unknown as ImapClientLike;
}

let clientFactory: ImapClientFactory = defaultClientFactory;

export function __setClientFactoryForTests(factory?: ImapClientFactory): void {
  clientFactory = factory ?? defaultClientFactory;
}

function getClient(config: ImapConfig): ImapClientLike {
  return clientFactory(config);
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const code = (err as Error & { code?: string }).code;
  return (
    msg.includes("connection not available") ||
    msg.includes("connection closed") ||
    code === "NoConnection" ||
    code === "EConnectionClosed"
  );
}

async function safeLogout(client: ImapClientLike): Promise<void> {
  try {
    await client.logout();
  } catch {
    // Ignore: connection may already be closed (e.g. server BYE or timeout).
  }
}

function parsedToBodyText(parsed: ParsedMail, maxLength: number): string {
  let text = parsed.text ?? "";
  if (!text && parsed.html) {
    // Strip tags for plain text
    text = parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (maxLength > 0 && text.length > maxLength) {
    text = text.slice(0, maxLength) + "\n[... truncated]";
  }
  return text;
}

/** Format envelope address array to string. */
function formatAddresses(arr: Array<{ address?: string; name?: string }> | undefined): string {
  if (!arr?.length) return "";
  return arr.map((a) => a.address ?? a.name ?? "").filter(Boolean).join(", ");
}

function parseDateInput(name: string, value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${name}: ${value}. Use ISO date format like YYYY-MM-DD.`);
  }
  return d;
}

function parseInclusiveEndDate(name: string, value: string | undefined): Date | undefined {
  const d = parseDateInput(name, value);
  if (!d) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) {
    // IMAP BEFORE is exclusive; bump one day to make a YYYY-MM-DD end date inclusive.
    return new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return d;
}

function resolveListOptions(
  options: ListQueryOptions | undefined,
  defaults: { defaultLimit: number; maxResults: number; snippetLength: number }
): Required<Pick<ListQueryOptions, "limit" | "sort" | "includeSnippet" | "maxResults" | "snippetLength">> &
  Pick<ListQueryOptions, "cursor"> {
  const maxResults = Number.isFinite(options?.maxResults)
    ? Math.max(1, Math.floor(options?.maxResults ?? defaults.maxResults))
    : defaults.maxResults;
  return {
    limit: clampLimit(options?.limit, maxResults, defaults.defaultLimit),
    sort: normalizeSort(options?.sort),
    cursor: options?.cursor,
    includeSnippet: options?.includeSnippet === true,
    maxResults,
    snippetLength:
      Number.isFinite(options?.snippetLength) && (options?.snippetLength ?? defaults.snippetLength) >= 0
        ? Math.floor(options?.snippetLength ?? defaults.snippetLength)
        : defaults.snippetLength,
  };
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}

function collectReferenceIds(parsed: ParsedMail): string[] {
  const out = new Set<string>();
  if (parsed.messageId) out.add(normalizeMessageId(parsed.messageId));
  if (typeof parsed.inReplyTo === "string") out.add(normalizeMessageId(parsed.inReplyTo));
  if (Array.isArray(parsed.references)) {
    for (const ref of parsed.references) out.add(normalizeMessageId(String(ref)));
  } else if (typeof parsed.references === "string") {
    out.add(normalizeMessageId(parsed.references));
  }
  return Array.from(out).filter(Boolean);
}

async function envelopeWithOptionalSnippet(
  msg: FetchMessageObject,
  includeSnippet: boolean,
  snippetLength: number
): Promise<MessageEnvelope> {
  const e = msg.envelope;
  const subj = e?.subject;
  const envelope: MessageEnvelope = {
    uid: msg.uid ?? 0,
    subject: Array.isArray(subj) ? subj.join(" ") : String(subj ?? ""),
    from: formatAddresses(e?.from),
    to: formatAddresses(e?.to),
    date: e?.date ? new Date(e.date).toISOString() : "",
    messageId: e?.messageId,
  };
  if (includeSnippet && msg.source) {
    const parsed = await simpleParser(msg.source);
    envelope.snippet = toSnippet(parsedToBodyText(parsed, snippetLength), snippetLength);
  }
  return envelope;
}

function sortEnvelopes(envelopes: MessageEnvelope[], sort: SortOrder): MessageEnvelope[] {
  return envelopes.sort((a, b) => (sort === "asc" ? a.uid - b.uid : b.uid - a.uid));
}

async function fetchEnvelopesByUids(
  client: ImapClientLike,
  uids: number[],
  includeSnippet: boolean,
  snippetLength: number
): Promise<MessageEnvelope[]> {
  if (uids.length === 0) return [];
  const query = includeSnippet
    ? ({ envelope: true, uid: true, source: true } as const)
    : ({ envelope: true, uid: true } as const);
  const envelopes: MessageEnvelope[] = [];
  for await (const msg of client.fetch(uids, query, { uid: true })) {
    envelopes.push(await envelopeWithOptionalSnippet(msg, includeSnippet, snippetLength));
  }
  return envelopes;
}

function attachmentFromStructureNode(node: MessageStructureObject): MessageAttachmentInfo | null {
  const disposition = String(node.disposition ?? "").toLowerCase();
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? "";
  const isAttachment = disposition === "attachment" || Boolean(filename);
  if (!isAttachment) return null;
  const contentId = node.id;
  return {
    filename,
    contentType: node.type,
    contentDisposition: node.disposition ?? "attachment",
    size: node.size ?? 0,
    checksum: node.md5 ?? "",
    contentId,
    cid: contentId ? normalizeMessageId(contentId) : undefined,
    related: disposition === "inline",
  };
}

function attachmentsFromBodyStructure(structure: MessageStructureObject | undefined): MessageAttachmentInfo[] {
  if (!structure) return [];
  const out: MessageAttachmentInfo[] = [];
  const walk = (node: MessageStructureObject): void => {
    const maybe = attachmentFromStructureNode(node);
    if (maybe) out.push(maybe);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(structure);
  return out;
}

function attachmentToInfo(attachment: Attachment): MessageAttachmentInfo {
  return {
    filename: attachment.filename ?? "",
    contentType: attachment.contentType,
    contentDisposition: attachment.contentDisposition,
    size: attachment.size,
    checksum: attachment.checksum,
    contentId: attachment.contentId,
    cid: attachment.cid,
    related: attachment.related,
  };
}

/**
 * List all mailboxes (folders). Read-only.
 */
export async function listFolders(config: ImapConfig): Promise<MailboxInfo[]> {
  const run = async (): Promise<MailboxInfo[]> => {
    const client = getClient(config);
    try {
      await client.connect();
      const list = await client.list({
        statusQuery: { messages: true, unseen: true },
      });
      return list.map((m) => ({
        path: String((m as { path?: string }).path ?? ""),
        name: String((m as { name?: string }).name ?? ""),
        messages: (m as { status?: { messages?: number } }).status?.messages ?? undefined,
        unseen: (m as { status?: { unseen?: number } }).status?.unseen ?? undefined,
      }));
    } finally {
      await safeLogout(client);
    }
  };
  try {
    return await run();
  } catch (err) {
    if (isConnectionError(err)) return await run();
    throw err;
  }
}

/**
 * List recent messages in a folder with pagination controls. Read-only.
 */
export async function listMessagesPage(
  config: ImapConfig,
  mailbox: string,
  options?: ListQueryOptions
): Promise<PagedMessageEnvelopeResult> {
  const opts = resolveListOptions(options, {
    defaultLimit: 50,
    maxResults: options?.maxResults ?? 200,
    snippetLength: options?.snippetLength ?? 400,
  });

  const run = async (): Promise<PagedMessageEnvelopeResult> => {
    const client = getClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        // Fast path for no-cursor list calls: fetch by sequence range instead of mailbox-wide UID search.
        if (!opts.cursor) {
          const total = client.mailbox?.exists ?? 0;
          if (!total) return { items: [] };
          const range =
            opts.sort === "desc"
              ? `${Math.max(1, total - opts.limit + 1)}:*`
              : `1:${Math.min(total, opts.limit)}`;
          const fetchQuery = opts.includeSnippet
            ? ({ envelope: true, uid: true, source: true } as const)
            : ({ envelope: true, uid: true } as const);
          const envelopes: MessageEnvelope[] = [];
          for await (const msg of client.fetch(range, fetchQuery, { uid: false })) {
            envelopes.push(await envelopeWithOptionalSnippet(msg, opts.includeSnippet, opts.snippetLength));
          }
          const items = sortEnvelopes(envelopes, opts.sort);
          const nextCursor = total > opts.limit && items.length > 0 ? encodeCursor(items[items.length - 1].uid) : undefined;
          return { items, nextCursor };
        }

        const searchQuery: Record<string, unknown> = { all: true };
        if (opts.cursor) {
          const cursorUid = decodeCursor(opts.cursor);
          if (cursorUid != null) {
            searchQuery.uid = opts.sort === "asc" ? `${cursorUid + 1}:*` : `1:${Math.max(1, cursorUid - 1)}`;
            delete searchQuery.all;
          }
        }

        const matchedRaw = await client.search(searchQuery, { uid: true });
        const matched = Array.isArray(matchedRaw) ? matchedRaw : [];
        const paged = paginateUids(matched, {
          limit: opts.limit,
          maxResults: opts.maxResults,
          sort: opts.sort,
        });
        const envelopes = await fetchEnvelopesByUids(client, paged.pageUids, opts.includeSnippet, opts.snippetLength);
        return {
          items: sortEnvelopes(envelopes, opts.sort),
          nextCursor: paged.nextCursor,
        };
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client);
    }
  };

  try {
    return await run();
  } catch (err) {
    if (isConnectionError(err)) return await run();
    throw err;
  }
}

/**
 * Backward-compatible list API (array output).
 */
export async function listMessages(
  config: ImapConfig,
  mailbox: string,
  limit: number = 50
): Promise<MessageEnvelope[]> {
  const out = await listMessagesPage(config, mailbox, { limit });
  return out.items;
}

/**
 * Fetch one message by mailbox and UID. Returns envelope + body text. Read-only.
 */
export async function getMessage(
  config: ImapConfig,
  mailConfig: MailConfig,
  mailbox: string,
  uid: number
): Promise<MessageContent | null> {
  const run = async (): Promise<MessageContent | null> => {
    const client = getClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const msg = await client.fetchOne(
          String(uid),
          {
            envelope: true,
            uid: true,
            source: true,
          },
          { uid: true }
        );
        if (!msg || !msg.source) return null;
        const parsed = await simpleParser(msg.source);
        const envelope = await envelopeWithOptionalSnippet(msg, false, mailConfig.snippetLength);
        return {
          envelope,
          bodyText: parsedToBodyText(parsed, mailConfig.maxBodyLength),
        };
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client);
    }
  };
  try {
    return await run();
  } catch (err) {
    if (isConnectionError(err)) return await run();
    throw err;
  }
}

/**
 * Search in a mailbox. Returns paged UIDs and envelopes. Read-only.
 */
export async function searchMailPage(
  config: ImapConfig,
  mailbox: string,
  criteria: SearchCriteria,
  options?: ListQueryOptions
): Promise<PagedMessageEnvelopeResult> {
  const opts = resolveListOptions(options, {
    defaultLimit: 50,
    maxResults: options?.maxResults ?? 200,
    snippetLength: options?.snippetLength ?? 400,
  });

  const run = async (): Promise<PagedMessageEnvelopeResult> => {
    const client = getClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const query: Record<string, unknown> = {};
        if (criteria.from) query.from = criteria.from;
        if (criteria.to) query.to = criteria.to;
        if (criteria.subject) query.subject = criteria.subject;
        if (criteria.body) query.body = criteria.body;
        if (criteria.since) query.since = parseDateInput("since", criteria.since);
        if (criteria.before) query.before = parseDateInput("before", criteria.before);
        if (criteria.unseen === true) query.seen = false;

        const matchedRaw = await client.search(query, { uid: true });
        const matched = Array.isArray(matchedRaw) ? matchedRaw : [];
        const paged = paginateUids(matched, {
          limit: opts.limit,
          maxResults: opts.maxResults,
          sort: opts.sort,
          cursor: opts.cursor,
        });

        const envelopes = await fetchEnvelopesByUids(client, paged.pageUids, opts.includeSnippet, opts.snippetLength);
        return {
          items: sortEnvelopes(envelopes, opts.sort),
          nextCursor: paged.nextCursor,
        };
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client);
    }
  };

  try {
    return await run();
  } catch (err) {
    if (isConnectionError(err)) return await run();
    throw err;
  }
}

/**
 * Backward-compatible search API (array output).
 */
export async function searchMail(
  config: ImapConfig,
  mailbox: string,
  criteria: SearchCriteria,
  limit: number = 50
): Promise<MessageEnvelope[]> {
  const out = await searchMailPage(config, mailbox, criteria, { limit });
  return out.items;
}

/**
 * Advanced multi-filter search in a mailbox. Returns matching envelopes.
 * Combines provided filters with AND semantics (standard IMAP search behavior).
 */
export async function searchMailAdvancedPage(
  config: ImapConfig,
  mailbox: string,
  criteria: AdvancedSearchCriteria,
  options?: ListQueryOptions
): Promise<PagedMessageEnvelopeResult> {
  const opts = resolveListOptions(options, {
    defaultLimit: 50,
    maxResults: options?.maxResults ?? 200,
    snippetLength: options?.snippetLength ?? 400,
  });

  const run = async (): Promise<PagedMessageEnvelopeResult> => {
    const client = getClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        if (criteria.seen === true && criteria.unseen === true) {
          throw new Error("seen and unseen cannot both be true");
        }

        const query: Record<string, unknown> = {};
        if (criteria.keyword) query.text = criteria.keyword;
        if (criteria.sender) query.from = criteria.sender;
        if (criteria.receiver) query.to = criteria.receiver;
        if (criteria.cc) query.cc = criteria.cc;
        if (criteria.bcc) query.bcc = criteria.bcc;
        if (criteria.subject) query.subject = criteria.subject;
        if (criteria.body) query.body = criteria.body;
        if (criteria.seen === true) query.seen = true;
        if (criteria.unseen === true) query.seen = false;
        if (criteria.messageId) query.header = { "message-id": criteria.messageId };

        const receivedOn = parseDateInput("date", criteria.date);
        const receivedSince = parseDateInput("dateFrom", criteria.dateFrom);
        const receivedBefore = parseInclusiveEndDate("dateTo", criteria.dateTo);
        const sentOn = parseDateInput("sentDate", criteria.sentDate);
        const sentSince = parseDateInput("sentDateFrom", criteria.sentDateFrom);
        const sentBefore = parseInclusiveEndDate("sentDateTo", criteria.sentDateTo);

        if (receivedOn) query.on = receivedOn;
        if (receivedSince) query.since = receivedSince;
        if (receivedBefore) query.before = receivedBefore;
        if (sentOn) query.sentOn = sentOn;
        if (sentSince) query.sentSince = sentSince;
        if (sentBefore) query.sentBefore = sentBefore;

        if (receivedSince && receivedBefore && receivedSince >= receivedBefore) {
          throw new Error("dateFrom must be earlier than or equal to dateTo");
        }
        if (sentSince && sentBefore && sentSince >= sentBefore) {
          throw new Error("sentDateFrom must be earlier than or equal to sentDateTo");
        }

        const matchedRaw = await client.search(query, { uid: true });
        const matched = Array.isArray(matchedRaw) ? matchedRaw : [];
        const paged = paginateUids(matched, {
          limit: opts.limit,
          maxResults: opts.maxResults,
          sort: opts.sort,
          cursor: opts.cursor,
        });

        const envelopes = await fetchEnvelopesByUids(client, paged.pageUids, opts.includeSnippet, opts.snippetLength);
        return {
          items: sortEnvelopes(envelopes, opts.sort),
          nextCursor: paged.nextCursor,
        };
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client);
    }
  };

  try {
    return await run();
  } catch (err) {
    if (isConnectionError(err)) return await run();
    throw err;
  }
}

/**
 * Backward-compatible advanced search API (array output).
 */
export async function searchMailAdvanced(
  config: ImapConfig,
  mailbox: string,
  criteria: AdvancedSearchCriteria,
  limit: number = 50
): Promise<MessageEnvelope[]> {
  const out = await searchMailAdvancedPage(config, mailbox, criteria, { limit });
  return out.items;
}

/**
 * Get status counters for a mailbox. Read-only.
 */
export async function getMailboxStatus(
  config: ImapConfig,
  mailbox: string
): Promise<MailboxStatus> {
  const run = async (): Promise<MailboxStatus> => {
    const client = getClient(config);
    try {
      await client.connect();
      const status = await client.status(mailbox, {
        messages: true,
        unseen: true,
        recent: true,
        uidNext: true,
        uidValidity: true,
        highestModseq: true,
      });
      return {
        path: String((status as { path?: string }).path ?? mailbox),
        messages: (status as { messages?: number }).messages ?? 0,
        unseen: (status as { unseen?: number }).unseen ?? 0,
        recent: (status as { recent?: number }).recent ?? 0,
        uidNext: (status as { uidNext?: number }).uidNext ?? undefined,
        uidValidity: (status as { uidValidity?: bigint }).uidValidity?.toString(),
        highestModseq: (status as { highestModseq?: bigint }).highestModseq?.toString(),
      };
    } finally {
      await safeLogout(client);
    }
  };
  try {
    return await run();
  } catch (err) {
    if (isConnectionError(err)) return await run();
    throw err;
  }
}

/**
 * List unread messages in a folder (envelope only). Read-only.
 */
export async function listUnreadMessagesPage(
  config: ImapConfig,
  mailbox: string,
  options?: ListQueryOptions
): Promise<PagedMessageEnvelopeResult> {
  return searchMailPage(config, mailbox, { unseen: true }, options);
}

/**
 * Backward-compatible unread list API (array output).
 */
export async function listUnreadMessages(
  config: ImapConfig,
  mailbox: string,
  limit: number = 50
): Promise<MessageEnvelope[]> {
  const out = await listUnreadMessagesPage(config, mailbox, { limit });
  return out.items;
}

/**
 * List attachment metadata for a message (no binary content). Read-only.
 */
export async function listAttachments(
  config: ImapConfig,
  mailbox: string,
  uid: number
): Promise<MessageAttachmentInfo[] | null> {
  const run = async (): Promise<MessageAttachmentInfo[] | null> => {
    const client = getClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const metaMsg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
        if (!metaMsg) return null;

        const fromStructure = attachmentsFromBodyStructure(metaMsg.bodyStructure);
        if (metaMsg.bodyStructure) return fromStructure;

        const sourceMsg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        if (!sourceMsg || !sourceMsg.source) return [];
        const parsed = await simpleParser(sourceMsg.source);
        return parsed.attachments.map(attachmentToInfo);
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client);
    }
  };
  try {
    return await run();
  } catch (err) {
    if (isConnectionError(err)) return await run();
    throw err;
  }
}

/**
 * Free-text query in a single folder across selected fields.
 * Results are deduplicated by UID and returned as envelopes.
 */
export async function queryByFolderPage(
  config: ImapConfig,
  mailbox: string,
  query: string,
  fields: FolderQueryField[] = ["subject", "body", "from", "to"],
  options?: ListQueryOptions
): Promise<PagedMessageEnvelopeResult> {
  const q = query.trim();
  if (!q) return { items: [] };

  const opts = resolveListOptions(options, {
    defaultLimit: 50,
    maxResults: options?.maxResults ?? 200,
    snippetLength: options?.snippetLength ?? 400,
  });

  const safeFields = Array.from(
    new Set(fields.filter((f): f is FolderQueryField => ["subject", "body", "from", "to"].includes(f)))
  );
  if (safeFields.length === 0) return { items: [] };

  const run = async (): Promise<PagedMessageEnvelopeResult> => {
    const client = getClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const uidSet = new Set<number>();
        for (const field of safeFields) {
          const searchObject = { [field]: q };
          const uidsRaw = await client.search(searchObject, { uid: true });
          if (Array.isArray(uidsRaw)) {
            for (const foundUid of uidsRaw) uidSet.add(foundUid);
          }
        }

        const paged = paginateUids(Array.from(uidSet), {
          limit: opts.limit,
          maxResults: opts.maxResults,
          sort: opts.sort,
          cursor: opts.cursor,
        });
        const envelopes = await fetchEnvelopesByUids(client, paged.pageUids, opts.includeSnippet, opts.snippetLength);
        return {
          items: sortEnvelopes(envelopes, opts.sort),
          nextCursor: paged.nextCursor,
        };
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client);
    }
  };

  try {
    return await run();
  } catch (err) {
    if (isConnectionError(err)) return await run();
    throw err;
  }
}

/**
 * Backward-compatible free-text folder query API (array output).
 */
export async function queryByFolder(
  config: ImapConfig,
  mailbox: string,
  query: string,
  limit: number = 50,
  fields: FolderQueryField[] = ["subject", "body", "from", "to"]
): Promise<MessageEnvelope[]> {
  const out = await queryByFolderPage(config, mailbox, query, fields, { limit });
  return out.items;
}

/**
 * Get thread context for a message UID using Message-ID / References / In-Reply-To headers.
 */
export async function getThreadContext(
  config: ImapConfig,
  mailbox: string,
  uid: number,
  options?: ListQueryOptions
): Promise<ThreadContextResult | null> {
  const opts = resolveListOptions(
    {
      includeSnippet: options?.includeSnippet ?? true,
      ...options,
    },
    {
      defaultLimit: 20,
      maxResults: options?.maxResults ?? 200,
      snippetLength: options?.snippetLength ?? 400,
    }
  );

  const run = async (): Promise<ThreadContextResult | null> => {
    const client = getClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const target = await client.fetchOne(
          String(uid),
          { uid: true, envelope: true, source: true },
          { uid: true }
        );
        if (!target || !target.source) return null;

        const parsedTarget = await simpleParser(target.source);
        const relatedIds = new Set<string>(collectReferenceIds(parsedTarget));
        if (target.envelope?.messageId) {
          relatedIds.add(normalizeMessageId(target.envelope.messageId));
        }
        if (target.envelope?.inReplyTo) {
          relatedIds.add(normalizeMessageId(target.envelope.inReplyTo));
        }

        const uidSet = new Set<number>([uid]);
        for (const id of relatedIds) {
          const bracketed = `<${id}>`;
          const query = {
            or: [
              { header: { "message-id": bracketed } },
              { header: { references: bracketed } },
              { header: { "in-reply-to": bracketed } },
            ],
          };
          const matchesRaw = await client.search(query, { uid: true });
          if (Array.isArray(matchesRaw)) {
            for (const foundUid of matchesRaw) uidSet.add(foundUid);
          }
        }

        const paged = paginateUids(Array.from(uidSet), {
          limit: opts.limit,
          maxResults: opts.maxResults,
          sort: opts.sort,
          cursor: opts.cursor,
        });
        const envelopes = await fetchEnvelopesByUids(client, paged.pageUids, opts.includeSnippet, opts.snippetLength);
        return {
          targetUid: uid,
          items: sortEnvelopes(envelopes, opts.sort),
          nextCursor: paged.nextCursor,
        };
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client);
    }
  };

  try {
    return await run();
  } catch (err) {
    if (isConnectionError(err)) return await run();
    throw err;
  }
}

export function clampToolLimit(limit: unknown, mailConfig: MailConfig, defaultLimit: number = 50): number {
  return clampLimit(limit, mailConfig.maxResults, defaultLimit);
}
