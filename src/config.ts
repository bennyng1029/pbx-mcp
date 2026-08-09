/**
 * Configuration and the command safety policy.
 *
 * Part of pbx-mcp by Tahir Almas, ICT Innovations (https://ictinnovations.com).
 */

export interface Config {
  asterisk?: {
    host: string;
    port: number;
    username: string;
    password: string;
    tls: boolean;
  };
  freeswitch?: {
    host: string;
    port: number;
    password: string;
  };
  allowWrite: boolean;
  timeoutMs: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg: Config = {
    allowWrite: /^(1|true|yes)$/i.test(env.PBX_MCP_ALLOW_WRITE ?? ""),
    timeoutMs: num(env.PBX_MCP_TIMEOUT_MS, 10000),
  };

  if (env.ASTERISK_AMI_HOST) {
    cfg.asterisk = {
      host: env.ASTERISK_AMI_HOST,
      port: num(env.ASTERISK_AMI_PORT, 5038),
      username: env.ASTERISK_AMI_USERNAME ?? "",
      password: env.ASTERISK_AMI_PASSWORD ?? "",
      tls: /^(1|true|yes)$/i.test(env.ASTERISK_AMI_TLS ?? ""),
    };
  }

  if (env.FREESWITCH_ESL_HOST) {
    cfg.freeswitch = {
      host: env.FREESWITCH_ESL_HOST,
      port: num(env.FREESWITCH_ESL_PORT, 8021),
      password: env.FREESWITCH_ESL_PASSWORD ?? "ClueCon",
    };
  }

  return cfg;
}

/**
 * Asterisk CLI commands the server will run in read-only mode.
 * Matching is on the start of the command, so "core show channels verbose" passes
 * under "core show". Anything not listed needs PBX_MCP_ALLOW_WRITE.
 */
export const ASTERISK_READ_PREFIXES = [
  "core show",
  "core get",
  "pjsip show",
  "pjsip list",
  "sip show",
  "iax2 show",
  "dialplan show",
  "database show",
  "database get",
  "queue show",
  "voicemail show",
  "manager show",
  "module show",
  "channel show",
  "cdr show",
  "http show",
  "rtp show",
  "stun show",
  "fax show",
  "confbridge list",
  "agent show",
  "devstate list",
  "hangupcause list",
  "logger show",
  "uptime",
];

/**
 * FreeSWITCH API commands allowed in read-only mode. FreeSWITCH commands are a
 * single verb plus arguments, so the first word is what gets checked.
 */
export const FREESWITCH_READ_COMMANDS = [
  "status",
  "show",
  "sofia",
  "version",
  "uptime",
  "global_getvar",
  "help",
  "list_users",
  "conference",
  "fsctl",
  "regex",
  "strftime",
  "module_exists",
  "db",
];

/** Verbs that change call state or configuration. Never allowed without write mode. */
const DESTRUCTIVE_HINTS = [
  "reload",
  "restart",
  "shutdown",
  "unload",
  "load",
  "originate",
  "hangup",
  "kill",
  "uuid_kill",
  "set",
  "setvar",
  "delete",
  "del",
  "put",
  "flush",
  "reset",
  "stop",
  "start",
];

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

export function checkAsteriskCommand(cli: string, allowWrite: boolean): PolicyResult {
  const cmd = cli.trim().toLowerCase().replace(/\s+/g, " ");
  if (!cmd) return { allowed: false, reason: "Empty command." };

  // Shell metacharacters have no place in an AMI Command action.
  if (/[;|&`$><\n\r]/.test(cli)) {
    return { allowed: false, reason: "Command contains shell metacharacters." };
  }

  if (allowWrite) return { allowed: true };

  const readOnly = ASTERISK_READ_PREFIXES.some((p) => cmd === p || cmd.startsWith(p + " "));
  if (readOnly) return { allowed: true };

  return {
    allowed: false,
    reason:
      `"${cli}" is not on the read-only allow list. ` +
      `Set PBX_MCP_ALLOW_WRITE=true to permit arbitrary CLI commands.`,
  };
}

export function checkFreeswitchCommand(command: string, allowWrite: boolean): PolicyResult {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "Empty command." };

  if (/[;|&`$><\n\r]/.test(trimmed)) {
    return { allowed: false, reason: "Command contains shell metacharacters." };
  }

  const verb = trimmed.split(/\s+/)[0].toLowerCase();
  if (allowWrite) return { allowed: true };

  if (!FREESWITCH_READ_COMMANDS.includes(verb)) {
    return {
      allowed: false,
      reason:
        `"${verb}" is not on the read-only allow list. ` +
        `Set PBX_MCP_ALLOW_WRITE=true to permit arbitrary API commands.`,
    };
  }

  // "sofia profile internal restart" is read-prefixed but not a read.
  const words = trimmed.toLowerCase().split(/\s+/);
  const destructive = words.find((w) => DESTRUCTIVE_HINTS.includes(w));
  if (destructive) {
    return {
      allowed: false,
      reason: `"${destructive}" changes state and needs PBX_MCP_ALLOW_WRITE=true.`,
    };
  }

  return { allowed: true };
}

/** Reject anything that could inject extra AMI headers through a field value. */
export function assertNoHeaderInjection(label: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} may not contain carriage returns or newlines.`);
  }
}
