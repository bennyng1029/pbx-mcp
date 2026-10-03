/**
 * Targets: file loader, registry, select/list/get tools, read-only enforcement.
 * Registry-level tests use the build output directly; server-level tests spawn dist/index.js
 * against in-process mock AMIs on loopback.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { loadConfig } from "../dist/config.js";
import { createRegistry, loadTargets, NO_TARGET } from "../dist/targets.js";
import { registerAsteriskTools } from "../dist/tools/asterisk.js";
import { startMockAmi } from "./helpers/mock-ami.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "S3cr3t-Pw-Do-Not-Leak";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbx-mcp-targets-"));
const mocks = [];
const toClose = [];
const mock = async (opts = {}) => {
  const m = await startMockAmi();
  Object.assign(m, opts);
  mocks.push(m);
  return m;
};
after(async () => {
  for (const c of toClose) await c().catch(() => {});
  for (const m of mocks) await m.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function writeTargets(obj, mode = 0o600) {
  const f = path.join(tmp, `targets-${++n}.json`);
  fs.writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj), { mode });
  fs.chmodSync(f, mode);
  return f;
}
const entry = (m, extra = {}) => ({ host: "127.0.0.1", port: m.port, username: "mcp", password: SECRET, ...extra });
const BASE_ENV = { PATH: process.env.PATH, HOME: process.env.HOME };
const reg = (env, warn = () => {}) => {
  const e = { ...BASE_ENV, PBX_MCP_TIMEOUT_MS: "3000", ...env };
  return createRegistry(loadConfig(e), e, warn);
};
const text = (r) => r.content.map((c) => c.text).join("\n");

async function spawn(env) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(root, "dist/index.js")],
    env: { ...BASE_ENV, PBX_MCP_TIMEOUT_MS: "3000", ...env },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => stderr.push(String(d)));
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  toClose.push(() => client.close());
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const tools = async () => (await client.listTools()).tools.map((t) => t.name);
  return { client, call, tools, stderr: () => stderr.join("") };
}
/** Run the server expecting it to exit at start-up; return its stderr. */
async function startupFailure(env) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("node", [path.join(root, "dist/index.js")], { env: { ...BASE_ENV, ...env }, encoding: "utf8", timeout: 10000 });
  return { status: r.status, stderr: r.stderr };
}
const writes = (m) => m.actions().filter((a) => a.Action !== "Command" || !/^(core|pjsip) show/.test(a.Command));

// --- file loader ---

test("valid file loads", () => {
  const f = writeTargets({ targets: { a: entry({ port: 5038 }, { label: "Lab A", dialplanHint: "see DID table" }), b: { ...entry({ port: 5038 }), password: undefined, passwordEnv: "B_PW" } } });
  const t = loadTargets(loadConfig({ PBX_MCP_TARGETS_FILE: f }), { B_PW: "bpw" }, () => {});
  assert.deepEqual(t.map((x) => x.name), ["a", "b"]);
  assert.equal(t[0].label, "Lab A");
  assert.equal(t[1].password, "bpw");
  assert.equal(t[0].provision, false);
  assert.deepEqual(t[0].trunkAllow, []);
});

test("unknown key rejected", () => {
  const f = writeTargets({ targets: { a: { host: "h", username: "u", password: "p", bogus: 1 } } });
  assert.throws(() => loadTargets(loadConfig({ PBX_MCP_TARGETS_FILE: f }), {}, () => {}), /bogus|Unrecognized/);
  const g = writeTargets({ targets: {}, default: {} });
  assert.throws(() => loadTargets(loadConfig({ PBX_MCP_TARGETS_FILE: g }), {}, () => {}), /Unrecognized/);
});

test("file target named default rejected", () => {
  const f = writeTargets({ targets: { default: { host: "h", username: "u", password: "p" } } });
  assert.throws(() => loadTargets(loadConfig({ PBX_MCP_TARGETS_FILE: f }), {}, () => {}), /may not be named "default"/);
});

test("env credentials plus file gives default plus file targets and needs selection", async () => {
  const m = await mock();
  const f = writeTargets({ targets: { a: entry(m) } });
  const r = reg({ ASTERISK_AMI_HOST: "127.0.0.1", ASTERISK_AMI_PORT: String(m.port), ASTERISK_AMI_USERNAME: "mcp", ASTERISK_AMI_PASSWORD: "x", PBX_MCP_TARGETS_FILE: f });
  assert.deepEqual(r.list().map((t) => t.name), ["default", "a"]);
  assert.throws(() => r.snapshot(), new RegExp(NO_TARGET));
});

test("missing passwordEnv variable rejected naming the variable only", () => {
  const f = writeTargets({ targets: { a: { host: "h", username: "u", passwordEnv: "LAB_A_PW" } } });
  assert.throws(
    () => loadTargets(loadConfig({ PBX_MCP_TARGETS_FILE: f }), { OTHER_SECRET: SECRET }, () => {}),
    (e) => /LAB_A_PW/.test(e.message) && !e.message.includes(SECRET)
  );
});

