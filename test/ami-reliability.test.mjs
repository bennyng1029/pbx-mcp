/**
 * AMI reliability: shared connect, login-gated ready, bounded calls, no false empties.
 * Runs against the build output (`npm test` builds first) and the in-process mock AMI.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { AmiClient, AmiError } from "../dist/ami.js";
import { lazyClient } from "../dist/lazy-client.js";
import { registerAsteriskTools } from "../dist/tools/asterisk.js";
import { startMockAmi } from "./helpers/mock-ami.mjs";

const mocks = [];
const open = [];
async function mock(opts = {}) {
  const m = await startMockAmi();
  Object.assign(m, opts);
  mocks.push(m);
  return m;
}
const newClient = (m, timeoutMs = 3000) =>
  new AmiClient({ host: "127.0.0.1", port: m.port, username: "mcp", password: "x", timeoutMs });
const holder = (m, timeoutMs) => lazyClient(() => { const c = newClient(m, timeoutMs); open.push(c); return c; }, (c) => c.isConnected);
after(async () => {
  open.forEach((c) => c.close());
  for (const m of mocks) await m.close();
});

/** Register the Asterisk tools on a fake server and return the tool handlers by name. */
function tools(getClient, cfg = { allowWrite: false, timeoutMs: 3000 }) {
  const handlers = {};
  registerAsteriskTools({ registerTool: (name, _def, fn) => (handlers[name] = fn) }, cfg, getClient);
  return handlers;
}
const bodyOf = (r) => r.content.map((c) => c.text).join("\n");

// --- holder ---

