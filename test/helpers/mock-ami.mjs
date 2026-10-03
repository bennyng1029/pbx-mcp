/**
 * A tiny in-process AMI server for tests: no network beyond loopback.
 *
 * It models just enough of Asterisk for provisioning: Login, GetConfig,
 * UpdateConfig (newcat / append / delcat, with Asterisk's refusal of duplicate
 * category names and all-or-nothing batches), and the two CLI commands the
 * provisioner issues.
 */

import net from "node:net";

export async function startMockAmi(seed = {}) {
  // seed: { name: vars } for unique names, or [{ name, vars }] to repeat a name.
  const state = {
    received: [], // every parsed request, in order
    categories: (Array.isArray(seed) ? seed : Object.entries(seed).map(([name, vars]) => ({ name, vars }))), // names may repeat, like the real file
    failVerify: false, // make `pjsip show endpoint` claim nothing exists
    swallowNext: undefined, // an Action name: apply it, but never reply (once)
    delayMs: 0, // delay every reply, to expose interleaving
    sockets: new Set(),
    connections: 0, // sockets ever accepted
    requireLogin: false, // answer any action before a successful Login with Permission denied
    loginDelayMs: 0, // delay only the Login reply
    rejectLogin: false, // answer Login with an Error
    errorFor: {}, // { Action: "message" } force an Error reply for that action
    omitComplete: false, // list actions send rows but never the ...Complete event
    channels: [], // CoreShowChannels rows: objects of AMI fields
    endpoints: undefined, // PJSIPShowEndpoints rows; undefined = module not loaded (Invalid/unknown command)
    peers: [], // SIPpeers rows
    vars: {}, // Getvar: { "<Channel>|<Variable>": value }
  };

  const server = net.createServer((sock) => {
    state.sockets.add(sock);
    state.connections++;
    sock.loggedIn = false;
    sock.on("close", () => state.sockets.delete(sock));
    sock.on("error", () => {});
    sock.setEncoding("utf8");
    sock.write("Asterisk Call Manager/9.0.0\r\n");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\r\n\r\n")) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 4);
        const req = {};
        for (const line of raw.split("\r\n")) {
          const c = line.indexOf(":");
          if (c > 0) req[line.slice(0, c).trim()] = line.slice(c + 1).trim();
        }
        state.received.push(req);
        const reply = respond(req, sock);
        if (state.swallowNext === req.Action) {
          state.swallowNext = undefined;
          continue;
        }
        const wait = state.delayMs + (req.Action === "Login" ? state.loginDelayMs : 0);
        setTimeout(() => {
          // Every message of the reply (a list is several) carries the request's ActionID.
          if (!sock.destroyed) sock.write(reply.split("\r\n\r\n").map((m) => `${m}\r\nActionID: ${req.ActionID}`).join("\r\n\r\n") + "\r\n\r\n");
        }, wait);
      }
    });
  });

  const out = (lines) => lines.join("\r\n");
  const cli = (text) =>
    out(["Response: Success", "Message: Command output follows", ...text.split("\n").map((l) => `Output: ${l}`)]);
  const err = (m) => out(["Response: Error", `Message: ${m}`]);

  /** A list reply: Response, one event per row (each its own message), then the Complete event. */
  const list = (listName, event, rows, complete) => {
    const msgs = [`Response: Success\r\nEventList: start\r\nMessage: ${listName} will follow`];
    for (const r of rows) msgs.push(`Event: ${event}\r\n` + Object.entries(r).map(([k, v]) => `${k}: ${v}`).join("\r\n"));
    if (!state.omitComplete) msgs.push(`Event: ${complete}\r\nEventList: Complete\r\nListItems: ${rows.length}`);
    return msgs.join("\r\n\r\n");
  };

  function respond(req, sock) {
    if (req.Action !== "Login" && state.requireLogin && !sock.loggedIn) return err("Permission denied");
    if (state.errorFor[req.Action]) return err(state.errorFor[req.Action]);
    switch (req.Action) {
      case "Login":
        if (state.rejectLogin) return err("Authentication failed");
        sock.loggedIn = true;
        return out(["Response: Success", "Message: Authentication accepted"]);
      case "CoreShowChannels":
        return list("channels", "CoreShowChannel", state.channels, "CoreShowChannelsComplete");
      case "PJSIPShowEndpoints":
        if (!state.endpoints) return err("Invalid/unknown command: PJSIPShowEndpoints");
        return list("endpoints", "EndpointList", state.endpoints, "EndpointListComplete");
      case "SIPpeers":
        return list("peers", "PeerEntry", state.peers, "PeerlistComplete");
      case "Getvar": {
        const v = state.vars[`${req.Channel}|${req.Variable}`];
        return v === undefined ? err("No such variable") : out(["Response: Success", `Variable: ${req.Variable}`, `Value: ${v}`]);
      }
      case "GetConfig": {
        const lines = ["Response: Success"];
        let n = 0;
        for (const { name, vars } of state.categories) {
          const c = String(n++).padStart(6, "0");
          lines.push(`Category-${c}: ${name}`);
          vars.forEach(([k, v], j) => lines.push(`Line-${c}-${String(j).padStart(6, "0")}: ${k}=${v}`));
        }
        return out(lines);
      }
      case "UpdateConfig": {
        const next = state.categories.map((c) => ({ name: c.name, vars: [...c.vars] }));
        const vtype = (c) => c.vars.find(([k]) => k === "type")?.[1];
        for (let i = 0; `Action-${String(i).padStart(6, "0")}` in req; i++) {
          const n = String(i).padStart(6, "0");
          const cat = req[`Cat-${n}`];
          const action = req[`Action-${n}`];
          const opts = req[`Options-${n}`] ?? "";
          const filter = /catfilter="type=\^(\w+)\$"/.exec(opts)?.[1];
          const matches = (c) => c.name === cat && (!filter || vtype(c) === filter);
          if (action === "newcat") {
            // Asterisk refuses a duplicate name unless Options has allowdups.
            if (next.some((c) => c.name === cat) && !opts.includes("allowdups")) return err("Create category did not complete successfully");
            next.push({ name: cat, vars: [] });
          } else if (action === "append") {
            const hit = next.filter(matches);
            if (!hit.length) return err("Update category did not complete successfully");
            hit.forEach((c) => c.vars.push([req[`Var-${n}`], req[`Value-${n}`]])); // appends hit EVERY same-named category
          } else if (action === "renamecat") {
            const hit = next.find(matches);
            if (!hit) return err("Rename category did not complete successfully");
            hit.name = req[`Value-${n}`]; // rename does not check for duplicates
          } else if (action === "delcat") {
            const before = next.length;
            for (let j = next.length - 1; j >= 0; j--) if (matches(next[j])) next.splice(j, 1);
            if (next.length === before) return err("Delete category did not complete successfully");
          } else return err("Unknown action");
        }
        state.categories = next;
        return "Response: Success";
      }
      case "Command": {
        const c = req.Command;
        if (c === "module reload res_pjsip.so") return cli("Module 'res_pjsip.so' reloaded successfully.");
        const m = /^pjsip show endpoint (\S+)$/.exec(c);
        if (m) {
          const found = !state.failVerify && state.categories.some((c) => c.name === m[1] && c.vars.some(([k, v]) => k === "type" && v === "endpoint"));
          return cli(found ? `Endpoint:  ${m[1]}\nAor:  ${m[1]}` : `Unable to find object ${m[1]}.`);
        }
        if (c === "core show uptime") return cli("System uptime: 1 minute\nLast reload: 1 minute");
        if (c === "core show settings") return state.settingsError ? err("Permission denied") : cli("Version: mock\nConfiguration file:          /etc/asterisk/asterisk.conf\nPBX UUID:                    8d3bd6cc-0000-0000-0000-000000000001");
        if (c === "core show version") return cli("Asterisk mock 22.0.0");
        if (c === "core show calls") return cli("0 active calls\n0 calls processed");
        return err(`No such command '${c}'`);
      }
      default:
        return err(`Invalid/unknown command: ${req.Action}`);
    }
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.port = server.address().port;
  state.close = async () => {
    for (const s of state.sockets) s.destroy();
    await new Promise((r) => server.close(r));
  };
  /** Requests after login, optionally filtered by Action. */
  state.actions = (name) => state.received.filter((r) => r.Action !== "Login" && (!name || r.Action === name));
  return state;
}