test("bad pjsipFile fails start-up", async () => {
  const f = writeTargets({ targets: { a: { host: "127.0.0.1", username: "u", password: "p", provision: true, pjsipFile: "pjsip.conf" } } });
  const r = await startupFailure({ PBX_MCP_TARGETS_FILE: f });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pjsip\.conf/);
});

test("literal password in 0644 file warns, 0600 does not", () => {
  const body = { targets: { a: { host: "h", username: "u", password: SECRET } } };
  const warns = [];
  loadTargets(loadConfig({ PBX_MCP_TARGETS_FILE: writeTargets(body, 0o644) }), {}, (m) => warns.push(m));
  assert.equal(warns.length, 1);
  assert.ok(!warns[0].includes(SECRET));
  const quiet = [];
  loadTargets(loadConfig({ PBX_MCP_TARGETS_FILE: writeTargets(body, 0o600) }), {}, (m) => quiet.push(m));
  assert.equal(quiet.length, 0);
});

test("start-up and tool errors never echo a password", async () => {
  for (const body of [`{"targets": {"a": {"host": "h", "username": "u", "password": "${SECRET}" ,}}}`, { targets: { a: { host: "h", username: "u", password: SECRET, bogus: true } } }]) {
    const r = await startupFailure({ PBX_MCP_TARGETS_FILE: writeTargets(body), ASTERISK_AMI_PASSWORD: SECRET });
    assert.equal(r.status, 1);
    assert.ok(!r.stderr.includes(SECRET), r.stderr);
  }
  const m = await mock();
  const s = await spawn({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m), b: entry(m) } }) });
  for (const [tool, args] of [["pbx_select_target", { name: "nope" }], ["asterisk_status", {}], ["pbx_select_target", { host: "10.9.9.9" }]]) {
    const out = text(await s.call(tool, args));
    assert.ok(!out.includes(SECRET), out);
  }
  assert.ok(!s.stderr().includes(SECRET));
});

// --- registry ---

test("env-only gives implicit default", async () => {
  const m = await mock();
  const r = reg({ ASTERISK_AMI_HOST: "127.0.0.1", ASTERISK_AMI_PORT: String(m.port), ASTERISK_AMI_USERNAME: "mcp", ASTERISK_AMI_PASSWORD: "x" });
  assert.equal(r.identity().name, "default");
});

test("single target auto-selects, two require selection", async () => {
  const m = await mock();
  const one = reg({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m) } }) });
  assert.equal(one.identity().name, "a");
  const two = reg({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m), b: entry(m) } }) });
  assert.throws(() => two.identity(), new RegExp(NO_TARGET));
  two.select({ name: "b" });
  assert.equal(two.identity().name, "b");
});

test("no_target_selected before selection", async () => {
  const m = await mock();
  const r = reg({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m), b: entry(m) } }) });
  await assert.rejects(r.getClient(), new RegExp(NO_TARGET));
  const s = await spawn({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m), b: entry(m) } }) });
  assert.match(text(await s.call("pbx_get_target")), new RegExp(NO_TARGET));
  const st = await s.call("asterisk_status");
  assert.equal(st.isError, true);
  assert.match(text(st), new RegExp(NO_TARGET));
  assert.equal(m.actions().length, 0);
});

test("provisioning tool with no selected target returns no_target_selected", async () => {
  const m = await mock();
  const s = await spawn({ PBX_MCP_ALLOW_PROVISION: "true", PBX_MCP_TRUNK_ALLOW: "192.0.2.0/24", PBX_MCP_CONTEXT_ALLOW: "mcp-test", PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m), b: entry(m) } }) });
  const r = await s.call("asterisk_trunk_create", { name: "t1", host: "192.0.2.10", context: "mcp-test" });
  assert.equal(r.isError, true);
  assert.match(text(r), new RegExp(NO_TARGET));
  assert.equal(m.actions().length, 0);
});

test("registry snapshot and identity expose the documented fields", async () => {
  const m = await mock();
  const r = reg({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m, { label: "A", dialplanHint: "h", readOnly: true }) } }) });
  const id = r.identity();
  assert.deepEqual(Object.keys(id).sort(), ["dialplanHint", "host", "label", "name", "port", "readOnly"]);
  assert.deepEqual(id, { name: "a", label: "A", host: "127.0.0.1", port: m.port, dialplanHint: "h", readOnly: true });
  const snap = r.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ["dialplanHint", "fixtureExpectation", "getClient", "getObserver", "host", "label", "name", "port", "readOnly"]);
  assert.equal(typeof snap.getClient, "function");
});

// --- ad hoc ---

const ADHOC = (m, extra = {}) => ({ ASTERISK_AMI_USERNAME: "mcp", ASTERISK_AMI_PASSWORD: "x", PBX_MCP_HOST_ALLOW: "127.0.0.0/8", PBX_MCP_ADHOC_PORTS: String(m.port), ...extra });

