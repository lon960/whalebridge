// sanitize-config.mjs
//
// Strip every value that belongs to *the machine that built this package* out of a
// bridge config before it ships.
//
// Why this exists: shipping the author's live config.json makes a fresh install
// look broken in ways that never raise an error — the bot ignores everyone (the
// allow-list is the author's groups), DSH never connects (the port is the author's),
// ffmpeg is missing (the path is the author's), and the persona is the author's.
// All four look like "it installed fine but does nothing".
//
// usage: node sanitize-config.mjs <config.json> [--owner <qq>]
//
// Only machine-specific values are touched; prompts, social parameters and feature
// switches are preserved.

import fs from 'node:fs';

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error('usage: node sanitize-config.mjs <config.json> [--owner <qq>]');
  process.exit(2);
}

const argv = process.argv.slice(3);
const ownerIdx = argv.indexOf('--owner');
const owner = ownerIdx >= 0 ? String(argv[ownerIdx + 1] || '') : '';

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  console.error('cannot read config.json: ' + (error?.message ?? error));
  process.exit(3);
}

const touched = [];
const mark = (name) => touched.push(name);

// 1) owner / instance identity
if ('ownerQQ' in cfg) {
  cfg.ownerQQ = owner;
  mark('ownerQQ');
}
if ('id' in cfg) {
  cfg.id = '';
  mark('id');
}

// 2) allow-lists: empty means "allow everything" (qq-bridge's allowed() returns true
//    when the list is empty). Shipping the author's list is the worst option: every
//    other group is silently ignored and nothing explains why.
if (cfg.allow) {
  cfg.allow.groups = [];
  cfg.allow.private = [];
  mark('allow');
}

// 3) DSH endpoint: port and provider belong to the author's machine.
//    install.ps1 / supervise.ps1 probe the real port on the target machine.
if (cfg.dsh) {
  cfg.dsh.baseUrl = '';
  cfg.dsh.provider = '';
  cfg.dsh.authToken = '';
  if (cfg.dsh.route) {
    cfg.dsh.route.enabled = false;
    cfg.dsh.route.rules = [];
  }
  mark('dsh');
}

// 4) transport tokens: generated per machine by install.ps1
if (cfg.qq) {
  cfg.qq.wsToken = '';
  cfg.qq.httpToken = '';
  mark('qq.tokens');
}
if (cfg.snowluma) {
  cfg.snowluma.accessToken = '';
  cfg.snowluma.homeDir = '';
  if ('groupId' in cfg.snowluma) {
    cfg.snowluma.groupId = '';
    mark('snowluma.groupId');
  }
  mark('snowluma');
}

// 5) voice: every path points at the author's disk
if (cfg.socialV2?.voice) {
  const v = cfg.socialV2.voice;
  v.enabled = false;
  if ('ffmpegPath' in v) v.ffmpegPath = '';
  if ('path' in v) v.path = 'src/send-voice-lib.js';
  if (v.gptSovits) {
    v.gptSovits.refAudio = '';
    if (v.gptSovits.emotionRefs) v.gptSovits.emotionRefs = {};
  }
  if (v.ttsEngine) v.ttsEngine = 'gptsovits';
  mark('socialV2.voice');
}

// 6) private contact book + session bindings (botId / userId / group ids are the author's)
if (cfg.socialV2) {
  if (cfg.socialV2.contacts) {
    cfg.socialV2.contacts = {};
    mark('socialV2.contacts');
  }
  if (cfg.socialV2.sessionRanges) {
    cfg.socialV2.sessionRanges = [];
    mark('socialV2.sessionRanges');
  }
  // vision / memory judge / persona evolution also carry the author's port;
  // clearing them makes them fall back to dsh.baseUrl
  for (const key of ['vision', 'fastLocal', 'memoryV2', 'persona']) {
    const node = cfg.socialV2[key];
    if (!node) continue;
    if (node.baseUrl) node.baseUrl = '';
    if (node.judge?.baseUrl) node.judge.baseUrl = '';
    if (node.cloud?.baseUrl) node.cloud.baseUrl = '';
    mark('socialV2.' + key + '.baseUrl');
  }
  // state files stay relative to bridge/ so they land in state/
  if (cfg.socialV2.emotion?.file) {
    cfg.socialV2.emotion.file = 'state/emotion.json';
    mark('socialV2.emotion.file');
  }
  if (cfg.socialV2.memoryV2?.file) cfg.socialV2.memoryV2.file = 'state/memory-v2.json';
  if (cfg.socialV2.persona?.file) cfg.socialV2.persona.file = 'state/persona-evolution.json';
}

// 7) top-level console token
if ('consoleToken' in cfg) cfg.consoleToken = '';

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('sanitized=' + touched.length + ' fields: ' + touched.join(', '));
