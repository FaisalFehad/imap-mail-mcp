# IMAP Mail MCP

IMAP Mail MCP is an MCP (Model Context Protocol) server that lets LLM clients read email through IMAP tools.

It is designed for:
- local AI workflows (Cursor, ollmcp, other MCP hosts)
- mailbox exploration/search/summarization
- extension by developers who want to add mail tools

Current implementation is read-only (list/search/fetch/status/thread context/attachment metadata).

## What You Get

- 10 MCP tools for common mail workflows
- consistent sorting and cursor pagination support
- guardrails for result size and snippet size
- deterministic tests plus CI
- TypeScript codebase that is easy to extend

## Quick Start

### 1. Install

```bash
git clone https://github.com/FaisalFehad/imap-mail-mcp.git
cd imap-mail-mcp
cp .env.example .env
npm install
npm run build
```

### 2. Configure `.env`

Set IMAP credentials in `.env`:

| Variable | Required | Description | Typical Example |
|---|---|---|---|
| `IMAP_HOST` | yes | IMAP host | `127.0.0.1` |
| `IMAP_PORT` | yes | IMAP port | `1143` |
| `IMAP_SECURE` | yes | `true` for TLS, `false` for plain | `false` |
| `IMAP_USER` | yes | IMAP username | `you@proton.me` |
| `IMAP_PASS` | yes | IMAP password | `...` |
| `IMAP_TLS_REJECT_UNAUTHORIZED` | no | validate TLS cert chain | `false` for local self-signed |
| `MAIL_MAX_BODY_LENGTH` | no | max body chars in `mail_get_message` | `50000` |
| `MAIL_MAX_RESULTS` | no | global cap for list/search limits | `200` |
| `MAIL_SNIPPET_LENGTH` | no | max snippet chars when enabled | `400` |

Proton Bridge users usually run with `IMAP_HOST=127.0.0.1`, `IMAP_PORT=1143`, `IMAP_SECURE=false`.

### 3. Run

```bash
node dist/index.js
```

Or via package bin:

```bash
npx imap-mail-mcp
```

Compatibility alias still works:

```bash
npx proton-bridge-mcp
```

## MCP Client Setup

### Cursor

Add server config (Settings -> MCP):

```json
{
  "mcpServers": {
    "imap-mail": {
      "command": "node",
      "args": ["/absolute/path/to/imap-mail-mcp/dist/index.js"],
      "env": {
        "IMAP_HOST": "127.0.0.1",
        "IMAP_PORT": "1143",
        "IMAP_SECURE": "false",
        "IMAP_USER": "your@proton.me",
        "IMAP_PASS": "your-bridge-password"
      }
    }
  }
}
```

### ollmcp

1. Create `~/.config/ollmcp/mcp-servers/servers.json`:

```json
{
  "mcpServers": {
    "imap-mail": {
      "command": "node",
      "args": ["/absolute/path/to/imap-mail-mcp/dist/index.js"],
      "env": {
        "IMAP_HOST": "127.0.0.1",
        "IMAP_PORT": "1143",
        "IMAP_SECURE": "false",
        "IMAP_USER": "your@proton.me",
        "IMAP_PASS": "your-bridge-password"
      },
      "disabled": false
    }
  }
}
```

2. Run:

```bash
ollmcp -j ~/.config/ollmcp/mcp-servers/servers.json
```

If `ollmcp` is not in PATH, use `~/.local/bin/ollmcp`.

## Tool Reference

Use `mail_search_advanced` as the default search entry point.