test("ad hoc IP in CIDR accepted", async () => {
  const m = await mock();
  const r = reg(ADHOC(m));
  const id = r.select({ host: "127.0.0.1", port: m.port });
  assert.equal(id.readOnly, true);
  assert.equal(id.host, "127.0.0.1");
  assert.match(text(await callTool(r, "asterisk_status")), /System uptime/);
});
/** Run one registered Asterisk tool handler against a registry. */
function tool(r, cfgOver = {}) {
  const handlers = {};
  registerAsteriskTools({ registerTool: (name, _d, fn) => (handlers[name] = fn) }, { allowWrite: false, timeoutMs: 3000, ...cfgOver }, r.getClient, () => r.snapshot());
  return handlers;
}
const callTool = (r, name, args = {}, cfgOver) => tool(r, cfgOver)[name](args);

test("ad hoc IP outside CIDR refused", async () => {
  const m = await mock();
  assert.throws(() => reg(ADHOC(m)).select({ host: "10.1.2.3", port: m.port }), /not inside PBX_MCP_HOST_ALLOW/);
});

test("ad hoc hostname refused", async () => {
  const m = await mock();
  assert.throws(() => reg(ADHOC(m)).select({ host: "localhost", port: m.port }), /IP literal/);
});

test("ad hoc IPv6 zone id refused", async () => {
  const m = await mock();
  assert.throws(() => reg(ADHOC(m, { PBX_MCP_HOST_ALLOW: "fe80::/10" })).select({ host: "fe80::1%eth0", port: m.port }), /IP literal/);
});

test("ad hoc IPv4-mapped IPv6 is normalized before the CIDR check", async () => {
  const m = await mock();
  const r = reg(ADHOC(m));
  assert.equal(r.select({ host: "::ffff:127.0.0.1", port: m.port }).host, "127.0.0.1");
  assert.equal(r.select({ host: "::ffff:7f00:1", port: m.port }).host, "127.0.0.1");
  assert.throws(() => r.select({ host: "::ffff:10.1.2.3", port: m.port }), /not inside/);
});

test("ad hoc port outside PBX_MCP_ADHOC_PORTS refused", async () => {
  const m = await mock();
  assert.throws(() => reg(ADHOC(m)).select({ host: "127.0.0.1", port: m.port + 1 }), /PBX_MCP_ADHOC_PORTS/);
  assert.throws(() => reg(ADHOC(m)).select({ host: "127.0.0.1" }), /PBX_MCP_ADHOC_PORTS/); // default 5038 is not on this list
});

test("empty allowlist refuses ad hoc", async () => {
  const m = await mock();
  assert.throws(() => reg(ADHOC(m, { PBX_MCP_HOST_ALLOW: "" })).select({ host: "127.0.0.1", port: m.port }), /disabled/);
});

test("ad hoc without default credentials refused", async () => {
  const m = await mock();
  assert.throws(() => reg(ADHOC(m, { ASTERISK_AMI_USERNAME: "", ASTERISK_AMI_PASSWORD: "" })).select({ host: "127.0.0.1", port: m.port }), /default credentials/);
});

test("select with both name and host is rejected", async () => {
  const m = await mock();
  const s = await spawn({ ...ADHOC(m), PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m) } }) });
  const r = await s.call("pbx_select_target", { name: "a", host: "127.0.0.1" });
  assert.equal(r.isError, true);
  assert.match(text(r), /either name or host/);
});

test("tools register and return no_target_selected when only PBX_MCP_HOST_ALLOW is set", async () => {
  const m = await mock();
  const s = await spawn({ PBX_MCP_HOST_ALLOW: "127.0.0.0/8" });
  const names = await s.tools();
  for (const t of ["asterisk_status", "asterisk_channels", "pbx_select_target", "pbx_list_targets"]) assert.ok(names.includes(t), t);
  const r = await s.call("asterisk_status");
  assert.equal(r.isError, true);
  assert.match(text(r), new RegExp(NO_TARGET));
  assert.equal(m.actions().length, 0);
});

// --- read-only enforcement ---

async function adhocServer(m, extra = {}) {
  const s = await spawn({ ...ADHOC(m), PBX_MCP_ALLOW_WRITE: "true", ...extra });
  const sel = await s.call("pbx_select_target", { host: "127.0.0.1", port: m.port });
  assert.match(text(sel), /Selected: ad hoc 127\.0\.0\.1/);
  return s;
}

test("write tool with no selected target sends zero AMI actions", async () => {
  const m = await mock();
  const s = await spawn({ ...ADHOC(m), PBX_MCP_ALLOW_WRITE: "true", PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m), b: entry(m) } }) });
  for (const [tool, args] of [["asterisk_originate", { channel: "PJSIP/x", extension: "100", context: "mcp-test" }], ["asterisk_hangup", { channel: "PJSIP/x" }], ["asterisk_cli", { command: "core restart now" }]]) {
    const r = await s.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(text(r), new RegExp(NO_TARGET), tool);
  }
  assert.equal(m.actions().length, 0);
});

test("ad hoc target refuses originate", async () => {
  const m = await mock();
  const s = await adhocServer(m);
  const r = await s.call("asterisk_originate", { channel: "PJSIP/x", extension: "100", context: "mcp-test" });
  assert.equal(r.isError, true);
  assert.match(text(r), /read-only/);
  assert.equal(m.actions("Originate").length, 0);
});