test("three parallel cold calls share one connection", async () => {
  const m = await mock({ requireLogin: true, loginDelayMs: 150 });
  let closes = 0;
  const get = lazyClient(
    () => { const c = newClient(m); const close = c.close.bind(c); c.close = () => { closes++; close(); }; open.push(c); return c; },
    (c) => c.isConnected
  );
  const [a, b, c] = await Promise.all([get(), get(), get()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(m.connections, 1);
  assert.equal(closes, 0);
  assert.equal(a.isConnected, true);
});

test("unauthenticated action is never sent before login", async () => {
  const m = await mock({ requireLogin: true, loginDelayMs: 200 });
  const get = holder(m);
  const results = await Promise.all([get(), get(), get()].map((p) => p.then((c) => c.command("core show uptime"))));
  for (const r of results) assert.match(r, /System uptime/);
  assert.deepEqual(m.actions().map((a) => a.Action), ["Command", "Command", "Command"]);
  assert.equal(m.received[0].Action, "Login");
});

test("close during connect rejects within the timeout", async () => {
  const m = await mock({ loginDelayMs: 1000 });
  const c = newClient(m, 500);
  const t0 = Date.now();
  const p = c.connect();
  setTimeout(() => c.close(), 100);
  await assert.rejects(p, AmiError);
  assert.ok(Date.now() - t0 <= 700, `took ${Date.now() - t0} ms`);
  assert.equal(c.isConnected, false);
});

test("close during the TCP phase rejects instead of hanging", async () => {
  // A listener that accepts but never speaks: connect completes, login never answers.
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const c = new AmiClient({ host: "127.0.0.1", port: srv.address().port, username: "u", password: "p", timeoutMs: 500 });
  const p = c.connect();
  setTimeout(() => c.close(), 50);
  await assert.rejects(p, AmiError);
  srv.close();
});

test("close in the TCP-connect window rejects the pending connect", async () => {
  const m = await mock();
  const c = newClient(m, 3000);
  const t0 = Date.now();
  const p = c.connect();
  c.close(); // same tick: the socket is destroyed before its connect callback can fire
  await assert.rejects(p, AmiError);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  assert.equal(c.isConnected, false);
});

test("login success racing close does not publish a ready client", async () => {
  const m = await mock({ loginDelayMs: 150 });
  const c = newClient(m);
  const p = c.connect();
  setTimeout(() => c.close(), 50);
  await assert.rejects(p, AmiError);
  assert.equal(c.isConnected, false);
});

test("late rejection of an old attempt does not clear newer state", async () => {
  const log = [];
  let n = 0;
  const attempts = [];
  const get = lazyClient(
    () => {
      const id = ++n;
      const c = {
        id,
        up: false,
        closes: 0,
        connect() { return new Promise((res, rej) => attempts.push({ id, res: () => { c.up = true; res(); }, rej })); },
        close() { c.closes++; c.up = false; },
      };
      log.push(c);
      return c;
    },
    (c) => c.up
  );
  const first = get();
  attempts[0].res();
  const c1 = await first;
  c1.up = false; // socket dropped: next caller replaces it
  const second = get();
  await new Promise((r) => setImmediate(r));
  assert.equal(attempts.length, 2);
  attempts[0].rej(new Error("late failure of attempt 1")); // already settled: must change nothing
  attempts[1].res();
  const c2 = await second;
  assert.equal(c2.id, 2);
  assert.equal(await get(), c2, "newer client is still the shared one");
  assert.equal(log.length, 2);
});

test("failed connect resets the holder so the next caller retries", async () => {
  const m = await mock({ rejectLogin: true });
  const get = holder(m);
  await assert.rejects(get(), /login rejected/);
  m.rejectLogin = false;
  const c = await get();
  assert.equal(c.isConnected, true);
  assert.equal(m.connections, 2);
});

test("dropped ready client reconnects once and the old client's close count is 1", async () => {
  const m = await mock();
  let closes = 0;
  const get = lazyClient(
    () => { const c = newClient(m); const close = c.close.bind(c); c.close = () => { closes++; close(); }; open.push(c); return c; },
    (c) => c.isConnected
  );
  const first = await get();
  for (const s of m.sockets) s.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(first.isConnected, false);
  const second = await get();
  assert.notEqual(second, first);
  assert.equal(second.isConnected, true);
  assert.equal(closes, 1);
  assert.equal(m.connections, 2);
});

test("holder retries once when the client dropped immediately following connect", async () => {
  let n = 0;
  const get = lazyClient(
    () => {
      const id = ++n;
      const c = { id, up: false, closes: 0, async connect() { c.up = id !== 1; }, close() { c.closes++; } };
      return c;
    },
    (c) => c.up
  );
  const c = await get();
  assert.equal(c.id, 2);
  assert.equal(n, 2);
  // a second consecutive drop is an error, not an endless loop
  let m = 0;
  const bad = lazyClient(() => { m++; return { async connect() {}, close() {} }; }, () => false);
  await assert.rejects(bad(), /dropped immediately/);
  assert.equal(m, 2);
});

test("connect plus login share one timeoutMs budget", async () => {
  const m = await mock({ loginDelayMs: 2000 });
  const c = newClient(m, 400);
  const t0 = Date.now();
  await assert.rejects(c.connect(), /timed out/);
  assert.ok(Date.now() - t0 < 700, `took ${Date.now() - t0} ms, budget was 400`);
});

test("login rejected rejects every waiter and resets the holder", async () => {
  const m = await mock({ rejectLogin: true, loginDelayMs: 100 });
  const get = holder(m);
  const settled = await Promise.allSettled([get(), get(), get()]);
  for (const s of settled) {
    assert.equal(s.status, "rejected");
    assert.match(s.reason.message, /login rejected/);
  }
  assert.equal(m.connections, 1);
  m.rejectLogin = false;
  assert.equal((await get()).isConnected, true);
});

test("holder works with a stub FreeSWITCH-style client", async () => {
  let connects = 0;
  const get = lazyClient(
    () => ({ up: false, async connect() { connects++; await new Promise((r) => setTimeout(r, 20)); this.up = true; }, close() { this.up = false; } }),
    (c) => c.up
  );
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(a, b);
  assert.equal(connects, 1);
});

// --- lists and errors ---

test("Error reply is not rendered as an empty list", async () => {
  const m = await mock({ errorFor: { CoreShowChannels: "Permission denied" } });
  const r = await tools(holder(m)).asterisk_channels({});
  assert.equal(r.isError, true);
  assert.match(bodyOf(r), /Permission denied/);
  assert.doesNotMatch(bodyOf(r), /No active channels/);
});

test("hangup_preview Error reply is a tool error", async () => {
  const m = await mock({ errorFor: { CoreShowChannels: "Permission denied" } });
  const r = await tools(holder(m)).asterisk_hangup_preview({ channel: "1001" });
  assert.equal(r.isError, true);
  assert.match(bodyOf(r), /Permission denied/);
});

test("lone Response timeout keeps today's behaviour", async () => {
  const m = await mock();
  const c = newClient(m, 3000);
  await c.connect();
  open.push(c);
  assert.match(await c.command("core show uptime"), /System uptime/);
  m.swallowNext = "Command";
  await assert.rejects(c.command("core show uptime", 300), /timed out after 300ms/);
});

test("list without Complete event rejects as incomplete", async () => {
  const m = await mock({ omitComplete: true, channels: [{ Channel: "PJSIP/1001-1", ChannelStateDesc: "Up" }] });
  const c = newClient(m, 3000);
  await c.connect();
  open.push(c);
  await assert.rejects(c.action({ Action: "CoreShowChannels" }, 300), /incomplete list/);
  // and the waiter was removed: the next action works
  m.omitComplete = false;
  const msgs = await c.action({ Action: "CoreShowChannels" }, 1000);
  assert.equal(msgs.length, 3);
});

test("endpoints: not-loaded falls back to chan_sip", async () => {
  const m = await mock({ endpoints: undefined, peers: [{ ObjectName: "2001", IPaddress: "10.0.0.5", IPport: "5060", Status: "OK", Dynamic: "yes" }] });
  const r = await tools(holder(m)).asterisk_endpoints({});
  assert.equal(r.isError, undefined);
  assert.match(bodyOf(r), /Source: chan_sip/);
  assert.match(bodyOf(r), /2001/);
});

test("endpoints: other Error is a tool error and does not fall back", async () => {
  const m = await mock({ errorFor: { PJSIPShowEndpoints: "Permission denied" }, peers: [{ ObjectName: "2001" }] });
  const r = await tools(holder(m)).asterisk_endpoints({});
  assert.equal(r.isError, true);
  assert.match(bodyOf(r), /Permission denied/);
  assert.equal(m.actions("SIPpeers").length, 0);
});

test("endpoints: success with zero rows says PJSIP loaded, 0 endpoints", async () => {
  const m = await mock({ endpoints: [] });
  const r = await tools(holder(m)).asterisk_endpoints({});
  assert.equal(r.isError, undefined);
  assert.match(bodyOf(r), /PJSIP is loaded, 0 endpoints/);
  assert.equal(m.actions("SIPpeers").length, 0);
});

test("endpoints fallback finishes within 2x timeout once connected", async () => {
  const m = await mock({ endpoints: undefined });
  const get = holder(m, 400);
  await get(); // connected
  m.omitComplete = true;
  m.peers = [{ ObjectName: "2001" }];
  const t0 = Date.now();
  const r = await tools(get, { allowWrite: false, timeoutMs: 400 }).asterisk_endpoints({});
  assert.ok(Date.now() - t0 < 800 + 300, `took ${Date.now() - t0} ms`);
  assert.equal(r.isError, true);
});

test("true empty channel list still says No active channels", async () => {
  const m = await mock({ channels: [] });
  const r = await tools(holder(m)).asterisk_channels({});
  assert.match(bodyOf(r), /No active channels/);
  assert.equal(r.isError, undefined);
});

test("CF-008: unbounded data without message boundary resets connection at MAX_AMI_BUFFER", async () => {
  const m = await mock();
  const c = newClient(m, 1000);
  await c.connect();
  open.push(c);
  assert.equal(c.isConnected, true);

  // Send a chunk exceeding MAX_AMI_BUFFER (1MB) to the socket without MSG_END
  const socket = [...m.sockets][0];
  socket.write("X".repeat(1024 * 1024 + 100));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.isConnected, false);
});

async function connectedMock(opts = {}) {
  const m = await mock(opts);
  const c = newClient(m); open.push(c); await c.connect();
  return { m, c };
}
const bounded = { maxMessages: 130, rowEvent: "CoreShowChannel", maxRows: 128 };

test("command errors preserve raw repeated diagnostic Output, success remains exact", async () => {
  const { m, c } = await connectedMock();
  for (const command of ["dialplan show mcp-test", "dialplan show 123@mcp-test"]) {
    m.rawResponseFor[command] = "Response: Success\r\nMessage: Command output follows\r\nOutput: existing\r\nOutput: extension";
    assert.equal(await c.command(command), "existing\nextension");
    m.rawResponseFor[command] = "Response: Error\r\nMessage: Command output follows\r\nOutput: There is no existence\r\nOutput: missing extension";
    await assert.rejects(c.command(command), e => e instanceof AmiError && /There is no existence\nmissing extension/.test(e.message));
  }
  m.rawResponseFor.empty = "Response: Error\r\nOutput: ";
  await assert.rejects(c.command("empty"), /Asterisk rejected: empty/);
  m.rawResponseFor.denied = "Response: Error\r\nMessage: Permission denied\r\nOutput: ";
  await assert.rejects(c.command("denied"), /Permission denied/);
});

test("bounded actions allow 128 total rows and reject 129 including non-PJSIP immediately", async () => {
  const { m, c } = await connectedMock({ channels: Array.from({length:128}, () => ({Channel:"Local/1"})) });
  assert.equal((await c.action({ Action:"CoreShowChannels" }, 1000, bounded)).length, 130);
  m.channels.push({Channel:"Local/129"}); m.omitComplete = true;
  const started = Date.now();
  await assert.rejects(c.action({Action:"CoreShowChannels"}, 2000, bounded), /maxRows|row limit/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(c.waiters.length, 0);
  assert.equal((await c.action({Action:"Events"}))[0].Response, "Success");
  m.omitComplete = false;
  assert.equal((await c.action({Action:"CoreShowChannels"})).length, 131, "ordinary callers stay unbounded");
});

test("131st matched message rejects without completion", async () => {
  const { c } = await connectedMock({ rawResponseFor:{ CoreShowChannels: ["Response: Success\r\nEventList: start", ...Array(130).fill("Event: Other")].join("\r\n\r\n") } });
  await assert.rejects(c.action({Action:"CoreShowChannels"}, 2000, bounded), /maxMessages|message limit/);
  assert.equal(c.waiters.length, 0);
});

test("unsolicited events do not steal list rows and unsubscribe stops delivery", async () => {
  const { m, c } = await connectedMock({ channels:[{Channel:"PJSIP/1"},{Channel:"PJSIP/2"}], unsolicitedBetweenRows:["Event: Newchannel\r\nUniqueid: 1"] });
  const events=[]; const unsub=c.subscribeEvents(e => events.push(e));
  const rows=await c.action({Action:"CoreShowChannels"}, 1000, bounded);
  assert.equal(rows.length, 4); assert.deepEqual(events.map(e=>e.Event), ["Newchannel"]);
  unsub(); m.emitEvent({Event:"Hangup"});
  await new Promise(r=>setTimeout(r,30)); assert.equal(events.length, 1);
});

test("action abort, timeout, transport close and explicit close immediately remove waiters", async () => {
  for (const mode of ["abort", "timeout", "transport", "explicit"]) {
    const { m, c } = await connectedMock({swallowNext:"CoreShowChannels"});
    const lifecycle=[]; const unsub=c.subscribeLifecycle(reason=>lifecycle.push(reason));
    const controller=new AbortController();
    const p=c.action({Action:"CoreShowChannels"}, mode==="timeout"?30:2000, {signal:controller.signal});
    const rejected=assert.rejects(p, AmiError);
    if(mode==="abort") controller.abort();
    if(mode==="transport") for(const sock of m.sockets) sock.destroy();
    if(mode==="explicit") {c.close();c.close();}
    await rejected; assert.equal(c.waiters.length,0);
    if(mode==="explicit"||mode==="transport") { await new Promise(r=>setTimeout(r,20)); assert.equal(lifecycle.length,1); }
    unsub(); c.close();
  }
});

test("pre-aborted and failed writes leave no action waiter", async () => {
  const {c}=await connectedMock(); const controller=new AbortController(); controller.abort();
  await assert.rejects(c.action({Action:"Events"},1000,{signal:controller.signal}), /cancel/i);
  assert.equal(c.waiters.length,0);
  c.socket.write=()=>{throw new Error("write failed")};
  await assert.rejects(c.action({Action:"Events"}), /write failed/);
  assert.equal(c.waiters.length,0);
});

test("Events refusal is preserved as an Error response and waiter is removed", async () => {
  const {c}=await connectedMock({errorFor:{Events:"Permission denied"}});
  const response=await c.action({Action:"Events",EventMask:"call"});
  assert.equal(response[0].Response,"Error"); assert.equal(response[0].Message,"Permission denied");
  assert.equal(c.waiters.length,0);
});

test("asynchronous write failure cancels its timer and waiter", async () => {
  const {c}=await connectedMock();
  c.socket.write=(_payload, callback)=>{queueMicrotask(()=>callback(new Error("async write failed")));return false;};
  await assert.rejects(c.action({Action:"Events"}), /async write failed/);
  assert.equal(c.waiters.length,0);
});

test("socket error and input buffer failure reject actions and notify once", async () => {
  for(const reason of ["socket_error","input_buffer_failure"]) {
    const {m,c}=await connectedMock({swallowNext:"Events"});
    const notifications=[]; const unsub=c.subscribeLifecycle(r=>notifications.push(r));
    const pending=assert.rejects(c.action({Action:"Events"},2000), AmiError);
    if(reason==="socket_error") c.socket.emit("error",new Error("transport failed"));
    else c.onData("X".repeat(1024*1024+100));
    await pending; c.close(); await new Promise(r=>setTimeout(r,20));
    assert.deepEqual(notifications,[reason]); assert.equal(c.waiters.length,0);assert.equal(c.isConnected,false);
    unsub();
  }
});

test("reentrant event unsubscribe and action dispatch preserve the other subscribers", async () => {
  const {m,c}=await connectedMock(); const received=[]; let action; let delivered;
  const delivery=new Promise(resolve=>{delivered=resolve;});
  const unsub=c.subscribeEvents(()=>{unsub(); action=c.action({Action:"Events"}); delivered();});
  c.subscribeEvents(e=>received.push(e.Event));
  m.emitEvent({Event:"Newchannel"});
  await delivery;
  assert.equal((await action)[0].Response,"Success");
  const hangup=new Promise(resolve=>{const stop=c.subscribeEvents(e=>{if(e.Event==="Hangup"){stop();resolve();}});});
  m.emitEvent({Event:"Hangup"}); await hangup;
  assert.deepEqual(received,["Newchannel","Hangup"]); assert.equal(c.waiters.length,0);
});

test("permanent holder abort rejects stalled callers, closes current and forbids retry", async () => {
  const controller = new AbortController(); let creates = 0; let closes = 0; let resolve;
  const get = lazyClient(() => { creates++; return { connect: () => new Promise(r => { resolve = r; }), close() { closes++; } }; }, () => true, controller.signal);
  const a = get(); const b = get();
  controller.abort();
  await Promise.all([assert.rejects(a, /closed|cancel/i), assert.rejects(b, /closed|cancel/i)]);
  resolve(); await new Promise(r => setImmediate(r));
  await assert.rejects(get(), /closed|cancel/i);
  assert.equal(creates, 1); assert.equal(closes, 1);
});

test("actual lazy holder second pass shares original observation deadline and later attempt is fresh", async () => {
  const { CallObserver } = await import("../dist/call-observation.js");
  const m=await mock({loginDelayMs:80}); let creates=0; const budgets=[]; const clients=[];
  const factory=(deadline,signal)=>lazyClient(()=>{
    const budget=deadline-performance.now(); budgets.push(budget);
    const c=newClient(m,budget); clients.push(c); open.push(c); const connect=c.connect.bind(c); const id=++creates;
    c.connect=async()=>{await connect(); if(id===1){ c.close(); m.loginDelayMs=1000; }};
    return c;
  },c=>c.isConnected,signal);
  const observer=new CallObserver({name:"test",label:"test",host:"127.0.0.1",port:m.port},factory,200);
  const began=performance.now(); await assert.rejects(observer.ensureReady()); const elapsed=performance.now()-began;
  assert.equal(creates,2); assert.ok(budgets[1]<budgets[0]-50); assert.ok(elapsed<350,`elapsed ${elapsed}`);
  await new Promise(r=>setTimeout(r,30)); assert.equal(m.sockets.size,0); assert.ok(clients.every(c=>!c.isConnected));
  m.loginDelayMs=0; await observer.ensureReady(); assert.equal(creates,3); assert.equal(observer.coverage().ready,true); observer.close();
});
