import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __setClientFactoryForTests,
  getThreadContext,
  listAttachments,
  listMessagesPage,
  searchMailAdvancedPage,
  searchMailPage,
} from "../dist/imap.js";

const IMAP_CONFIG = {
  host: "127.0.0.1",
  port: 1143,
  secure: false,
  tlsRejectUnauthorized: false,
  user: "tester@example.com",
  pass: "test-password",
};

function makeEnvelope(uid, overrides = {}) {
  return {
    uid,
    envelope: {
      subject: overrides.subject ?? `Subject ${uid}`,
      from: [{ address: `from${uid}@example.com` }],
      to: [{ address: `to${uid}@example.com` }],
      date: overrides.date ?? new Date(`2024-01-${String((uid % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
      messageId: overrides.messageId ?? `<m${uid}@example.com>`,
      inReplyTo: overrides.inReplyTo,
    },
    source: overrides.source,
    bodyStructure: overrides.bodyStructure,
  };
}

function extractThreadQueryId(query) {
  if (!query || typeof query !== "object") return undefined;
  const orList = query.or;
  if (!Array.isArray(orList) || orList.length === 0) return undefined;
  const firstOr = orList[0];
  if (!firstOr || typeof firstOr !== "object") return undefined;
  const header = firstOr.header;
  if (!header || typeof header !== "object") return undefined;
  const id = header["message-id"];
  return typeof id === "string" ? id : undefined;
}

function createMockClient(options = {}) {
  const mailboxExists = options.mailboxExists ?? 0;
  const calls = {
    connect: 0,
    logout: 0,
    release: 0,
    search: [],
    fetch: [],
    fetchOne: [],
  };

  const client = {
    mailbox: { exists: mailboxExists },
    async connect() {
      calls.connect += 1;
    },
    async logout() {
      calls.logout += 1;
    },
    async list() {
      return [];
    },
    async getMailboxLock() {
      return {
        release() {
          calls.release += 1;
        },
      };
    },
    async search(query, fetchOptions) {
      calls.search.push({ query, fetchOptions });
      if (options.searchImpl) return options.searchImpl(query, fetchOptions);
      return [];
    },
    fetch(range, query, fetchOptions) {
      calls.fetch.push({ range, query, fetchOptions });
      if (options.fetchImpl) return options.fetchImpl(range, query, fetchOptions);
      return (async function* () {
        if (Array.isArray(range)) {
          for (const uid of [...range].reverse()) {
            yield makeEnvelope(uid);
          }
          return;
        }
        if (typeof range === "string") {
          const match = /^(\d+):\*$/.exec(range);
          if (!match) return;
          const start = Number(match[1]);
          for (let uid = start; uid <= mailboxExists; uid += 1) {
            yield makeEnvelope(uid);
          }
        }
      })();
    },
    async fetchOne(range, query, fetchOptions) {
      calls.fetchOne.push({ range, query, fetchOptions });
      if (options.fetchOneImpl) return options.fetchOneImpl(range, query, fetchOptions);
      return false;
    },
    async status() {
      return {};
    },
  };

  return { client, calls };
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
});

test("advanced search rejects invalid date input", async () => {
  const { client, calls } = createMockClient();
  __setClientFactoryForTests(() => client);

  await assert.rejects(
    () =>
      searchMailAdvancedPage(
        IMAP_CONFIG,
        "INBOX",
        { date: "not-a-date" },
        { limit: 10, maxResults: 200 }
      ),
    /Invalid date/
  );

  assert.equal(calls.search.length, 0);
  assert.equal(calls.release, 1);
  assert.equal(calls.logout, 1);
});

test("advanced search rejects seen/unseen conflict", async () => {
  const { client, calls } = createMockClient();
  __setClientFactoryForTests(() => client);

  await assert.rejects(
    () =>
      searchMailAdvancedPage(
        IMAP_CONFIG,
        "INBOX",
        { seen: true, unseen: true },
        { limit: 10, maxResults: 200 }
      ),
    /cannot both be true/
  );

  assert.equal(calls.search.length, 0);
  assert.equal(calls.release, 1);
  assert.equal(calls.logout, 1);
});

test("search pagination returns stable desc order with no duplicates", async () => {
  const { client } = createMockClient({
    searchImpl: () => [7, 10, 8, 9],
  });
  __setClientFactoryForTests(() => client);

  const page1 = await searchMailPage(
    IMAP_CONFIG,
    "INBOX",
    { subject: "invoice" },
    { limit: 2, sort: "desc", maxResults: 200 }
  );
  assert.deepEqual(
    page1.items.map((item) => item.uid),
    [10, 9]
  );
  assert.ok(page1.nextCursor);

  const page2 = await searchMailPage(
    IMAP_CONFIG,
    "INBOX",
    { subject: "invoice" },
    { limit: 2, sort: "desc", maxResults: 200, cursor: page1.nextCursor }
  );
  assert.deepEqual(
    page2.items.map((item) => item.uid),
    [8, 7]
  );
  assert.equal(page2.nextCursor, undefined);
});

test("mail_list_messages fast path avoids mailbox-wide UID search", async () => {
  const { client, calls } = createMockClient({
    mailboxExists: 5,
    searchImpl: (query) => (query.uid === "1:3" ? [1, 2, 3] : []),
  });
  __setClientFactoryForTests(() => client);

  const page1 = await listMessagesPage(
    IMAP_CONFIG,
    "INBOX",
    { limit: 2, sort: "desc", maxResults: 200, includeSnippet: false }
  );
  assert.deepEqual(
    page1.items.map((item) => item.uid),
    [5, 4]
  );
  assert.ok(page1.nextCursor);
  assert.equal(calls.search.length, 0);
  assert.equal(calls.fetch[0].range, "4:*");

  const page2 = await listMessagesPage(
    IMAP_CONFIG,
    "INBOX",
    { limit: 2, sort: "desc", maxResults: 200, includeSnippet: false, cursor: page1.nextCursor }
  );
  assert.deepEqual(
    page2.items.map((item) => item.uid),
    [3, 2]
  );
  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].query.uid, "1:3");
});

test("attachment listing prefers bodyStructure metadata path", async () => {
  const { client, calls } = createMockClient({
    fetchOneImpl: (_range, query) => {
      if (query.bodyStructure) {
        return makeEnvelope(42, {
          bodyStructure: {
            type: "multipart/mixed",
            childNodes: [
              {
                type: "application/pdf",
                disposition: "attachment",
                dispositionParameters: { filename: "invoice.pdf" },
                size: 12345,
                md5: "abc123",
                id: "<cid-invoice>",
                childNodes: [],
              },
            ],
          },
        });
      }
      throw new Error("source parse fallback should not be used when bodyStructure exists");
    },
  });
  __setClientFactoryForTests(() => client);

  const attachments = await listAttachments(IMAP_CONFIG, "INBOX", 42);
  assert.ok(Array.isArray(attachments));
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].filename, "invoice.pdf");
  assert.equal(attachments[0].contentType, "application/pdf");
  assert.equal(calls.fetchOne.length, 1);
  assert.equal(Boolean(calls.fetchOne[0].query.bodyStructure), true);
});

test("thread context returns related envelopes with pagination", async () => {
  const threadSource = Buffer.from(
    [
      "Message-ID: <m10@example.com>",
      "In-Reply-To: <m9@example.com>",
      "References: <m8@example.com> <m9@example.com>",
      "Subject: Re: Project Update",
      "From: from10@example.com",
      "To: to10@example.com",
      "Date: Mon, 01 Jan 2024 00:00:00 +0000",
      "",
      "Thread body",
    ].join("\r\n"),
    "utf8"
  );

  const { client } = createMockClient({
    searchImpl: (query) => {
      const id = extractThreadQueryId(query);
      if (id === "<m10@example.com>") return [10, 11];
      if (id === "<m9@example.com>") return [9];
      if (id === "<m8@example.com>") return [8, 7];
      return [];
    },
    fetchOneImpl: (_range, query) => {
      if (query.source && query.envelope) {
        return makeEnvelope(10, {
          source: threadSource,
          messageId: "<m10@example.com>",
          inReplyTo: "<m9@example.com>",
        });
      }
      return false;
    },
  });
  __setClientFactoryForTests(() => client);

  const page1 = await getThreadContext(
    IMAP_CONFIG,
    "INBOX",
    10,
    { limit: 3, sort: "desc", includeSnippet: false, maxResults: 200 }
  );
  assert.ok(page1);
  assert.equal(page1.targetUid, 10);
  assert.deepEqual(
    page1.items.map((item) => item.uid),
    [11, 10, 9]
  );
  assert.ok(page1.nextCursor);

  const page2 = await getThreadContext(
    IMAP_CONFIG,
    "INBOX",
    10,
    { limit: 3, sort: "desc", includeSnippet: false, maxResults: 200, cursor: page1.nextCursor }
  );
  assert.ok(page2);
  assert.deepEqual(
    page2.items.map((item) => item.uid),
    [8, 7]
  );
  assert.equal(page2.nextCursor, undefined);
});