test("ad hoc target refuses hangup", async () => {
  const m = await mock();
  const s = await adhocServer(m);
  const r = await s.call("asterisk_hangup", { channel: "PJSIP/x" });
  assert.equal(r.isError, true);
  assert.equal(m.actions("Hangup").length, 0);
});

test("ad hoc target refuses write CLI", async () => {
  const m = await mock();
  const s = await adhocServer(m);
  const w = await s.call("asterisk_cli", { command: "module reload res_pjsip.so" });
  assert.equal(w.isError, true);
  assert.match(text(w), /read-only/);
  assert.equal(m.actions("Command").length, 0);
  const ok = await s.call("asterisk_cli", { command: "core show uptime" }); // reads still work
  assert.match(text(ok), /System uptime/);
});

test("named readOnly target refuses writes", async () => {
  const m = await mock();
  const s = await spawn({ PBX_MCP_ALLOW_WRITE: "true", PBX_MCP_TARGETS_FILE: writeTargets({ targets: { ro: entry(m, { readOnly: true }) } }) });
  for (const [tool, args] of [["asterisk_originate", { channel: "PJSIP/x", extension: "100", context: "mcp-test" }], ["asterisk_hangup", { channel: "PJSIP/x" }], ["asterisk_cli", { command: "module reload res_pjsip.so" }]]) {
    const r = await s.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(text(r), /read-only/, tool);
  }
  assert.equal(m.actions().length, 0);
});

test("selection switched in the same tick as originate still writes nothing to the ad hoc target", async () => {
  const adhoc = await mock();
  const named = await mock();
  const r = reg({ ...ADHOC(adhoc), PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(named), b: entry(named) } }) });
  r.select({ host: "127.0.0.1", port: adhoc.port });
  const p = tool(r, { allowWrite: true }).asterisk_originate({ channel: "PJSIP/x", extension: "100", context: "mcp-test", timeoutSeconds: 5 });
  r.select({ name: "a" }); // same tick, before the originate handler resumes
  const out = await p;
  assert.equal(out.isError, true);
  assert.match(text(out), /read-only/);
  assert.equal(adhoc.actions().length, 0);
  assert.equal(named.actions("Originate").length, 0);
});

test("later select is never overwritten by an earlier one", async () => {
  const m = await mock();
  const r = reg({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m), b: entry(m) } }) });
  r.select({ name: "a" });
  r.select({ name: "b" });
  assert.equal(r.identity().name, "b");
  const snapA = r.snapshot();
  r.select({ name: "a" });
  assert.equal(snapA.name, "b", "an earlier snapshot stays bound to its own target");
});

// --- ad hoc lifecycle ---

test("snapshot of an evicted ad hoc target cannot reopen a connection", async () => {
  const m1 = await mock();
  const m2 = await mock();
  const r = reg({ ...ADHOC(m1), PBX_MCP_ADHOC_PORTS: `${m1.port},${m2.port}` });
  r.select({ host: "127.0.0.1", port: m1.port });
  const snap = r.snapshot();
  await snap.getClient();
  assert.equal(m1.connections, 1);
  r.select({ host: "127.0.0.1", port: m2.port });
  await assert.rejects(snap.getClient(), /no longer selected/);
  assert.equal(m1.connections, 1);
});

test("second ad hoc select closes the first ad hoc client", async () => {
  const m1 = await mock();
  const m2 = await mock();
  const r = reg({ ...ADHOC(m1), PBX_MCP_ADHOC_PORTS: `${m1.port},${m2.port}` });
  r.select({ host: "127.0.0.1", port: m1.port });
  await r.getClient();
  assert.equal(m1.sockets.size, 1);
  r.select({ host: "127.0.0.1", port: m2.port });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(m1.sockets.size, 0);
});

// --- tools and secrets ---

test("gates and credentials cannot be set via tool args", async () => {
  const m = await mock();
  const s = await spawn({ ...ADHOC(m), PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m), b: entry(m) } }) });
  for (const args of [{ name: "a", trunkAllow: ["0.0.0.0/0"] }, { name: "a", provision: true }, { host: "127.0.0.1", port: m.port, password: "x" }, { host: "127.0.0.1", port: m.port, username: "root" }, { name: "a", readOnly: false }]) {
    const r = await s.call("pbx_select_target", args).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.match(text(await s.call("pbx_get_target")), new RegExp(NO_TARGET));
});

test("pbx_get_target and pbx_list_targets output contains no secret", async () => {
  const m = await mock();
  const s = await spawn({ ASTERISK_AMI_USERNAME: "mcp", ASTERISK_AMI_PASSWORD: SECRET, PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m, { label: "Lab A" }), b: entry(m) } }) });
  await s.call("pbx_select_target", { name: "a" });
  const out = text(await s.call("pbx_list_targets")) + text(await s.call("pbx_get_target"));
  assert.ok(!out.includes(SECRET));
  assert.ok(!out.includes('"mcp"'));
  assert.match(out, /Lab A/);
  assert.match(out, /a \(127\.0\.0\.1:/);
});

