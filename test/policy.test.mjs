/**
 * Command safety policy: what the read-only mode lets through and what it does not.
 *
 * Runs against the build output, so `npm run build` first (`npm test` does both).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkAsteriskCommand, checkFreeswitchCommand } from "../dist/config.js";

const fsRead = (cmd) => checkFreeswitchCommand(cmd, false).allowed;
const astRead = (cmd) => checkAsteriskCommand(cmd, false).allowed;

test("FreeSWITCH: inspection commands are allowed", () => {
  for (const cmd of [
    "status",
    "show channels",
    "show calls count",
    "sofia status",
    "sofia status profile internal",
    "sofia status profile internal reg",
    "sofia xmlstatus",
    "version",
    "uptime",
    "list_users",
    "global_getvar hostname",
    "db list",
    "db exists domain/key",
    "conference list",
    "conference 3001 list",
    "conference 3001 xml_list",
  ]) {
    assert.equal(fsRead(cmd), true, `${cmd} should be allowed`);
  }
});

test("FreeSWITCH: a destructive subcommand under an allowed verb is refused", () => {
  // The whole point of the rewrite. Under the old deny list of scary words these
  // passed, because "kick", "hup" and "mute" were never on it.
  for (const cmd of [
    "conference 3001 kick all",
    "conference 3001 hup all",
    "conference 3001 mute 1",
    "conference 3001 record /tmp/x.wav",
    "sofia profile internal restart",
    "sofia profile internal killgw mytrunk",
    "db insert domain/key/value",
    "db delete domain/key",
  ]) {
    assert.equal(fsRead(cmd), false, `${cmd} should be refused`);
  }
});

test("FreeSWITCH: plainly destructive verbs stay refused", () => {
  for (const cmd of [
    "uuid_kill 1234",
    "hupall",
    "originate user/1001 &echo",
    "reload mod_sofia",
    "shutdown",
    "fsctl shutdown",
    "fsctl hupall",
  ]) {
    assert.equal(fsRead(cmd), false, `${cmd} should be refused`);
  }
});

test("FreeSWITCH: write mode lifts the allow list", () => {
  assert.equal(checkFreeswitchCommand("conference 3001 kick all", true).allowed, true);
  assert.equal(checkFreeswitchCommand("originate user/1001 9999", true).allowed, true);
});

test("FreeSWITCH: shell metacharacters are refused even in write mode", () => {
  for (const cmd of ["show channels; shutdown", "status && reboot", "status\nshutdown", "show `id`"]) {
    assert.equal(checkFreeswitchCommand(cmd, true).allowed, false, `${cmd} should be refused`);
  }
});

test("FreeSWITCH: empty and whitespace commands are refused", () => {
  assert.equal(fsRead(""), false);
  assert.equal(fsRead("   "), false);
});

test("FreeSWITCH: matching is not fooled by case or extra spaces", () => {
  assert.equal(fsRead("  SHOW   channels  "), true);
  assert.equal(fsRead("CONFERENCE 3001 KICK all"), false);
});

test("FreeSWITCH: a prefix must end on a word boundary", () => {
  // "show" is allowed but "showreload" is a different command.
  assert.equal(fsRead("showreload"), false);
  assert.equal(fsRead("status_stop"), false);
});

test("Asterisk: inspection commands are allowed, others are not", () => {
  assert.equal(astRead("core show channels"), true);
  assert.equal(astRead("core show channels verbose"), true);
  assert.equal(astRead("pjsip show endpoints"), true);
  assert.equal(astRead("uptime"), true);
  assert.equal(astRead("core restart now"), false);
  assert.equal(astRead("channel request hangup PJSIP/1001-1"), false);
});

test("Asterisk: shell metacharacters are refused even in write mode", () => {
  for (const cmd of ["core show channels; rm -rf /", "core show version && id", "core show version\nreload"]) {
    assert.equal(checkAsteriskCommand(cmd, true).allowed, false, `${cmd} should be refused`);
  }
});
