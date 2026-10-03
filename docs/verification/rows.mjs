#!/usr/bin/env node
/**
 * Row driver: one fresh server process, a list of tool calls, 30 s hard timeout per call.
 * Usage: node rows.mjs [KEY=VAL ...] -- tool '{"arg":1}' [tool '{...}' ...]
 * Prints the tool list size/presence of write tools and each result (first 300 chars).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const extra = Object.fromEntries(argv.slice(0, sep).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
const calls = [];
for (let i = sep + 1; i < argv.length; i += 2) calls.push([argv[i], JSON.parse(argv[i + 1] ?? "{}")]);
const env = { ...process.env, ...extra };
for (const k of Object.keys(extra)) if (extra[k] === "unset") delete env[k];
const t = new StdioClientTransport({ command: "node", args: [path.join(root, "dist/index.js")], env, stderr: "pipe" });
const c = new Client({ name: "rows", version: "0" });
await c.connect(t);
const names = (await c.listTools()).tools.map((x) => x.name);
console.log("tools:", names.filter((n) => /hangup$|originate|_create|_delete|cli/.test(n)).join(","));
for (const [name, args] of calls) {
  const r = await Promise.race([c.callTool({ name, arguments: args }), new Promise((r) => setTimeout(() => r({ hung: 1 }), 30000))]);
  console.log(`> ${name} ${JSON.stringify(args)}\n  ${r.hung ? "HUNG>30s" : `error=${!!r.isError} ${r.content.map((x) => x.text).join(" | ").slice(0, 300)}`}`);
}
await c.close().catch(() => {});
process.exit(0);