test("status header and data come from the same target", async () => {
  const a = await mock();
  const b = await mock();
  const r = reg({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(a), b: entry(b) } }) });
  r.select({ name: "a" });
  const outA = text(await callTool(r, "asterisk_status"));
  assert.match(outA, /^Target: a \(127\.0\.0\.1:/);
  assert.ok(a.actions("Command").length > 0);
  assert.equal(b.actions().length, 0);
  r.select({ name: "b" });
  const outB = text(await callTool(r, "asterisk_status"));
  assert.match(outB, /^Target: b \(/);
  assert.ok(b.actions("Command").length > 0);
});

test("a start-up with only ASTERISK_AMI_HOST set still registers the previous tools", async () => {
  const m = await mock();
  const s = await spawn({ ASTERISK_AMI_HOST: "127.0.0.1", ASTERISK_AMI_PORT: String(m.port), ASTERISK_AMI_USERNAME: "mcp", ASTERISK_AMI_PASSWORD: "x" });
  const names = await s.tools();
  for (const t of ["asterisk_status", "asterisk_endpoints", "asterisk_channels", "asterisk_dialplan", "asterisk_cli", "asterisk_hangup_preview"]) assert.ok(names.includes(t), t);
  assert.ok(!names.some((t) => t.startsWith("pbx_")));
  assert.match(text(await s.call("asterisk_status")), /System uptime/);
});

// --- per-target provisioning gates and binding (Task 3) ---

import { registerProvisioningTools } from "../dist/tools/provision.js";

const PROV = { provision: true, readOnly: false, trunkAllow: ["192.0.2.0/24"], contextAllow: ["mcp-test"] };
const trunk = (o = {}) => ({ name: "t1", host: "192.0.2.10", context: "mcp-test", ...o });
const ext = (o = {}) => ({ number: "1001", context: "mcp-test", ...o });
const provServer = (extra = {}) => spawn({ PBX_MCP_ALLOW_PROVISION: "true", ...extra });
const sections = (m) => m.categories.map((c) => c.name);
const updates = (m) => m.actions("UpdateConfig");

/** Provisioning tool handlers on a fake server, bound to a registry. */
function provTools(r, cfg = { pjsipFile: "pjsip_mcp.conf", trunkAllow: [], contextAllow: [] }) {
  const handlers = {};
  registerProvisioningTools({ registerTool: (name, _d, fn) => (handlers[name] = fn) }, cfg, r?.getClient, r);
  return handlers;
}

test("same trunk allowed on A, refused on B", async () => {
  const a = await mock();
  const b = await mock();
  const s = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(a, PROV), b: entry(b, { ...PROV, trunkAllow: ["198.51.100.0/24"] }) } }) });
  await s.call("pbx_select_target", { name: "a" });
  const ok = await s.call("asterisk_trunk_create", { ...trunk(), target: "a" });
  assert.match(text(ok), /Created and verified trunk mcp-t1/);
  assert.ok(sections(a).includes("mcp-t1"));
  await s.call("pbx_select_target", { name: "b" });
  const no = await s.call("asterisk_trunk_create", { ...trunk(), target: "b" });
  assert.equal(no.isError, true);
  assert.match(text(no), /not on the PBX_MCP_TRUNK_ALLOW list/);
  assert.equal(updates(b).length, 0);
});

test("file target without gates refuses provisioning", async () => {
  const m = await mock();
  const s = await provServer({ PBX_MCP_TRUNK_ALLOW: "192.0.2.0/24", PBX_MCP_CONTEXT_ALLOW: "mcp-test", PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m) } }) });
  const r = await s.call("asterisk_trunk_create", trunk());
  assert.equal(r.isError, true);
  assert.match(text(r), /Provisioning is not enabled for target "a"/);
  assert.equal(m.actions().length, 0, "global allowlists do not apply to file targets");
});

test("readOnly named target refuses provisioning writes", async () => {
  const m = await mock();
  const s = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { ro: entry(m, { ...PROV, readOnly: true }) } }) });
  const r = await s.call("asterisk_extension_create", ext());
  assert.equal(r.isError, true);
  assert.match(text(r), /not enabled/);
  assert.equal(m.actions().length, 0);
});

test("each of the four mutators refuses on a readOnly named target", async () => {
  const m = await mock();
  const s = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { ro: entry(m, { ...PROV, readOnly: true }) } }) });
  for (const [tool, args] of [["asterisk_trunk_create", trunk()], ["asterisk_trunk_delete", { name: "t1" }], ["asterisk_extension_create", ext()], ["asterisk_extension_delete", { number: "1001" }]]) {
    const r = await s.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(text(r), /not enabled/, tool);
  }
  assert.equal(m.actions().length, 0);
});

