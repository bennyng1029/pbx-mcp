/**
 * Observability: target identity in status, Call-ID/From/To/Diversion in channels.
 * Registry and tool handlers run in-process against the mock AMI.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { createRegistry } from "../dist/targets.js";
import { registerAsteriskTools } from "../dist/tools/asterisk.js";
import { startMockAmi } from "./helpers/mock-ami.mjs";

const SECRET = "S3cr3t-Pw-Do-Not-Leak";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbx-mcp-obs-"));
const mocks = [];
after(async () => {
  for (const m of mocks) await m.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CALL_ID = "NObdaGcils@192.168.10.120";
const chan = (i, extra = {}) => ({
  Channel: `PJSIP/mcp-${1000 + i}-0000000${i}`,
  ChannelStateDesc: "Up",
  CallerIDNum: String(1000 + i),
  ConnectedLineNum: "100",
  Context: "mcp-test",
  Exten: "100",
  Duration: "00:00:0" + (i % 10),
  BridgeId: "",
  ...extra,
});
const vars = (c, over = {}) => ({
  [`${c.Channel}|CHANNEL(pjsip,call-id)`]: CALL_ID,
  [`${c.Channel}|PJSIP_HEADER(read,From)`]: "<sip:alice@192.168.10.244>;tag=abc",
  [`${c.Channel}|PJSIP_HEADER(read,To)`]: "<sip:100@192.168.10.244>",
  [`${c.Channel}|PJSIP_HEADER(read,Diversion)`]: "<sip:5551234@example.com>;reason=unconditional",
  ...over,
});

async function setup(opts = {}, entryExtra = {}, toolCfg = {}) {
  const m = await startMockAmi();
  Object.assign(m, opts);
  mocks.push(m);
  const f = path.join(tmp, `t-${mocks.length}.json`);
  fs.writeFileSync(f, JSON.stringify({ targets: { lab: { host: "127.0.0.1", port: m.port, username: "mcp", password: SECRET, label: "Lab box", dialplanHint: "DIDs route in from-trunk", ...entryExtra } } }), { mode: 0o600 });
  const env = { PATH: process.env.PATH, PBX_MCP_TIMEOUT_MS: "3000", PBX_MCP_TARGETS_FILE: f };
  const r = createRegistry(loadConfig(env), env, () => {});
  const handlers = {};
  registerAsteriskTools({ registerTool: (name, _d, fn) => (handlers[name] = fn) }, { allowWrite: false, timeoutMs: 3000, ...toolCfg }, r.getClient, () => r.snapshot());
  return { m, r, h: handlers };
}
const body = (r) => r.content.map((c) => c.text).join("\n");

test("status shows target identity", async () => {
  const { h, m } = await setup();
  const out = body(await h.asterisk_status({}));
  assert.match(out, /^Target: lab \(127\.0\.0\.1:\d+\)\n/);
  assert.match(out, /Label: Lab box/);
  assert.match(out, /Config file: \/etc\/asterisk\/asterisk\.conf/);
  assert.match(out, /PBX UUID: 8d3bd6cc-0000-0000-0000-000000000001/);
  assert.match(out, /Dialplan hint: DIDs route in from-trunk/);
  assert.match(out, /System uptime/);
  assert.ok(m.actions("Command").length >= 4);
});

test("status header has no password", async () => {
  const { h } = await setup();
  const out = body(await h.asterisk_status({}));
  assert.ok(!out.includes(SECRET));
  assert.ok(!/password|secret/i.test(out));
});

test("status still works when identity extras are refused", async () => {
  const { h } = await setup({ settingsError: true });
  const out = body(await h.asterisk_status({}));
  assert.match(out, /^Target: lab/);
  assert.match(out, /System uptime/);
  assert.ok(!/PBX UUID/.test(out));
});

test("channels show Call-ID", async () => {
  const c = chan(1);
  const { h } = await setup({ channels: [c], vars: vars(c) });
  const r = await h.asterisk_channels({});
  const out = body(r);
  assert.equal(r.isError, undefined);
  assert.match(out, /Call-ID\s+From\s+To\s+Diversion/);
  assert.ok(out.includes(CALL_ID));
  assert.ok(out.includes("<sip:alice@192.168.10.244>;tag=abc"));
  assert.ok(out.includes("<sip:5551234@example.com>;reason=unconditional"));
});

test("Getvar failure renders n/a with other columns intact", async () => {
  const c = chan(1);
  const { h } = await setup({ channels: [c], errorFor: { Getvar: "Permission denied" } });
  const r = await h.asterisk_channels({});
  const out = body(r);
  assert.equal(r.isError, undefined);
  assert.match(out, /PJSIP\/mcp-1001-00000001\s+Up\s+1001\s+100\s+mcp-test\s+100/);
  assert.equal((out.match(/n\/a/g) ?? []).length, 4);
  assert.match(out, /1 active channel\(s\)\./);
});

test("an absent header renders n/a while present ones show", async () => {
  const c = chan(1);
  const v = vars(c);
  delete v[`${c.Channel}|PJSIP_HEADER(read,Diversion)`];
  const { h } = await setup({ channels: [c], vars: v });
  const out = body(await h.asterisk_channels({}));
  assert.ok(out.includes(CALL_ID));
  assert.equal((out.match(/n\/a/g) ?? []).length, 1);
});

test("channel filter still works", async () => {
  const a = chan(1);
  const b = chan(2);
  const { h, m } = await setup({ channels: [a, b], vars: { ...vars(a), ...vars(b) } });
  const out = body(await h.asterisk_channels({ filter: "1002" }));
  assert.match(out, /mcp-1002/);
  assert.ok(!/mcp-1001/.test(out));
  assert.equal(m.actions("Getvar").length, 4, "only the matching channel is enriched");
  assert.match(body(await h.asterisk_channels({ filter: "zzz" })), /No active channels match "zzz"/);
});

test("true empty Success renders No active channels", async () => {
  const { h, m } = await setup({ channels: [] });
  assert.equal(body(await h.asterisk_channels({})), "No active channels.");
  assert.equal(m.actions("Getvar").length, 0);
});

test("more than 20 channels adds a truncation note", async () => {
  const cs = Array.from({ length: 25 }, (_, i) => chan(i + 1, { Channel: `PJSIP/mcp-${2000 + i}-${String(i).padStart(8, "0")}` }));
  const all = Object.assign({}, ...cs.map((c) => vars(c)));
  const { h, m } = await setup({ channels: cs, vars: all });
  const out = body(await h.asterisk_channels({}));
  assert.match(out, /25 active channel\(s\)\./);
  assert.match(out, /first 20 channels only/);
  assert.equal(m.actions("Getvar").length, 80);
  assert.equal((out.match(/n\/a/g) ?? []).length, 5 * 4);
});

test("non-PJSIP channels are not queried and render n/a", async () => {
  const c = chan(1, { Channel: "Local/1001@from-internal-00000001;1" });
  const { h, m } = await setup({ channels: [c] });
  const out = body(await h.asterisk_channels({}));
  assert.match(out, /Local\/1001@from-internal/);
  assert.equal(m.actions("Getvar").length, 0);
  assert.equal((out.match(/n\/a/g) ?? []).length, 4);
});

test("enrichment stops at the overall budget", async () => {
  const cs = [chan(1), chan(2), chan(3), chan(4)];
  const all = Object.assign({}, ...cs.map((c) => vars(c)));
  const { h } = await setup({ channels: cs, vars: all, delayMs: 200 }, {}, { timeoutMs: 300 });
  const out = body(await h.asterisk_channels({}));
  assert.match(out, /stopped at the time budget/);
  assert.ok(out.includes(CALL_ID), "lookups that finished in time still show");
  assert.ok(/n\/a/.test(out));
});

test("CF-008: channel cells are capped and sanitized against injection", async () => {
  const c = chan(1);
  const hugeHeader = "A".repeat(300) + "\r\nDROP ALL TABLES\n";
  const { h } = await setup({
    channels: [c],
    vars: {
      [`${c.Channel}|CHANNEL(pjsip,call-id)`]: "call-1",
      [`${c.Channel}|PJSIP_HEADER(read,From)`]: hugeHeader,
      [`${c.Channel}|PJSIP_HEADER(read,To)`]: "<sip:bob@example.com>",
      [`${c.Channel}|PJSIP_HEADER(read,Diversion)`]: "",
    },
  });
  const out = (await h.asterisk_channels({})).content[0].text;
  assert.ok(!out.includes("DROP ALL TABLES\n"), "newlines and injection text sanitized");
  assert.ok(out.includes("A".repeat(120) + "..."), "cell length capped to 128 chars");
});
