# Proton Bridge MCP

**Read-only** MCP (Model Context Protocol) server that exposes your Proton Mail inbox via IMAP (Proton Bridge). Use it with local LLMs (e.g. [Ollama](https://ollama.com)) or any MCP client so the model can list folders, search mail, fetch messages, inspect mailbox status, retrieve thread context, and view attachment metadata—without ever sending or modifying mail.

## Features

- **Read-only**: Only IMAP read operations (list, fetch, search, status, thread context, attachment metadata). No SMTP, no write operations.
- **Ten MCP tools**:
  - `mail_list_folders` – List mailboxes (INBOX, Sent, etc.)
  - `mail_list_messages` – List recent messages in a folder (supports sort/cursor/snippet/page output)
  - `mail_get_message` – Fetch one full message (envelope + body text)
  - `mail_search` – Basic convenience search by from, to, subject, body, date, unread
  - `mail_search_advanced` – **Primary search tool** for keyword, sender/receiver, subject/body, exact date, date range, sent date range, read state, message-id
  - `mail_get_mailbox_status` – Get counters for one mailbox (messages, unseen, recent)
  - `mail_list_unread` – List unread messages in a mailbox (supports sort/cursor/snippet/page output)
  - `mail_list_attachments` – List attachment metadata for one message (filename, size, type, etc.)
  - `mail_query_by_folder` – Convenience free-text query in one folder with selectable fields
  - `mail_get_thread_context` – Retrieve related messages in thread context by UID with snippets
- **Configurable**: Env-based config; optional body length limit for LLM context.
- **Customisable**: TypeScript codebase; add tools or resources as needed.

## Prerequisites

1. **Proton Bridge** running and logged in ([Proton Bridge](https://proton.me/mail/bridge)).
2. **Node.js** 18+.
3. An **MCP client** that supports tools (e.g. Cursor, [Ollamac](https://ollamac.com), or another MCP host).

## Setup

```bash
git clone https://github.com/faisal/proton-bridge-mcp.git
cd proton-bridge-mcp
cp .env.example .env
# Edit .env with your Proton Bridge IMAP credentials (see below)
npm install
npm run build
```

### Environment variables

Copy `.env.example` to `.env` and set:

| Variable | Description | Example |
|----------|-------------|---------|
| `IMAP_HOST` | Bridge IMAP host | `127.0.0.1` |
| `IMAP_PORT` | Bridge IMAP port | `1143` |
| `IMAP_SECURE` | Use TLS | `false` (typical for local Bridge) |
| `IMAP_USER` | Bridge IMAP user (your Proton address) | `you@proton.me` |
| `IMAP_PASS` | Bridge IMAP password (from Bridge app) | — |
| `MAIL_MAX_BODY_LENGTH` | Max body chars returned (0 = no limit) | `50000` |
| `MAIL_MAX_RESULTS` | Global hard cap for list/search results | `200` |
| `MAIL_SNIPPET_LENGTH` | Max snippet length when `includeSnippet=true` | `400` |

Proton Bridge usually runs IMAP on `127.0.0.1:1143` with TLS off for local use.

## Running the server

The server speaks MCP over **stdio**. Run it as the command for your MCP client:

```bash
node dist/index.js
# or
npx proton-bridge-mcp
```

### Cursor

Add to your MCP config (e.g. Cursor Settings → MCP):

```json
{
  "mcpServers": {
    "proton-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/proton-bridge-mcp/dist/index.js"],
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

Use an absolute path and do not commit `IMAP_PASS`.

### ollmcp (MCP Client for Ollama)

[ollmcp](https://github.com/jonigl/mcp-client-for-ollama) is a TUI client that connects Ollama to MCP servers. Use a **JSON config** so ollmcp can run `node dist/index.js` with the right env (the `-s` flag is for single scripts, not Node + args + env).

1. **Install ollmcp**
   ```bash
   pip install --upgrade ollmcp
   # or: uvx ollmcp
   ```

2. **Create a server config** (e.g. `~/.config/ollmcp/mcp-servers/servers.json`):
   ```json
   {
     "mcpServers": {
       "proton-bridge": {
         "command": "node",
         "args": ["/absolute/path/to/proton-bridge-mcp/dist/index.js"],
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
   Replace `/absolute/path/to/proton-bridge-mcp` with your repo path and set `IMAP_USER` / `IMAP_PASS`.

3. **Run ollmcp**
   ```bash
   ollmcp -j ~/.config/ollmcp/mcp-servers/servers.json
   ```
   Or with a model: `ollmcp -j ~/.config/ollmcp/mcp-servers/servers.json -m qwen2.5:7b`

4. **In the TUI**: Use **`t`** (tools) to enable the proton-bridge tools. Use a tool-capable model (e.g. qwen2.5, llama3.1, llama3.2, mistral). Ask things like *“List my mail folders”* or *“Show the last 5 messages in INBOX”*. Use **`hil`** to toggle human-in-the-loop (approve each tool call). Use **`rs`** (reload-servers) to reload config without exiting.

## Tool Guidance for LLMs

- Prefer `mail_search_advanced` for most retrieval tasks.
- Use `mail_search` and `mail_query_by_folder` as convenience wrappers when the prompt is simple.
- Use `mail_get_thread_context` before summarizing/replying to preserve conversation continuity.

## Stable Result Shape

Envelope objects in list/search outputs are stable and include:

```json
{
  "uid": 123,
  "subject": "string",
  "from": "comma-separated addresses",
  "to": "comma-separated addresses",
  "date": "ISO-8601 string",
  "messageId": "optional string",
  "snippet": "optional string when includeSnippet=true"
}
```

Pagination support (`cursor`, `returnPage=true`) returns:

```json
{
  "items": [/* envelope objects */],
  "nextCursor": "optional opaque cursor"
}
```

## Testing

From the project directory, with a `.env` (or `IMAP_*` in the environment) and Proton Bridge running:

```bash
npm test
```

`npm test` runs deterministic unit/integration tests (no live mailbox required).

Optional live smoke test (requires Proton Bridge + valid creds):

```bash
node scripts/test-mcp.mjs
```

## Customisation

- **Config**: Edit `src/config.ts` to add env vars or change defaults.
- **Tools**: Edit `src/index.ts` to add MCP tools or change tool names/descriptions; implement handlers in the `CallToolRequestSchema` handler.
- **IMAP behaviour**: All read-only IMAP logic lives in `src/imap.ts` (list folders, list messages, get message, search, advanced search, status, thread context, attachments). Adjust limits, parsing, or add new read-only operations there.
- **Body length**: Set `MAIL_MAX_BODY_LENGTH` to control how much body text is returned to the LLM (avoids huge context).

## Project structure

```
proton-bridge-mcp/
├── src/
│   ├── index.ts    # MCP server, tool definitions and handlers
│   ├── config.ts   # Env-based config
│   ├── imap.ts     # Read-only IMAP (Proton Bridge) client
│   └── query.ts    # Pagination/sort/cursor/snippet helpers
├── tests/
│   ├── query.test.mjs
│   └── imap.integration.test.mjs
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT.

## Pushing to GitHub

1. Create a new repo on GitHub (do not initialise with a README if you already have one).
2. Update `package.json`: set `repository.url`, `homepage`, and `bugs.url` to your repo values if you are publishing under a different owner.
3. Run:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: Proton Bridge read-only MCP server"
   git remote add origin https://github.com/faisal/proton-bridge-mcp.git
   git branch -M main
   git push -u origin main
   ```
4. Ensure `.env` is in `.gitignore` (it is) and never commit credentials.

## Release Checklist

Before pushing a release:

1. Run `npm ci`.
2. Run `npx tsc --noEmit`.
3. Run `npm test`.
4. Run optional live smoke: `node scripts/test-mcp.mjs`.
5. Verify README examples and tool list are up to date.
6. Ensure no secrets are present in tracked files (`.env`, server configs, etc).

## Troubleshooting

### SSL error: `wrong version number` / `ssl3_get_record`

You're connecting with TLS (`IMAP_SECURE=true`) but Proton Bridge's local IMAP uses **plain TCP** (no TLS). Set **`IMAP_SECURE=false`** in your `.env` or MCP server config. Port 1143 is typically plain IMAP for Bridge.

### SSL error: `self-signed certificate` / `DEPTH_ZERO_SELF_SIGNED_CERT`

Proton Bridge may offer TLS with a self-signed cert (direct TLS or STARTTLS). The server accepts it by default. To enforce certificate validation, set **`IMAP_TLS_REJECT_UNAUTHORIZED=true`** in your env.

### IMAP error: `too many login attempts` (NO)

Proton Bridge temporarily blocks logins after repeated failures. Wait a few minutes and try again. Ensure **`IMAP_USER`** is your Proton email (e.g. `you@proton.me`), not a hostname, and **`IMAP_PASS`** is the Bridge password from the Bridge app.

## Security

- **Credentials**: Keep `IMAP_USER` and `IMAP_PASS` in `.env` or your MCP client env; never commit them.
- **Read-only**: This server does not send mail or change mailbox state; only list/fetch/search/status/thread-context/attachment metadata are implemented.