test("ad hoc target cannot provision and sends no AMI write", async () => {
  const m = await mock();
  const s = await provServer({ ...ADHOC(m), PBX_MCP_TRUNK_ALLOW: "192.0.2.0/24", PBX_MCP_CONTEXT_ALLOW: "mcp-test" });
  await s.call("pbx_select_target", { host: "127.0.0.1", port: m.port });
  for (const [tool, args] of [["asterisk_trunk_create", trunk()], ["asterisk_extension_create", ext()], ["asterisk_trunk_delete", { name: "t1" }], ["asterisk_extension_delete", { number: "1001" }]]) {
    const r = await s.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(text(r), /not enabled/, tool);
  }
  assert.equal(m.actions().length, 0);
});

test("result names the target", async () => {
  const m = await mock();
  const s = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m, PROV) } }) });
  const ok = await s.call("asterisk_extension_create", ext());
  assert.ok(text(ok).startsWith(`Target: a (127.0.0.1:${m.port})\n`), text(ok).slice(0, 80));
  const bad = await s.call("asterisk_extension_create", ext({ context: "other" }));
  assert.ok(text(bad).startsWith(`Target: a (`));
  assert.ok(text(await s.call("asterisk_trunk_list")).startsWith("Target: a ("));
});

test("per-target pjsipFile is the file actually written", async () => {
  const a = await mock();
  const b = await mock();
  const s = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(a, { ...PROV, pjsipFile: "a_lab.conf" }), b: entry(b, { ...PROV, pjsipFile: "b_lab.conf" }) } }) });
  await s.call("pbx_select_target", { name: "b" });
  const r = await s.call("asterisk_trunk_create", { ...trunk(), target: "b" });
  assert.match(text(r), /Created and verified/);
  assert.ok(updates(b).length > 0);
  for (const u of updates(b)) assert.equal(u.DstFilename, "b_lab.conf");
  assert.equal(updates(a).length, 0);
});

test("mismatched target argument is refused with zero writes", async () => {
  const a = await mock();
  const b = await mock();
  const s = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(a, PROV), b: entry(b, PROV) } }) });
  await s.call("pbx_select_target", { name: "a" });
  const r = await s.call("asterisk_trunk_create", { ...trunk(), target: "b" });
  assert.equal(r.isError, true);
  assert.match(text(r), /not the selected target "a"/);
  assert.equal(a.actions().length + b.actions().length, 0);
});

test("target required when more than one target exists", async () => {
  const a = await mock();
  const b = await mock();
  const s = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(a, PROV), b: entry(b, PROV) } }) });
  await s.call("pbx_select_target", { name: "a" });
  const r = await s.call("asterisk_extension_delete", { number: "1001" });
  assert.equal(r.isError, true);
  assert.match(text(r), /target is required/);
  assert.equal(a.actions().length, 0);
  // with a single target it is optional
  const one = await mock();
  const s1 = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { only: entry(one, PROV) } }) });
  assert.match(text(await s1.call("asterisk_extension_create", ext())), /Created and verified/);
});

test("selection switched while a write is queued still writes to the entry-time target", async () => {
  const a = await mock({ delayMs: 80 });
  const b = await mock();
  const r = reg({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(a, PROV), b: entry(b, PROV) } }) });
  r.select({ name: "a" });
  const p = provTools(r).asterisk_extension_create({ ...ext(), target: "a" });
  r.select({ name: "b" });
  assert.match(text(await p), /Created and verified extension/);
  assert.ok(sections(a).includes("mcp-1001"));
  assert.equal(b.actions().length, 0);
});

test("concurrent creates on the same target are serialized", async () => {
  const a = await mock({ delayMs: 30 });
  const r = reg({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(a, PROV) } }) });
  assert.equal(r.provisionerFor("a"), r.provisionerFor("a"));
  const h = provTools(r);
  const outs = await Promise.all(["1001", "1002", "1003"].map((number) => h.asterisk_extension_create(ext({ number }))));
  for (const o of outs) assert.match(text(o), /Created and verified/);
  for (const n of ["mcp-1001", "mcp-1002", "mcp-1003"]) assert.ok(sections(a).includes(n), n);
});

test("gates cannot be widened via tool args", async () => {
  const m = await mock();
  const s = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m, PROV) } }) });
  for (const extra of [{ trunkAllow: ["0.0.0.0/0"] }, { contextAllow: ["other"] }, { pjsipFile: "pjsip.conf" }, { provision: true }]) {
    const r = await s.call("asterisk_trunk_create", trunk({ host: "203.0.113.9", ...extra })).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
    assert.equal(r.isError, true, JSON.stringify(extra));
  }
  assert.equal(m.actions().length, 0);
  // and the same host without the extras is refused by the operator allowlist
  const plain = await s.call("asterisk_trunk_create", trunk({ host: "203.0.113.9" }));
  assert.match(text(plain), /not on the PBX_MCP_TRUNK_ALLOW list/);
});

test("list tools stay available on a provisioning-enabled target", async () => {
  const m = await mock();
  const s = await provServer({ PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m, PROV), b: entry(m, PROV) } }) });
  await s.call("pbx_select_target", { name: "a" });
  assert.match(text(await s.call("asterisk_trunk_list")), /No managed trunks/);
  assert.match(text(await s.call("asterisk_extension_list")), /No managed extensions/);
});