| Tool | Use For | Notes |
|---|---|---|
| `mail_list_folders` | list mailboxes/folders | start here |
| `mail_list_messages` | list messages in one mailbox | supports `limit`, `sort`, `cursor`, `includeSnippet`, `returnPage` |
| `mail_get_message` | full message body by UID | returns envelope + body text |
| `mail_search` | basic filter search | convenience wrapper |
| `mail_search_advanced` | keyword/sender/receiver/subject/body/date/sent-date/read-state/message-id | primary search tool |
| `mail_get_mailbox_status` | counters for one mailbox | messages, unseen, recent, UID metadata |
| `mail_list_unread` | unread messages in a mailbox | same pagination/sort options as list/search |
| `mail_list_attachments` | attachment metadata by UID | no binary download |
| `mail_query_by_folder` | free text query by selected fields | convenience wrapper |
| `mail_get_thread_context` | related messages around a UID | thread continuity for summarization/reply |

### Common List/Search Options

Supported by list/search tools:

- `limit`: requested size (clamped by `MAIL_MAX_RESULTS`)
- `sort`: `asc` or `desc` (default `desc`)
- `cursor`: opaque cursor for next page
- `includeSnippet`: include snippet text in envelope results
- `returnPage`: return `{ items, nextCursor }` instead of only array

Envelope result fields are stable:

```json
{
  "uid": 123,
  "subject": "string",
  "from": "comma-separated addresses",
  "to": "comma-separated addresses",
  "date": "ISO-8601 string",
  "messageId": "optional string",
  "snippet": "optional string"
}
```

## Example Workflows

### Find unread billing mail in INBOX

1. `mail_search_advanced` with `mailbox=INBOX`, `keyword=bill`, `unseen=true`, `limit=20`
2. `mail_get_message` on the most relevant UID

### Summarize a conversation before drafting a reply

1. `mail_get_thread_context` with target UID and `limit`
2. fetch one or two full messages with `mail_get_message`
3. summarize using context

### Scan a large folder in pages

1. `mail_list_messages` with `returnPage=true`
2. pass returned `nextCursor` to next call until absent

## Developer Guide (Use This Codebase)

### Project Layout

```text
src/index.ts   MCP server, tool schemas, handlers
src/imap.ts    IMAP operations and query behavior
src/query.ts   sorting/pagination/cursor/snippet helpers
src/config.ts  environment parsing and defaults
tests/*.test.mjs deterministic tests
```

### Add a New Tool

1. Add schema in `src/index.ts` tool list.
2. Add handler branch in `src/index.ts` call handler.
3. Implement IMAP logic in `src/imap.ts`.
4. Add deterministic tests in `tests/`.
5. Update this README tool table.

### Keep LLM Behavior Predictable

- keep envelope field names stable
- prefer additive changes (avoid breaking existing tool args)
- keep default ordering deterministic
- keep limits clamped
- avoid expensive full-mailbox scans where possible

## Testing

Run deterministic tests (no live mailbox required):

```bash
npm test
```

Run live smoke test (requires real IMAP credentials):

```bash
node scripts/test-mcp.mjs
```

CI runs:

- `npm ci`
- `npx tsc --noEmit`
- `npm test`

## Troubleshooting

### `Error: Command failed no such user (NO)`

Usually bad `IMAP_USER`/`IMAP_PASS` or temporary server lockout after failed attempts.

Check:
- `IMAP_USER` is your IMAP login identity, not host/IP
- `IMAP_PASS` is correct for that IMAP account
- for Proton Bridge, use the Bridge-generated password
- wait a few minutes after repeated failed login attempts

### TLS errors (`wrong version number`, `ssl3_get_record`)

You are likely using TLS against a plain IMAP port.

Fix:
- set `IMAP_SECURE=false` for local plain IMAP endpoints (common with Bridge)
- verify port matches secure/non-secure mode

### Self-signed cert errors

If your IMAP endpoint uses self-signed certs:

- set `IMAP_TLS_REJECT_UNAUTHORIZED=false`

### `ollmcp: command not found`

Install via pip/pipx/uvx, or run with full path:

```bash
~/.local/bin/ollmcp -j ~/.config/ollmcp/mcp-servers/servers.json
```

## Security

- never commit `.env` or credential files
- keep IMAP credentials in MCP client env or local `.env`
- this implementation does not send or modify mail

## License

MIT
