/**
 * Configuration for the MCP server and IMAP (Proton Bridge).
 * Load from environment; see .env.example.
 */

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  /** When true, reject self-signed TLS certs. Set false for Proton Bridge (local self-signed). */
  tlsRejectUnauthorized: boolean;
  user: string;
  pass: string;
}

export interface MailConfig {
  /** Max length of message body to return (chars). 0 = no limit. */
  maxBodyLength: number;
  /** Global hard cap for list/search tool results. */
  maxResults: number;
  /** Max length of optional snippets returned in list/search outputs. */
  snippetLength: number;
}

function looksLikeIpAddress(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.trim());
}

function env(name: string, defaultValue?: string): string {
  const v = process.env[name] ?? defaultValue;
  if (!v && (name === "IMAP_USER" || name === "IMAP_PASS")) {
    throw new Error(
      `Missing required env: ${name}. ` +
        "Standalone: copy .env.example to .env and set IMAP_USER and IMAP_PASS. " +
        "Via ollmcp/Cursor: add env (IMAP_USER, IMAP_PASS) to the MCP server config."
    );
  }
  return v ?? "";
}

export function loadImapConfig(): ImapConfig {
  const host = env("IMAP_HOST", "127.0.0.1");
  const user = env("IMAP_USER", "");
  const normalizedUser = user.trim().toLowerCase();
  const normalizedHost = host.trim().toLowerCase();
  if (
    normalizedUser === "localhost" ||
    looksLikeIpAddress(normalizedUser) ||
    normalizedUser === normalizedHost ||
    normalizedUser.startsWith("http://") ||
    normalizedUser.startsWith("https://")
  ) {
    throw new Error(
      "Invalid IMAP_USER value. This must be your Proton Bridge username/email " +
        "(e.g. you@proton.me), not IMAP_HOST or an IP/URL."
    );
  }

  return {
    host,
    port: parseInt(env("IMAP_PORT", "1143"), 10) || 1143,
    secure: env("IMAP_SECURE", "false").toLowerCase() === "true",
    tlsRejectUnauthorized: env("IMAP_TLS_REJECT_UNAUTHORIZED", "false").toLowerCase() !== "false",
    user,
    pass: env("IMAP_PASS", ""),
  };
}

export function loadMailConfig(): MailConfig {
  const rawBody = env("MAIL_MAX_BODY_LENGTH", "50000");
  const rawMaxResults = env("MAIL_MAX_RESULTS", "200");
  const rawSnippet = env("MAIL_SNIPPET_LENGTH", "400");
  const body = parseInt(rawBody, 10);
  const maxResults = parseInt(rawMaxResults, 10);
  const snippetLength = parseInt(rawSnippet, 10);
  return {
    maxBodyLength: Number.isNaN(body) || body < 0 ? 50000 : body,
    maxResults: Number.isNaN(maxResults) || maxResults < 1 ? 200 : maxResults,
    snippetLength: Number.isNaN(snippetLength) || snippetLength < 0 ? 400 : snippetLength,
  };
}