test("legacy 3-argument path uses the implicit target's global gates", async () => {
  const m = await mock();
  const r = reg({ ASTERISK_AMI_HOST: "127.0.0.1", ASTERISK_AMI_PORT: String(m.port), ASTERISK_AMI_USERNAME: "mcp", ASTERISK_AMI_PASSWORD: "x" });
  const cfg = { pjsipFile: "pjsip_mcp.conf", trunkAllow: ["192.0.2.0/24"], contextAllow: ["mcp-test"] };
  // legacy form: no registry, positional client
  const handlers = {};
  registerProvisioningTools({ registerTool: (name, _d, fn) => (handlers[name] = fn) }, cfg, r.getClient);
  const ok = await handlers.asterisk_trunk_create(trunk());
  assert.match(text(ok), /Created and verified trunk/);
  assert.ok(!text(ok).startsWith("Target:"));
  const no = await handlers.asterisk_trunk_create(trunk({ name: "t2", host: "203.0.113.9" }));
  assert.equal(no.isError, true);
  assert.match(text(no), /TRUNK_ALLOW/);
});

test("an evicted ad hoc target cannot be reopened by a call already in flight", async () => {
  const m1 = await mock();
  const m2 = await mock();
  const r = reg({ ...ADHOC(m1), PBX_MCP_ADHOC_PORTS: `${m1.port},${m2.port}` });
  r.select({ host: "127.0.0.1", port: m1.port });
  const snap = r.snapshot();
  const inFlight = snap.getClient(); // passes the first eviction check, then awaits the holder
  r.select({ host: "127.0.0.1", port: m2.port }); // evicts it before the holder resumes
  await assert.rejects(inFlight, /no longer selected/);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(m1.sockets.size, 0, "no connection to the evicted target stays open");
});

test("a CIDR with extra slashes is rejected", async () => {
  const m = await mock();
  assert.throws(() => reg(ADHOC(m, { PBX_MCP_HOST_ALLOW: "127.0.0.0/8/junk" })), /not a valid CIDR/);
});

test("CF-003: file targets default to readOnly true", () => {
  const f = writeTargets({ targets: { ro: entry({ port: 5038 }) } });
  const r = reg({ PBX_MCP_TARGETS_FILE: f });
  assert.equal(r.list().find((t) => t.name === "ro").readOnly, true);
});

test("CF-003: group-writable targets file emits a warning", () => {
  const warns = [];
  const f = writeTargets({ targets: { a: entry({ port: 5038 }) } }, 0o664);
  reg({ PBX_MCP_TARGETS_FILE: f }, (w) => warns.push(w));
  assert.ok(warns.some((w) => w.includes("writable by group/other")));
});

test("CF-002: write tools refuse mismatched target argument", async () => {
  const a = await mock();
  const b = await mock();
  const s = await spawn({
    PBX_MCP_ALLOW_WRITE: "true",
    PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(a, { readOnly: false }), b: entry(b, { readOnly: false }) } }),
  });
  await s.call("pbx_select_target", { name: "a" });
  for (const [tool, args] of [
    ["asterisk_originate", { channel: "PJSIP/x", extension: "100", context: "default", target: "b" }],
    ["asterisk_hangup", { channel: "PJSIP/x", target: "b" }],
    ["asterisk_cli", { command: "core restart now", target: "b" }],
  ]) {
    const r = await s.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(text(r), /not the selected target "a"/, tool);
  }
  assert.equal(a.actions().length + b.actions().length, 0);
});

test("CF-002: write tools reject unknown arguments (strict schema)", async () => {
  const m = await mock();
  const s = await spawn({
    PBX_MCP_ALLOW_WRITE: "true",
    PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m, { readOnly: false }) } }),
  });
  for (const [tool, args] of [
    ["asterisk_originate", { channel: "PJSIP/x", extension: "100", context: "default", extra: "junk" }],
    ["asterisk_hangup", { channel: "PJSIP/x", extra: "junk" }],
    ["asterisk_cli", { command: "core restart now", extra: "junk" }],
  ]) {
    const r = await s.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(text(r), /unrecognized|unexpected/i, tool);
  }
});

test("CF-007: originate and hangup return isError true when AMI returns Error", async () => {
  const m = await mock({
    errorFor: { Originate: "Permission denied", Hangup: "Permission denied" },
  });
  const s = await spawn({
    PBX_MCP_ALLOW_WRITE: "true",
    PBX_MCP_TARGETS_FILE: writeTargets({ targets: { a: entry(m, { readOnly: false }) } }),
  });
  const o = await s.call("asterisk_originate", { channel: "PJSIP/x", extension: "100", context: "default" });
  assert.equal(o.isError, true);
  assert.match(text(o), /Error: Permission denied/);

  const h = await s.call("asterisk_hangup", { channel: "PJSIP/x" });
  assert.equal(h.isError, true);
  assert.match(text(h), /Error: Permission denied/);
});

