#!/usr/bin/env node
/**
 * Cold-start driver: spawn a fresh pbx-mcp server from dist/, fire the three read
 * tools concurrently and report what came back. Hard 30 s harness timeout per row.
 *
 * Env: ASTERISK_AMI_HOST/PORT/USERNAME/PASSWORD (passed through to the server),
 *      DRIVER_ROWS=N to repeat (default 3). Never prints credentials.
 * Usage: node docs/verification/cold-start.mjs [--env KEY=VAL ...]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extra = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.includes("=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)])
);
const rows = Number(process.env.DRIVER_ROWS ?? 3);
const HARD_MS = 30_000;
const TOOLS = ["asterisk_status", "asterisk_endpoints", "asterisk_channels"];

const withTimeout = (p, label) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r({ hung: true, label }), HARD_MS))]);

for (let i = 1; i <= rows; i++) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(root, "dist/index.js")],
    env: { ...process.env, ...extra },
    stderr: "pipe",
  });
  const client = new Client({ name: "cold-start", version: "0" });
  await client.connect(transport);
  const t0 = Date.now();
  const results = await Promise.all(
    TOOLS.map((name) =>
      withTimeout(
        client.callTool({ name, arguments: {} }).then((r) => ({
          name,
          ms: Date.now() - t0,
          isError: !!r.isError,
          text: r.content.map((c) => c.text).join("\n").slice(0, 160).replace(/\n/g, " | "),
        })),
        name
      )
    )
  );
  console.log(`--- row ${i} (fresh process) ---`);
  for (const r of results) console.log(r.hung ? `${r.label}: HUNG > ${HARD_MS} ms` : `${r.name}: ${r.ms} ms error=${r.isError} :: ${r.text}`);
  await client.close().catch(() => {});
}
