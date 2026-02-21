#!/usr/bin/env node
/**
 * Test script: runs imap-mail-mcp and calls mail_list_folders.
 * Usage: node scripts/test-mcp.mjs
 * Loads .env from project root; override with IMAP_* in shell if needed.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
}

const SERVER_PATH = join(root, "dist", "index.js");
const env = {
  ...process.env,
  IMAP_HOST: process.env.IMAP_HOST || "127.0.0.1",
  IMAP_PORT: process.env.IMAP_PORT || "1143",
  IMAP_SECURE: process.env.IMAP_SECURE || "false",
  IMAP_USER: process.env.IMAP_USER || "",
  IMAP_PASS: process.env.IMAP_PASS || "",
};

const child = spawn("node", [SERVER_PATH], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let id = 0;

function send(obj) {
  const line = JSON.stringify(obj) + "\n";
  child.stdin.write(line);
}

function nextId() {
  return ++id;
}

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && msg.result !== undefined) {
      if (msg.result.tools) {
        console.log("tools/list result: ", msg.result.tools.length, "tools");
      }
      if (msg.result.content) {
        console.log("tools/call result:", JSON.stringify(msg.result, null, 2));
      }
      if (msg.result.capabilities) {
        console.log("initialize ok, capabilities:", Object.keys(msg.result.capabilities || {}));
      }
    }
    if (msg.error) {
      console.error("MCP error:", msg.error);
    }
  } catch (e) {
    console.error("Parse error:", e.message, "line:", line.slice(0, 80));
  }
});

child.stderr.on("data", (d) => process.stderr.write(d));

child.on("error", (err) => {
  console.error("Spawn error:", err);
  process.exit(1);
});

child.on("exit", (code, sig) => {
  if (code !== 0 && code !== null) process.exit(code || 1);
});

async function run() {
  await new Promise((r) => setTimeout(r, 200));

  send({
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-mcp", version: "1.0.0" },
    },
  });

  await new Promise((r) => setTimeout(r, 500));

  send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });

  await new Promise((r) => setTimeout(r, 200));

  send({
    jsonrpc: "2.0",
    id: nextId(),
    method: "tools/list",
    params: {},
  });

  await new Promise((r) => setTimeout(r, 300));

  send({
    jsonrpc: "2.0",
    id: nextId(),
    method: "tools/call",
    params: { name: "mail_list_folders", arguments: {} },
  });

  setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000);
  }, 8000);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