test("named snapshots own shared observers, isolated histories and immutable expectations", async () => {
  const a=await mock({channels:[]}); const b=await mock({channels:[]});
  const expectations = writeTargets({targets:{a:{noActiveChannels:true}}});
  const r=reg({PBX_MCP_TARGETS_FILE:writeTargets({targets:{a:entry(a),b:entry(b)}}),PBX_MCP_FIXTURE_EXPECTATIONS_FILE:expectations});
  toClose.push(async()=>r.close()); r.select({name:"a"}); const snapshot=r.snapshot();
  const observer=snapshot.getObserver(); assert.equal(snapshot.getObserver(),observer);
  assert.equal(Object.isFrozen(snapshot.fixtureExpectation),true);
  assert.equal(JSON.stringify(snapshot).includes(SECRET),false);
  const ready=Promise.all([observer.ensureReady(),snapshot.getObserver().ensureReady()]);
  r.select({name:"b"}); const second=r.snapshot().getObserver(); await ready; await second.ensureReady();
  assert.equal(a.connections,1); assert.equal(b.connections,1); assert.notEqual(second,observer);
  a.emitEvent({Event:"Newchannel",Uniqueid:"a1",Channel:"PJSIP/a-1"});
  a.emitEvent({Event:"Hangup",Uniqueid:"a1",Channel:"PJSIP/a-1"});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await observer.recentCalls({limit:10},performance.now()+1000)).records.length,1);
  assert.equal((await second.recentCalls({limit:10},performance.now()+1000)).records.length,0);
});
const ENV = m => ({ASTERISK_AMI_HOST:"127.0.0.1",ASTERISK_AMI_PORT:String(m.port),ASTERISK_AMI_USERNAME:"mcp",ASTERISK_AMI_PASSWORD:"x"});

test("default supports observation, ad hoc refuses without opening a socket, permanent close blocks snapshots", async () => {
  const m=await mock();
  const r=reg({...ENV(m),PBX_MCP_HOST_ALLOW:"127.0.0.0/8",PBX_MCP_ADHOC_PORTS:String(m.port)});
  toClose.push(async()=>r.close());
  const named=r.snapshot(); await named.getObserver().ensureReady(); const ordinary=await named.getClient();
  r.select({host:"127.0.0.1",port:m.port}); const adhoc=r.snapshot();
  const count=m.connections; assert.throws(()=>adhoc.getObserver(),/named_target_required/); assert.equal(m.connections,count);
  r.close(); r.close(); assert.equal(ordinary.isConnected,false);
  assert.throws(()=>named.getObserver(),/registry closed/); await assert.rejects(named.getClient(),/registry closed/);
  assert.throws(()=>r.snapshot(),/registry closed/); assert.throws(()=>r.select({name:"default"}),/registry closed/);
});
test("registry close cancels login and prevents a late connection publishing", async () => {
  const m=await mock({loginDelayMs:200}); const r=reg(ENV(m)); const snapshot=r.snapshot();
  const pending=assert.rejects(snapshot.getClient(),/registry closed/); r.close(); await pending;
  await new Promise(resolve=>setTimeout(resolve,250)); assert.equal(m.sockets.size,0);
  await assert.rejects(snapshot.getClient(),/registry closed/); assert.ok(m.connections<=1);
});

test("observer failed reconnect retains terminal records and registry close cancels readiness", async () => {
  const m=await mock(); const r=reg({...ENV(m),PBX_MCP_TIMEOUT_MS:"250"}); const observer=r.snapshot().getObserver();
  toClose.push(async()=>r.close()); await observer.ensureReady();
  m.emitEvent({Event:"Newchannel",Uniqueid:"retained",Channel:"PJSIP/a-1"});
  m.emitEvent({Event:"Hangup",Uniqueid:"retained",Channel:"PJSIP/a-1"});
  await new Promise(resolve=>setTimeout(resolve,40));
  for(const socket of m.sockets) socket.destroy(); await new Promise(resolve=>setTimeout(resolve,30));
  m.rejectLogin=true; await assert.rejects(observer.ensureReady());
  m.rejectLogin=false;
  assert.equal((await observer.recentCalls({limit:10},performance.now()+500)).records[0].uniqueid,"retained");
  for(const socket of m.sockets) socket.destroy(); await new Promise(resolve=>setTimeout(resolve,30));
  m.loginDelayMs=1000; const cancelled=assert.rejects(observer.ensureReady());
  r.close(); await cancelled; await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(m.sockets.size,0); await assert.rejects(observer.ensureReady());
});

test("expectation startup rejects unknown target and credential keys without input leakage", async () => {
  const secret="expectation-secret-marker";
  for(const data of [{targets:{[secret]:{}}},{targets:{default:{password:secret}}}]) {
    const {status,stderr}=await startupFailure({ASTERISK_AMI_HOST:"127.0.0.1",PBX_MCP_FIXTURE_EXPECTATIONS_FILE:writeTargets(data)});
    assert.equal(status,1); assert.match(stderr,/PBX_MCP_FIXTURE_EXPECTATIONS_FILE is invalid/); assert.doesNotMatch(stderr,new RegExp(secret));
  }
});
