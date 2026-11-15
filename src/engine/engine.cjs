/*
 * WhaleBridge engine - runs INSIDE the real QQ client process.
 *
 * It is loaded by the injector (see src/injector/payload.c), which replaces a
 * 129-byte comment inside QQNT.dll with a call to this file. From there it
 * translates QQ's internal `ntApi` RPC into OneBot v11 over HTTP + WebSocket.
 *
 * All machine specific values (port, QQ paths, account, token) come from
 * config.json next to this file's parent directory - nothing is hardcoded.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { BrowserWindow } = require('electron');

function findPkg(start) {
  var d = start;
  for (var i = 0; i < 4; i++) {
    try { if (fs.existsSync(path.join(d, 'config.json'))) return d; } catch (e) {}
    var up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return start;
}
const PKG = findPkg(__dirname);
let CFG = { port: 3902, webhook: '', self_uin: 0 };
let SELF_CONFIG_ERR = '';
try { var cj = fs.readFileSync(path.join(PKG, 'config.json'), 'utf8').replace(/^\uFEFF/, ''); CFG = Object.assign(CFG, JSON.parse(cj)); } catch(e) { SELF_CONFIG_ERR = String(e); }


const LOG = path.join(__dirname, 'engine.log');
const PORT = Number(CFG.port) || 3902;
let SELF_UIN = Number(CFG.self_uin) || 0;
const DATA_DIR = CFG.data_dir || autoDataDir();
// no uin in config -> take it from the account data folder we just located
if (!SELF_UIN) { var _m = /(\d{5,12})[\\/]?$/.exec(String(DATA_DIR || '')); if (_m) SELF_UIN = Number(_m[1]); }
function autoDataDir(){
  var uin = String(SELF_UIN || '');
  var roots = [];
  try { if (CFG.qq_cwd) roots.push(path.join(CFG.qq_cwd, 'Tencent Files')); } catch(e) {}
  try { if (CFG.qq_exe) roots.push(path.join(path.dirname(CFG.qq_exe), 'Tencent Files')); } catch(e) {}
  try { roots.push(path.join(process.env.USERPROFILE || '', 'Documents', 'Tencent Files')); } catch(e) {}
  if (uin) {
    for (var i = 0; i < roots.length; i++) {
      var c = path.join(roots[i], uin);
      try { if (fs.existsSync(path.join(c, 'nt_qq'))) return c; } catch(e) {}
    }
  }
  // no uin configured: pick the most recently used account folder that has nt_qq
  var best = '', bestT = 0;
  for (var r = 0; r < roots.length; r++) {
    try {
      fs.readdirSync(roots[r]).forEach(function(name){
        var d = path.join(roots[r], name);
        try {
          if (!fs.existsSync(path.join(d, 'nt_qq'))) return;
          var t = fs.statSync(path.join(d, 'nt_qq')).mtimeMs;
          if (t > bestT) { bestT = t; best = d; }
        } catch(e) {}
      });
    } catch(e) {}
  }
  if (best) return best;
  return uin ? path.join(roots[0] || '', uin) : '';
}
let SELF_NAME = '';
function log(s){ try{ fs.appendFileSync(LOG, new Date().toISOString().slice(11,23) + ' ' + String(s) + '\n'); }catch(e){} }
// groupOwnerId is sometimes {uin,uid}; never stringify an object into "[object Object]"
function ownerIdOf(g){
  var v = g && g.groupOwnerId;
  if (v === undefined || v === null) return '0';
  if (typeof v === 'object') return String(v.uin || v.uid || v.userUin || 0);
  return String(v);
}

const pending = new Map();
const events = [];
let seq = 0;
let groups = [];

function chatWin(){
  var wins = BrowserWindow.getAllWindows();
  for (var i = 0; i < wins.length; i++) {
    var u = '';
    try { u = wins[i].webContents.getURL(); } catch(e) { continue; }
    if (/#\/main\/message/.test(u)) return wins[i];
  }
  return null;
}

function textOf(msg){
  var els = (msg && msg.elements) || (msg && msg.msgElements) || [];
  var parts = [];
  for (var i = 0; i < els.length; i++) {
    var e = els[i] || {};
    if (e.textElement && e.textElement.content != null) parts.push(e.textElement.content);
    else if (e.textElement && e.textElement.content === '') parts.push('');
    else if (e.elementType === 1 && typeof e.content === 'string') parts.push(e.content);
    else if (e.faceElement) parts.push('[face]');
    else if (e.picElement) parts.push('[image]');
    else if (e.marketFaceElement) parts.push('[marketface]');
    else if (e.pttElement) parts.push('[voice]');
    else if (e.videoElement) parts.push('[video]');
  }
  return parts.join('');
}

function normMsg(m){
  // Every message carries both ids for both ends; harvest them so a later
  // "send to 3931221806" can be resolved without asking the kernel.
  try {
    rememberUin(m.senderUin, m.senderUid);
    rememberUin(m.peerUin, m.peerUid);
  } catch(e) {}
  return {
    msgId: String(m.msgId || ''), msgSeq: String(m.msgSeq || ''),
    chatType: m.chatType, msgType: m.msgType, subMsgType: m.subMsgType, sendType: m.sendType,
    senderUin: String(m.senderUin || ''), peerUin: String(m.peerUin || ''),
    senderUid: m.senderUid || '', peerUid: m.peerUid || '',
    peerName: m.peerName || '', sendMemberName: m.sendMemberName || m.sendRemarkName || m.sendNickName || '',
    msgTime: Number(m.msgTime || 0), text: textOf(m)
  };
}

function onMain(env, data){
  if (!env) return;
  if (env.callbackId && pending.size) {
    try {
      if (!pending.has(env.callbackId)) log('MISS ' + String(env.callbackId).slice(0, 14) + ' have=' + Array.from(pending.keys()).map(function(k){return String(k).slice(0,14);}).join('|'));
    } catch(e) {}
  }
  if (env.callbackId && pending.has(env.callbackId)) {
    var r = pending.get(env.callbackId);
    pending.delete(env.callbackId);
    r(data);
    return;
  }
  var en = String(env.eventName || '');
  if (en.indexOf('emit') < 0) return;
  var payload = (data && data.payload) || data || {};
  var cmd = String((data && data.cmdName) || env.cmdName || '');
  if (cmd.indexOf('onProfileSimpleChanged') >= 0 && payload.profiles) {
    try {
      var pr = global.__wbProfiles || (global.__wbProfiles = {});
      Object.keys(payload.profiles).forEach(function(k){
        pr[k] = payload.profiles[k];
        var pf = pr[k] || {};
        var uin = String(pf.uin || (pf.coreInfo && pf.coreInfo.uin) || '');
        if (uin && Number(uin) === SELF_UIN && pf.coreInfo && pf.coreInfo.nick) SELF_NAME = pf.coreInfo.nick;
      });
      log('PROFILES n=' + Object.keys(pr).length + ' last=' + JSON.stringify(payload.profiles).slice(0, 200));
    } catch(e) { log('PROFILES-ERR ' + e.message); }
  }
  if (cmd.indexOf('onMemberListChange') >= 0 && payload.info) {
    try {
      var gi = payload.info, g = String(gi.groupCode || '');
      var store = global.__wbMembers || (global.__wbMembers = {});
      var bucket = store[g] || (store[g] = { order: [], info: {} });
      if (gi.infos) Object.keys(gi.infos).forEach(function(k){ bucket.info[k] = gi.infos[k]; });
      if (gi.ids) gi.ids.forEach(function(it){ if (it && it.uid && bucket.order.indexOf(it.uid) < 0) bucket.order.push(it.uid); });
      log('MEMBERS ' + g + ' ids=' + bucket.order.length + ' infos=' + Object.keys(bucket.info).length);
    } catch(e) { log('MEMBERS-ERR ' + e.message); }
  }
  if (cmd.indexOf('onGroupListUpdate') >= 0 && payload.groupList) {
    // partial updates arrive over time -> merge by group_id instead of replacing
    var gmap = {};
    groups.forEach(function(g){ gmap[g.group_id] = g; });
    payload.groupList.forEach(function(g){
      var id = String(g.groupCode || g.groupUin || '');
      if (!id) return;
      gmap[id] = { group_id: id, group_name: g.groupName || '',
        member_count: g.memberCount || 0, max_member_count: g.maxMember || 0,
        owner_id: ownerIdOf(g) };
    });
    groups = Object.keys(gmap).map(function(k){ return gmap[k]; });
    groupsAt = Date.now();
    log('GROUPS ' + groups.length + ' (+' + payload.groupList.length + ')');
  }
  try {
    var seenE = global.__wbEmitSeen || (global.__wbEmitSeen = {});
    if (cmd && cmd.indexOf('LogApi') < 0 && !seenE[cmd]) {
      seenE[cmd] = 1;
      var ks = '';
      try { ks = (payload && typeof payload === 'object') ? Object.keys(payload).join(',') : typeof payload; } catch(e) { ks = 'ERR'; }
      log('EMIT ' + cmd + ' [' + ks + ']');
    }
    if (/Member/i.test(cmd)) {
      log('MEMBER ' + cmd + ' ' + JSON.stringify(payload).slice(0, 1500));
    }
    if (/RichMedia|Upload|Pic/i.test(cmd)) {
      log('RICHDETAIL ' + cmd + ' ' + JSON.stringify(payload).slice(0, 3000));
    }
  } catch(e) { log('EMITLOG-ERR ' + e.message); }
  if (cmd.indexOf('onRecentContactListChangedVer2') >= 0 && payload.changedRecentContactLists) {
    try {
      var rc = global.__wbRecent || (global.__wbRecent = {});
      payload.changedRecentContactLists.forEach(function(b){
        (b.changedList || []).forEach(function(x){
          var k = String(x.peerUid);
          var before = rc[k];
          rc[k] = x;
          var beforeSeq = before ? Number(before.msgSeq || 0) : -1;
          var nowSeq = Number(x.msgSeq || 0);
          if (nowSeq > beforeSeq && Number(x.chatType) === 1) {
            setTimeout(function(){ fetchAndPush(Number(x.chatType), k, 6); }, 120);
          }
        });
      });
    } catch(e) { log('RECENT-ERR ' + e.message); }
  }
  var rec = { t: Date.now(), cmdName: cmd, raw: payload };
  if (/onRecv|MsgInfoListUpdate/i.test(cmd) && payload && payload.msgList) {
    if (!global.__wbMsgCmdSeen) global.__wbMsgCmdSeen = {};
    if (!global.__wbMsgCmdSeen[cmd]) { global.__wbMsgCmdSeen[cmd] = 1; log('MSGCMD ' + cmd + ' n=' + payload.msgList.length); }
    // one QQ message can surface in several onRecvActiveMsg events -> keep only first sighting
    var seen = global.__wbSeenMsg || (global.__wbSeenMsg = {});
    if (Object.keys(seen).length > 3000) global.__wbSeenMsg = seen = {};
    var fresh = [];
    payload.msgList.map(normMsg).forEach(function(m){
      var id = String(m.msgId || '');
      if (id && seen[id]) return;
      if (id) seen[id] = 1;
      fresh.push(m);
    });
    rec.messages = fresh;
    if (fresh.length) { try { pushMsgs(fresh); } catch(e) { log('PUSH-ERR ' + e.message); } }
  }
  events.push(rec);
  if (events.length > 4000) events.splice(0, 1500);
}


const WEBHOOK_FILE = path.join(__dirname, 'webhook.txt');
function webhookUrl(){
  try { if (CFG.webhook && /^https?:\/\//.test(CFG.webhook)) return CFG.webhook; } catch(e) {}
  try { var u = fs.readFileSync(WEBHOOK_FILE, 'utf8').trim(); return /^https?:\/\//.test(u) ? u : ''; } catch(e) { return ''; }
}
function mediaUrlFor(p){
  try {
    if (!p) return '';
    return 'http://127.0.0.1:' + (CFG.port || 3902) + '/media?path=' + encodeURIComponent(String(p));
  } catch(e) { return ''; }
}

function segmentsOf(m){
  var els = (m && m.elements) || (m && m.msgElements) || [];
  var out = [];
  for (var i = 0; i < els.length; i++) {
    var e = els[i] || {};
    var te = e.textElement, pe = e.picElement, re = e.replyElement, fe = e.faceElement, mf = e.marketFaceElement, ae = e.avRecordElement;
    if (te && te.content != null) {
      var c = String(te.content || '');
      if (Number(te.atType) === 2) {
        out.push({ type: 'at', data: { qq: String(te.atUid || te.atNtUid || ''), name: '' } });
        c = c.replace(/^@[^ ]+\s*/, '');
      }
      if (c) out.push({ type: 'text', data: { text: c } });
      continue;
    }
    if (pe) {
      var sp = String(pe.sourcePath || '');
      var seg = { type: 'image', data: { file: String(pe.fileName || ((pe.md5HexStr || '') + '.png')),
        sub_type: Number(pe.picType) === 2000 ? 1 : 0, file_size: String(pe.fileSize || '0') } };
      if (sp) seg.data.url = mediaUrlFor(sp);
      if (pe.summary) seg.data.summary = String(pe.summary);
      out.push(seg);
      continue;
    }
    if (mf) {
      var mu = String(mf.faceUrl || '');
      if (mu) out.push({ type: 'image', data: { file: 'mface', sub_type: 1, url: mu } });
      else out.push({ type: 'text', data: { text: '[表情]' } });
      continue;
    }
    if (fe) { out.push({ type: 'face', data: { id: String(fe.faceIndex || fe.faceId || 0) } }); continue; }
    if (re) { out.push({ type: 'reply', data: { id: String(re.sourceMsgIdInRecords || re.replayMsgSeq || '') } }); continue; }
    if (ae) { out.push({ type: 'text', data: { text: '[' + String(ae.text || '通话') + ']' } }); continue; }
    if (e.pttElement) { out.push({ type: 'record', data: { file: '', url: mediaUrlFor(e.pttElement.filePath || e.pttElement.sourcePath || '') } }); continue; }
    if (e.videoElement) { out.push({ type: 'video', data: { file: '', url: mediaUrlFor(e.videoElement.filePath || e.videoElement.sourcePath || '') } }); continue; }
    if (e.fileElement) { out.push({ type: 'file', data: { name: String(e.fileElement.fileName || ''), size: String(e.fileElement.fileSize || '0') } }); continue; }
    if (e.arkElement || e.structMsgElement) { out.push({ type: 'text', data: { text: '[卡片消息]' } }); continue; }
    // merged/forwarded chat records: the inner messages are only reachable through
    // resId, and downloading their media needs the OUTER peer context (see get_forward_msg)
    var mfe = e.multiForwardMsgElement || e.forwardElement;
    if (mfe) {
      out.push({ type: 'forward', data: {
        id: String(mfe.resId || mfe.msgId || mfe.forwardMsgId || ''),
        summary: String(mfe.fileName || mfe.summary || mfe.title || '[聊天记录]') } });
      continue;
    }
    if (e.multiMsgElement) {
      out.push({ type: 'forward', data: {
        id: String(e.multiMsgElement.resId || ''),
        summary: String(e.multiMsgElement.fileName || '[聊天记录]') } });
      continue;
    }
  }
  if (!out.length) out.push({ type: 'text', data: { text: String((m && m.text) || '') } });
  return out;
}

function toOneBot(m){
  var isGroup = Number(m.chatType) === 2;
  var gid = Number(m.peerUin || m.peerUid || 0) || 0;
  var uid = Number(m.senderUin || 0) || 0;
  return {
    post_type: 'message', message_type: isGroup ? 'group' : 'private', sub_type: 'normal',
    time: Math.floor(Number(m.msgTime || 0)) || Math.floor(Date.now()/1000),
    self_id: SELF_UIN, message_id: String(m.msgId || ''), msg_id_exact: String(m.msgId || ''),
    group_id: isGroup ? gid : 0, user_id: uid,
    message: segmentsOf(m),
    raw_message: String(m.text || ''), font: 0,
    message_seq: Number(m.msgSeq || 0) || 0,
    sender: { user_id: uid, nickname: m.sendMemberName || m.sendNickName || m.peerName || '', card: m.sendMemberName || '' }
  };
}
function postJson(u, obj){
  try {
    var b = Buffer.from(JSON.stringify(obj), 'utf8');
    var x = new URL(u);
    var mod = x.protocol === 'https:' ? require('https') : require('http');
    var r = mod.request({ hostname: x.hostname, port: x.port || (x.protocol === 'https:' ? 443 : 80),
      path: x.pathname + x.search, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length } },
      function(res){ res.resume(); });
    r.on('error', function(e){ log('HOOK-ERR ' + e.message); });
    r.write(b); r.end();
  } catch(e) { log('HOOK-EX ' + e.message); }
}
function pushMsgs(msgs){ var u = webhookUrl(); msgs.forEach(function(m){ var ev = toOneBot(m);
  try { if (u) postJson(u, ev); } catch(e) { log('HOOK-EX ' + (e && e.message)); }
  try { if (global.__wbWsClients && global.__wbWsClients.size) wsBroadcast(ev); } catch(e) { log('WS-PUSH-ERR ' + (e && e.message)); }
}); }


const seenCmds = {};
function noteCmd(name, payload){
  if (!name || seenCmds[name]) return;
  var keys = [];
  try { if (payload && payload[0] && typeof payload[0] === 'object') keys = Object.keys(payload[0]); } catch(e) {}
  seenCmds[name] = 1;
  log('CMD ' + name + ' [' + keys.join(',') + ']');
}
function wrapHandlers(){
  var ipc = require('electron').ipcMain;
  Object.keys(ipc._events).forEach(function(ch){
    if (ch.indexOf('RM_IPCFROM_RENDERER') !== 0) return;
    var cur = ipc._events[ch];
    var arr = Array.isArray(cur) ? cur : [cur];
    for (var i = 0; i < arr.length; i++) {
      var h = arr[i];
      if (typeof h !== 'function' || h.__wbWrapped) continue;
      var wrapper = (function(hh){ return function(ev, env, body){
        try {
          var nm = body && body.cmdName;
          if (nm && nm.indexOf('LogApi') < 0 && nm.indexOf('/log') < 0) noteCmd(nm, body.payload);
        } catch(e) {}
        return hh.apply(this, arguments);
      }; })(h);
      wrapper.__wbWrapped = 1;
      arr[i] = wrapper;
    }
  });
}

function patchOne(wc){
  if (!wc || typeof wc.send !== 'function') return;
  // QQ may swap webContents.send out from under us; keep OUR wrapper outermost
  var rec = wc.__wbWrap;
  if (rec && wc.send === rec.wrap) return;
  var cur = wc.send;
  var wrapper = function(ch){
    try {
      var dbg = global.__wbDbg || (global.__wbDbg = {});
      var key = String(ch) + '|' + ((arguments[1] && arguments[1].eventName) || '');
      if (!dbg[key] && Object.keys(dbg).length < 60) { dbg[key] = 1; log('WCSEND ' + key); }
      try { var cnt = global.__wbCnt || (global.__wbCnt = {}); cnt[key] = (cnt[key] || 0) + 1; } catch(e) {}
      if (typeof ch === 'string' && ch.indexOf('RM_IPCFROM_MAIN') === 0 && typeof global.__wbOnMain === 'function') {
        global.__wbOnMain(arguments[1], arguments[2]);
      }
    } catch(e) { log('PATCH-ERR ' + e.message); }
    return cur.apply(wc, arguments);
  };
  try {
    wc.send = wrapper;
    wc.__wbWrap = { inner: cur, wrap: wrapper };
    log('PATCHED wc=' + wc.id + (rec ? ' repatch' : ''));
  } catch(e) { log('PATCH-FAIL ' + e.message); }
}

// Generation guard: every load bumps __wbGen. A stale instance's timer clears itself
// on its next tick, so a reloaded engine cannot be shadowed by an old one re-pointing
// __wbOnMain at its own dead module.
const MYGEN = (global.__wbGen = Number(global.__wbGen || 0) + 1);

function patch(){
  if (global.__wbGen !== MYGEN) return;
  global.__wbOnMain = onMain;
  try {
    var ws = BrowserWindow.getAllWindows();
    for (var i = 0; i < ws.length; i++) patchOne(ws[i].webContents);
  } catch(e) {}
}

var myTimer = setInterval(function(){
  if (global.__wbGen !== MYGEN) { clearInterval(myTimer); return; }
  try { patch(); } catch(e) {}
}, 2000);
global.__wbTimer = myTimer;
patch();

// passive tap: append our own listener (public API) — never touch ipcMain._events
function installTap(){
  try {
    var ipc2 = require('electron').ipcMain;
    if (global.__wbTapFns) {
      global.__wbTapFns.forEach(function(f){ try { ipc2.removeListener(f.ch, f.fn); } catch(e) {} });
    }
    global.__wbTapFns = [];
    var chans = [];
    for (var i = 2; i <= 19; i++) chans.push(String(i));
    chans.forEach(function(n){
      var ch = 'RM_IPCFROM_RENDERER' + n;
      var fn = function(ev, env, body){
        try {
          var c = (body && body.cmdName) || '';
          if (!c || c.indexOf('log') >= 0) return;
          if (!env || env.eventName !== 'ntApi') return;
          var heavy = c.indexOf('nodeIKernelMsgService/sendMsg') === 0;
          log('TAP ' + c + ' ' + JSON.stringify(body.payload).slice(0, heavy ? 2600 : 300));
        } catch(e) {}
      };
      ipc2.on(ch, fn);
      global.__wbTapFns.push({ ch: ch, fn: fn });
    });
    log('TAP installed');
  } catch(e) { log('TAP-ERR ' + e.message); }
}
installTap();

function rpc(cmd, payload, evt, timeoutMs){
  var w = chatWin();
  if (!w) return Promise.reject(new Error('no chat window'));
  patch(w.webContents);
  var cid = w.webContents.id;
  seq++;
  var id = 'wb' + seq + '-' + Date.now();
  return new Promise(function(res){
    var timer = setTimeout(function(){ pending.delete(id); res({ ok: false, timeout: true }); }, timeoutMs || 8000);
    pending.set(id, function(data){ clearTimeout(timer); res({ ok: true, data: data }); });
    var env = { type: 'request', eventName: evt || 'ntApi', callbackId: id, peerId: cid };
    var body = { cmdName: cmd, cmdType: 'invoke', payload: payload };
    var code = 'ipcImpl.send(' + JSON.stringify('RM_IPCFROM_RENDERER' + cid) + ',' + JSON.stringify(env) + ',' + JSON.stringify(body) + ')';
    w.webContents.executeJavaScript(code, true).catch(function(e){
      clearTimeout(timer); pending.delete(id); res({ ok: false, error: String(e && e.message) });
    });
  });
}

function sendOney(chatType, peerUid, text, guildId){
  var p = [{
    peer: { chatType: Number(chatType), peerUid: String(peerUid), guildId: guildId || '' },
    msgElements: [{ elementType: 1, elementId: '', textElement: {
      content: String(text), atType: 0, atUid: '', atTinyId: '', atNtUid: ''
    } }],
    msgAttributeInfos: {}
  }];
  return rpc('nodeIKernelMsgService/sendMsg', p);
}

// ---- image support -------------------------------------------------------
function textElem(text){
  return { elementType: 1, elementId: '', textElement: {
    content: String(text), atType: 0, atUid: '', atTinyId: '', atNtUid: '' } };
}

// QQ only uploads a picture that already sits in its own cache under <md5>.<ext>,
// so we hash the file, drop a copy into nt_data\Pic\<ym>\Ori and point at it.
function imgElem(file){
  var fs2 = require('fs'), path2 = require('path'), crypto2 = require('crypto');
  var buf = fs2.readFileSync(file);
  var md5 = crypto2.createHash('md5').update(buf).digest('hex');
  var md5u = md5.toUpperCase();
  var ext = (path2.extname(file) || '.png').toLowerCase();
  if (ext === '.jpeg') ext = '.jpg';
  var name = md5u + ext;
  var d = new Date();
  var ym = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
  var ori = path2.join(DATA_DIR, 'nt_qq', 'nt_data', 'Pic', ym, 'Ori');
  var dest = path2.join(ori, name);
  try { fs2.mkdirSync(ori, { recursive: true }); } catch(e) {}
  try { if (!fs2.existsSync(dest)) fs2.writeFileSync(dest, buf); } catch(e) {}
  return { elementType: 2, elementId: '', picElement: {
    fileName: name, fileSize: String(buf.length), original: true, md5HexStr: md5,
    sourcePath: dest, thumbPath: {}, transferStatus: 0, picSubType: 0, picType: 1000,
    storeID: 1, fileUuid: '', fileSubId: '', thumbFileSize: 0 } };
}

function atElem(qq){
  var u = String(qq || '');
  return { elementType: 1, elementId: '', textElement: {
    content: '@' + u + ' ', atType: 2, atUid: u, atTinyId: '', atNtUid: '' } };
}

function faceElem(id){
  return { elementType: 6, elementId: '', faceElement: {
    faceIndex: Number(id) || 1, faceText: '', faceType: 1 } };
}

// ---- CQ code support -----------------------------------------------------
// OneBot v11 clients routinely hand us a string with [CQ:...] in it. Sending
// that verbatim just prints the brackets, so expand it into real elements.
function cqUnescape(s){
  return String(s)
    .replace(/&#44;/g, ',').replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']').replace(/&amp;/g, '&');
}

function parseCQText(s){
  var str = String(s), out = [], last = 0, m;
  var re = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g;
  while ((m = re.exec(str))) {
    if (m.index > last) out.push({ type: 'text', data: { text: cqUnescape(str.slice(last, m.index)) } });
    var kv = {}, parts = m[2] ? m[2].slice(1).split(',') : [];
    for (var j = 0; j < parts.length; j++) {
      var eq = parts[j].indexOf('=');
      if (eq > 0) kv[parts[j].slice(0, eq)] = cqUnescape(parts[j].slice(eq + 1));
    }
    out.push({ type: m[1], data: kv });
    last = re.lastIndex;
  }
  if (last < str.length) out.push({ type: 'text', data: { text: cqUnescape(str.slice(last)) } });
  return out.length ? out : [{ type: 'text', data: { text: str } }];
}

function isCQ(s){ return typeof s === 'string' && s.indexOf('[CQ:') >= 0; }

function segText(seg){
  if (!seg) return '';
  var d = seg.data || seg;
  return String(d.text != null ? d.text : (d.content != null ? d.content : ''));
}

function buildElems(msg){
  var out = [];
  if (typeof msg === 'string') msg = isCQ(msg) ? parseCQText(msg) : [{ type: 'text', data: { text: msg } }];
  if (Array.isArray(msg)) {
    msg.forEach(function(seg){
      if (!seg) return;
      if (seg.type === 'text') out.push(textElem(segText(seg)));
      else if (seg.type === 'at') out.push(atElem((seg.data && seg.data.qq) || seg.qq || ''));
      else if (seg.type === 'face') out.push(faceElem((seg.data && seg.data.id) || seg.id || 1));
      else if (seg.type === 'image') {
        var f = (seg.data && (seg.data.file || seg.data.path)) || seg.file || '';
        if (f) { try { out.push(imgElem(String(f))); } catch(e) { log('IMG-ELEM-ERR ' + (e && e.message)); } }
      }
    });
    return out;
  }
  out.push(textElem(String((msg && (msg.text != null ? msg.text : msg.content)) || '')));
  return out;
}

// picture sends go out with the [params, null] second slot QQ itself uses
function sendElems(chatType, peerUid, elems, guildId){
  var body = {
    peer: { chatType: Number(chatType), peerUid: String(peerUid), guildId: guildId || '' },
    msgElements: elems,
    msgAttributeInfos: {}
  };
  return rpc('nodeIKernelMsgService/sendMsg', [body, null], 'ntApi', 30000);
}

function flatMessage(msg){
  if (msg == null) return '';
  if (typeof msg === 'string') {
    if (!isCQ(msg)) return msg;
    return parseCQText(msg).map(function(seg){
      if (seg.type === 'text') return (seg.data && seg.data.text) || '';
      if (seg.type === 'face') return '[face]';
      if (seg.type === 'image') return '[image]';
      if (seg.type === 'at') return '@' + ((seg.data && seg.data.qq) || '') + ' ';
      return '';
    }).join('');
  }
  if (Array.isArray(msg)) {
    var s = '';
    msg.forEach(function(seg){
      if (!seg) return;
      if (seg.type === 'text') s += segText(seg);
      else if (seg.type === 'face') s += '[face]';
      else if (seg.type === 'image') s += '[image]';
      else if (seg.type === 'at') s += '@' + ((seg.data && seg.data.qq) || seg.qq || '') + ' ';
      else s += '';
    });
    return s;
  }
  if (typeof msg === 'object') return String(msg.text != null ? msg.text : (msg.content != null ? msg.content : ''));
  return String(msg);
}

// A message needs the element path (not the plain-text path) when it carries
// anything richer than a bare string: pictures, @, faces, or raw CQ codes.
function needsElems(msg){
  if (Array.isArray(msg)) {
    return msg.some(function(s){
      return s && (s.type === 'image' || s.type === 'at' || s.type === 'face');
    });
  }
  return isCQ(msg);
}

function body(req){
  return new Promise(function(res){
    var b = '';
    req.on('data', function(c){ b += c; if (b.length > 4e6) req.destroy(); });
    req.on('end', function(){ res(b); });
  });
}

// Some clients (notably Windows PowerShell 5.1 with -Body <hashtable>) send the
// payload form-encoded instead of JSON. Accept both so a caller never gets a
// silent "empty message".
function parseBody(raw, ctype){
  var s = String(raw || '');
  if (!s) return {};
  var ct = String(ctype || '').toLowerCase();
  if (ct.indexOf('json') < 0) {
    var t = s.replace(/^\s+/, '');
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') {
      try {
        var out = {}, sp = new URLSearchParams(s);
        sp.forEach(function(v, k){ out[k] = v; });
        if (Object.keys(out).length) return out;
      } catch(e) {}
    }
  }
  try { return JSON.parse(s); } catch(e) {}
  try {
    var o2 = {}, sp2 = new URLSearchParams(s);
    sp2.forEach(function(v, k){ o2[k] = v; });
    return o2;
  } catch(e) { return {}; }
}
function sendJson(res, code, obj){
  var s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}
function q(url, k){
  var m = url.match(new RegExp('[?&]' + k + '=([^&]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// uin -> uid. QQ addresses private chats by uid (u_xxx); callers usually only know
// the QQ number. Sources, in order: what we learned earlier (persisted next to the
// engine), the profile cache, every message we have seen (senderUin/senderUid,
// peerUin/peerUid), and finally the kernel itself.
const UINMAP_FILE = path.join(PKG, 'uin-uid.json');
function uinIndex(){
  var ix = global.__wbUinUid;
  if (ix) return ix;
  ix = global.__wbUinUid = {};
  try {
    var j = JSON.parse(fs.readFileSync(UINMAP_FILE, 'utf8'));
    Object.keys(j || {}).forEach(function(k){ if (typeof j[k] === 'string' && j[k].indexOf('u_') === 0) ix[k] = j[k]; });
  } catch(e) {}
  return ix;
}
var uinSaveTimer = null;
function rememberUin(uin, uid){
  var u = String(uin || ''), id = String(uid || '');
  if (!u || !id || id.indexOf('u_') !== 0) return;
  var ix = uinIndex();
  if (ix[u] === id) return;
  ix[u] = id;
  // coalesce writes; the map is small but this runs on every message
  if (uinSaveTimer) return;
  uinSaveTimer = setTimeout(function(){
    uinSaveTimer = null;
    try { fs.writeFileSync(UINMAP_FILE, JSON.stringify(uinIndex()), 'utf8'); } catch(e) {}
  }, 2000);
  if (uinSaveTimer.unref) uinSaveTimer.unref();
}
function uidOf(x){
  var v = String(x || '');
  if (v.indexOf('u_') === 0) return v;
  var ix = uinIndex();
  if (ix[v]) return ix[v];
  var pr = global.__wbProfiles || {};
  var ks = Object.keys(pr);
  for (var i = 0; i < ks.length; i++) {
    var pf = pr[ks[i]] || {};
    var uin = String(pf.uin || (pf.coreInfo && pf.coreInfo.uin) || '');
    if (uin && uin === v) { rememberUin(v, ks[i]); return ks[i]; }
  }
  return v;
}
// Ask the kernel. getUidByUins is the group service's batch form; it only knows
// people we share a group with, so this is a best-effort last resort.
async function uidOfAsync(x){
  var v = String(x || '');
  if (v.indexOf('u_') === 0) return v;
  var direct = uidOf(v);
  if (direct.indexOf('u_') === 0) return direct;
  try {
    var r = await rpc('nodeIKernelGroupService/getUidByUins', [[v]], 'ntApi', 6000);
    var res = (r && r.data && (r.data.result || r.data)) || {};
    var uids = res.uids || res;
    var got = uids && (uids[v] || (Array.isArray(uids) ? uids[0] : ''));
    if (typeof got === 'string' && got.indexOf('u_') === 0) { rememberUin(v, got); return got; }
  } catch(e) {}
  return '';
}

var groupsAt = 0;
function ensureGroups(){
  if (groups.length && Date.now() - groupsAt < 60000) return Promise.resolve(groups);
  return rpc('nodeIKernelGroupService/getGroupList', [{ forceUpdate: true }]).then(function(){
    return new Promise(function(r){ setTimeout(function(){ groupsAt = Date.now(); r(groups); }, 900); });
  }).catch(function(){ return groups; });
}

// 昵称只有在 profile 推送里出现才拿得到；懒加载：借任意一个群的成员列表触发 profile 查询
function ensureSelfName(){
  if (SELF_NAME) return Promise.resolve(SELF_NAME);
  return ensureGroups().then(function(gs){
    if (!gs.length) return SELF_NAME;
    return rpc('nodeIKernelGroupService/getAllMemberList', [{ groupCode: String(gs[0].group_id), forceUpdate: false }]).then(function(r1){
      var ids = (((r1 || {}).data || {}).result || {}).ids || [];
      var uids = ids.map(function(x){ return x && (x.uid || x); }).filter(Boolean);
      if (!uids.length) return SELF_NAME;
      return rpc('nodeIKernelProfileService/getUserSimpleInfo', [{ uids: uids.slice(0, 200) }]).then(function(){
        return new Promise(function(r){ setTimeout(function(){ r(SELF_NAME); }, 900); });
      });
    });
  }).catch(function(){ return SELF_NAME; });
}

var server = http.createServer(async function(req, res){
  var url = req.url.split('?')[0];
  var started = Date.now();
  try {
    if (req.method === 'OPTIONS') { sendJson(res, 200, '{}'); return; }
    var d = {};
    if (req.method === 'POST') { try { d = parseBody(await body(req), req.headers['content-type']); } catch(e) { d = {}; } }
    if (url === '/ws-test') {
      var qs2 = require('url').parse(req.url, true).query || {};
      var mt = String(qs2.message_type || 'group');
      var n2 = wsBroadcast({ post_type: 'message', message_type: mt, sub_type: mt === 'group' ? 'normal' : 'friend',
        time: Math.floor(Date.now() / 1000), self_id: SELF_UIN, message_id: 'wbtest-' + Date.now(),
        group_id: mt === 'group' ? Number(qs2.group_id || SELF_UIN) : undefined, user_id: Number(qs2.user_id || SELF_UIN),
        message: [{ type: 'text', data: { text: String(qs2.text || 'ws-test') } }],
        raw_message: String(qs2.text || 'ws-test'), font: 0, message_seq: 1,
        sender: { user_id: Number(qs2.user_id || SELF_UIN), nickname: String(qs2.nick || 'whalebridge'), card: '' } });
      return sendJson(res, 200, { ok: true, sent: n2, clients: WS_CLIENTS.size });
    }
    if (url === '/media') {
      try {
        var qs = require('url').parse(req.url, true).query || {};
        var fp = String(qs.path || '');
        var pmod = require('path');
        var abs = pmod.resolve(fp);
        var roots = [DATA_DIR, path.join(PKG, 'media-tmp')];
        var okRoot = false;
        for (var ri = 0; ri < roots.length; ri++) {
          try { if (abs.toLowerCase().indexOf(pmod.resolve(roots[ri]).toLowerCase()) === 0) { okRoot = true; break; } } catch(e) {}
        }
        if (!okRoot) { res.writeHead(403); res.end('forbidden'); return; }
        var buf = fs.readFileSync(abs);
        var ext = (pmod.extname(abs) || '').toLowerCase();
        var mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
          : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp'
          : (ext === '.amr' || ext === '.silk') ? 'audio/amr' : ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        res.end(buf);
      } catch(e) { res.writeHead(404); res.end('not found'); }
      return;
    }
    if (url === '/debug-send') {
      var wins = [];
      try {
        BrowserWindow.getAllWindows().forEach(function(w){
          var wc = w.webContents;
          wins.push({ id: wc.id, url: String(w.webContents.getURL()).slice(0, 40),
            wrapped: !!(wc.__wbWrap && wc.send === wc.__wbWrap.wrap),
            hasWrap: !!wc.__wbWrap, sendName: String(wc.send && wc.send.name || '') });
        });
      } catch(e) { wins.push({ err: String(e && e.message) }); }
      return sendJson(res, 200, { ok: true, gen: global.__wbGen, mine: MYGEN,
        cb: typeof global.__wbOnMain, cnt: global.__wbCnt || {}, wins: wins,
        recent: events.slice(-3).map(function(e){ return e.cmdName; }) });
    }
    var w = chatWin();
    if (w) patch(w.webContents);

    if (url === '/debug-profiles') {      var pr2 = global.__wbProfiles || {};
      var ks = Object.keys(pr2).slice(0, 3);
      var sample = {};
      ks.forEach(function(k){ sample[k] = pr2[k]; });
      return sendJson(res, 200, { ok: true, n: Object.keys(pr2).length, sample: sample });
    }
    if (url === '/send_private_msg') {
      var target = d.user_id || d.user || d.peerUid || d.uid;
      var srcPriv = d.message !== undefined ? d.message : d.text;
      var txt = flatMessage(srcPriv);
      var privRich = needsElems(srcPriv);
      if (!txt && !privRich) return sendJson(res, 200, { status: 'failed', retcode: 100, msg: 'empty message' });
      var pu = await uidOfAsync(target);
      if (String(pu).indexOf('u_') !== 0) {
        return sendJson(res, 200, { status: 'failed', retcode: 100,
          msg: 'cannot resolve ' + target + ' to a uid; send any message to/from that QQ number once so the mapping is learned' });
      }
      var rr;
      if (privRich) {
        var pe = [];
        try { pe = buildElems(srcPriv); } catch(e) { log('IMG-ERR ' + (e && e.message)); }
        rr = pe.length ? await sendElems(1, pu, pe, '') : await sendOney(1, pu, txt, '');
      } else {
        rr = await sendOney(1, pu, txt, '');
      }
      var hasPic2 = Array.isArray(srcPriv) && srcPriv.some(function(s){ return s && s.type === 'image'; });
      var ok = !!(rr.data && rr.data.result === 0) || (hasPic2 && !!rr.timeout);
      log('SEND-PRIV to=' + pu + ' ok=' + ok + ' rich=' + privRich);
      return sendJson(res, 200, { status: ok ? 'ok' : 'failed', retcode: ok ? 0 : 100,
        data: { message_id: String(Date.now()), peerUid: pu }, result: (rr || {}).data || rr, timeout: !!(rr && rr.timeout) });
    }
    if (url === '/get_group_member_list') {
      var gid = String(d.group_id || d.group || '');
      var r1 = await rpc('nodeIKernelGroupService/getAllMemberList', [{ groupCode: gid, forceUpdate: false }]);
      var ids = (((r1 || {}).data || {}).result || {}).ids || [];
      var uids = ids.map(function(x){ return x && (x.uid || x); }).filter(Boolean);
      if (uids.length) {
        await rpc('nodeIKernelProfileService/getUserSimpleInfo', [{ uids: uids.slice(0, 200) }]);
        await new Promise(function(r){ setTimeout(r, 900); });
      }
      var prof = global.__wbProfiles || {};
      var arr = uids.map(function(u){
        var pf = prof[u] || {};
        var nick = pf.nick || pf.nickName || pf.coreInfo && pf.coreInfo.nick || '';
        var card = pf.cardName || pf.card || pf.remark || '';
        var uin = String(pf.uin || pf.coreInfo && pf.coreInfo.uin || 0);
        return { group_id: Number(gid) || gid, user_id: Number(uin) || 0, nickname: nick, card: card, uid: u };
      });
      return sendJson(res, 200, { status: 'ok', retcode: 0, data: arr });
    }
    if (url === '/debug-recent') {
      var rc2 = global.__wbRecent || {};
      var list = Object.keys(rc2).map(function(k){
        var x = rc2[k];
        return { chatType: x.chatType, peerUid: k, peerUin: String(x.peerUin || ''), peerName: x.peerName || '', msgSeq: String(x.msgSeq || '') };
      });
      return sendJson(res, 200, { ok: true, list: list });
    }
    if (url === '/debug-members') {
      var st = global.__wbMembers || {};
      var g2 = '';
      try { g2 = new URL('http://x' + req.url).searchParams.get('gid') || ''; } catch(e) {}
      var b2 = st[g2] || { order: [], info: {} };
      return sendJson(res, 200, { ok: true, gid: g2, count: b2.order.length,
        members: b2.order.map(function(u){ var i = b2.info[u] || {}; return { uid: u, nick: i.nick || i.nickName || '', card: i.cardName || i.card || '', uin: String(i.uin || '') }; }) });
    }
    if (url === '/debug-ipc') {
      var ipc = require('electron').ipcMain;
      var out = {};
      Object.keys(ipc._events).forEach(function(ch){
        var cur = ipc._events[ch];
        var arr = Array.isArray(cur) ? cur : [cur];
        out[ch] = arr.map(function(f){
          var t = '';
          try { t = String(f).slice(0, 40); } catch(e) {}
          return { wrapped: !!(f && f.__wbWrapped), t: t };
        });
      });
      return sendJson(res, 200, { ok: true, channels: out });
    }
    if (url === '/dragimg') {
      var _w = null;
      try {
        var _ws2 = BrowserWindow.getAllWindows();
        for (var _j = 0; _j < _ws2.length; _j++) { if (String(d.wc) && _ws2[_j].webContents.id === Number(d.wc)) _w = _ws2[_j]; }
        if (!_w) _w = chatWin();
      } catch(e) {}
      if (!_w) return sendJson(res, 200, { ok: false, err: 'no window' });
      var _wc3 = _w.webContents;
      (async function(){
        var steps = [];
        try {
          var rect = await _wc3.executeJavaScript("(function(){var e=document.querySelector('.ExEditor-qq-msg-editor'); if(!e) return null; var r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};})()", true);
          steps.push({ rect: rect });
          if (!rect || !rect.w) return sendJson(res, 200, { ok: false, err: 'editor not laid out', steps: steps });
          var cx = Math.round(rect.x + rect.w / 2), cy = Math.round(rect.y + rect.h / 2);
          try { _wc3.debugger.attach('1.3'); } catch(e) { steps.push({ attach: String(e && e.message) }); }
          var data = { items: [{ mimeType: 'image/png', data: '' }], files: [String(d.path)], dragOperationsMask: 1 };
          var types = ['dragEnter', 'dragOver', 'drop'];
          for (var i = 0; i < types.length; i++) {
            await _wc3.debugger.sendCommand('Input.dispatchDragEvent', { type: types[i], x: cx, y: cy, data: data });
            steps.push({ sent: types[i] });
            await new Promise(function(r){ setTimeout(r, 300); });
          }
          await new Promise(function(r){ setTimeout(r, 1200); });
          var after = await _wc3.executeJavaScript("(function(){var e=document.querySelector('.ExEditor-qq-msg-editor'); return e?{cls:e.className, html:e.innerHTML.slice(-400)}:{err:'no editor'};})()", true);
          steps.push({ after: after });
          return sendJson(res, 200, { ok: true, steps: steps });
        } catch(e) {
          return sendJson(res, 200, { ok: false, err: String(e && e.message || e), steps: steps });
        }
      })();
      return;
    }
    if (url === '/main') {
      try {
        var _fn = new Function('d', 'require', String((d || {}).code || ''));
        var _out = _fn(d, require);
        return sendJson(res, 200, { ok: true, result: _out === undefined ? null : _out });
      } catch(e) {
        return sendJson(res, 200, { ok: false, err: String(e && e.message || e) });
      }
    }
    if (url === '/eval') {
      var _o = d || {};
      var _t = null;
      try {
        var _all = BrowserWindow.getAllWindows();
        for (var _i = 0; _i < _all.length; _i++) {
          if (String(_o.wc) && _all[_i].webContents.id === Number(_o.wc)) _t = _all[_i];
        }
        if (!_t) _t = chatWin();
      } catch(e) {}
      if (!_t) return sendJson(res, 200, { ok: false, err: 'no window' });
      _t.webContents.executeJavaScript(String(_o.code || ''), true)
        .then(function(v){ sendJson(res, 200, { ok: true, wc: _t.webContents.id, result: v }); },
              function(e){ sendJson(res, 200, { ok: false, err: String(e && e.message || e) }); });
      return;
    }
    if (url === '/debug-dom') {
      var w2 = chatWin();
      if (!w2) return sendJson(res, 200, { ok: false, err: 'no chat window' });
      w2.webContents.executeJavaScript('document.body.innerText.slice(-1500)', true)
        .then(function(v){ sendJson(res, 200, { ok: true, tail: v }); }, function(e){ sendJson(res, 200, { ok: false, err: String(e) }); });
      return;
    }
    if (url === '/debug-wins') {
      var ws = BrowserWindow.getAllWindows();
      var out = [];
      var pendingN = ws.length;
      return Promise.all(ws.map(function(w){
        var rec = { id: w.webContents.id, url: '' };
        try { rec.url = w.webContents.getURL(); } catch(e) {}
        return w.webContents.executeJavaScript('(function(){try{return {ipcImpl: typeof ipcImpl, ipcRenderer: typeof ipcRenderer, cid: window.webContentId, uin: window.uin};}catch(e){return {err: String(e)}}})()', true)
          .then(function(v){ rec.probe = v; return rec; }, function(e){ rec.err = String(e && e.message); return rec; });
      })).then(function(list){ sendJson(res, 200, { ok: true, wins: list }); });
    }
    if (url === '/cmdlist') { return sendJson(res, 200, { ok: true, cmds: Object.keys(seenCmds) }); }
    if (url === '/ws-status') { return sendJson(res, 200, { ok: true, clients: (global.__wbWsClients ? global.__wbWsClients.size : 0), gen: MYGEN }); }
    if (url === '/health' || url === '/get_status') {
      if (!SELF_NAME && !global.__wbSelfWarm) { global.__wbSelfWarm = 1; ensureSelfName(); }
      return sendJson(res, 200, { ok: true, service: 'wb-engine', pid: process.pid, online: !!w,
        win: !!w, events: events.length, groups: groups.length, self: { user_id: SELF_UIN, nickname: SELF_NAME } });
    }
    if (url === '/get_login_info') {
      if (!SELF_NAME) await ensureSelfName();
      return sendJson(res, 200, { status: 'ok', retcode: 0, data: { user_id: SELF_UIN, nickname: SELF_NAME } });
    }
    if (url === '/get_version_info') {
      return sendJson(res, 200, { status: 'ok', retcode: 0, data: { app_name: 'whalebridge', app_version: '0.1.0', protocol_version: 'v11' } });
    }
    if (url === '/get_forward_msg') {
      var fid2 = String(d.id || d.message_id || d.resId || '');
      var g8 = String(d.group_id || d.user_id || '');
      var ct8 = d.group_id ? 2 : 1;
      var peer8 = { chatType: ct8, peerUid: g8, guildId: '' };
      if (!fid2) return sendJson(res, 200, { status: 'failed', retcode: 100, msg: 'missing id' });
      var tries2 = [[peer8, fid2, fid2], [peer8, '0', fid2], [fid2, peer8, 0]];
      for (var tj = 0; tj < tries2.length; tj++) {
        var rj = await rpc('nodeIKernelMsgService/getMultiMsg', tries2[tj], 'ntApi', 8000);
        var rj2 = (rj && rj.data) || {};
        var ml3 = rj2.msgList || (rj2.result && rj2.result.msgList) || [];
        if (ml3.length) return sendJson(res, 200, { status: 'ok', retcode: 0, data: { messages: ml3.map(function (m) { return toOneBot(m); }) } });
      }
      return sendJson(res, 200, { status: 'failed', retcode: 1404, msg: 'forward message not found' });
    }
    if (url === '/get_group_list') {
      var gs = await ensureGroups();
      return sendJson(res, 200, { status: 'ok', retcode: 0, data: gs });
    }
    if (url === '/get_friend_list') {
      var r0 = await rpc('nodeIKernelBuddyService/getBuddyList', [{ force: false, sortField: 0 }]);
      var list = (r0.data && (r0.data.data || r0.data.buddyList)) || [];
      var out = [];
      (function walk(a){
        if (!Array.isArray(a)) return;
        a.forEach(function(x){
          if (x && (x.categoryId !== undefined || x.buddyList)) { walk(x.buddyList); return; }
          if (x && (x.uid || x.uin)) out.push({ user_id: Number(x.uin || 0), nickname: x.nick || x.remark || x.nickname || '', remark: x.remark || '' });
        });
      })(list);
      return sendJson(res, 200, { status: 'ok', retcode: 0, data: out });
    }
    if (url === '/get_group_member_list') {
      var gid = d.group_id || q(req.url, 'group_id');
      var r1 = await rpc('nodeIKernelGroupService/getGroupMemberList', [{ groupCode: String(gid), forceUpdate: false }], 'ntApi', 10000);
      var mi = (r1.data && (r1.data.memberInfo || r1.data.members)) || [];
      var mem = mi.map(function(m){
        return { group_id: Number(gid), user_id: Number(m.uin || 0), nickname: m.nick || m.cardName || '',
          card: m.cardName || '', role: m.memberRole === 4 ? 'owner' : (m.memberRole === 3 ? 'admin' : 'member') };
      });
      return sendJson(res, 200, { status: 'ok', retcode: 0, data: mem });
    }
    if (url === '/send_group_msg' || url === '/send_private_msg' || url === '/send_msg') {
      var type = d.message_type || (url === '/send_group_msg' ? 'group' : (url === '/send_private_msg' ? 'private' : ''));
      var target = url === '/send_group_msg' ? d.group_id : (url === '/send_private_msg' ? d.user_id : (type === 'group' ? d.group_id : d.user_id));
      target = target || d.group_id || d.user_id || q(req.url, 'group_id') || q(req.url, 'user_id');
      var srcMsg = d.message !== undefined ? d.message : d.text;
      var text = flatMessage(srcMsg);
      var chatType = type === 'private' ? 1 : 2;
      if (chatType === 1) {
        // private chats are addressed by uid; callers give us a QQ number
        var pu2 = await uidOfAsync(target);
        if (String(pu2).indexOf('u_') !== 0) {
          return sendJson(res, 200, { status: 'failed', retcode: 100,
            msg: 'cannot resolve ' + target + ' to a uid; send any message to/from that QQ number once so the mapping is learned' });
        }
        target = pu2;
      }
      var rich = needsElems(srcMsg);
      var hasPic = Array.isArray(srcMsg) && srcMsg.some(function(s){ return s && s.type === 'image'; });
      if (!text && !rich) return sendJson(res, 200, { status: 'failed', retcode: 100, msg: 'empty message' });
      var r;
      if (rich) {
        var elems = [];
        try { elems = buildElems(srcMsg); } catch(e) { log('IMG-ERR ' + (e && e.message)); }
        r = elems.length ? await sendElems(chatType, target, elems) : await sendOney(chatType, target, text);
      } else {
        r = await sendOney(chatType, target, text);
      }
      // picture sends routinely outlive the reply (upload runs async): timeout still means delivered
      var ok = !!(r.data && r.data.result === 0) || (hasPic && !!r.timeout);
      log('SEND ct=' + chatType + ' to=' + target + ' ok=' + ok + ' rich=' + rich + ' pic=' + hasPic + ' len=' + text.length);
      return sendJson(res, 200, { status: ok ? 'ok' : 'failed', retcode: ok ? 0 : 100, data: { message_id: String(Date.now()) },
        result: r.data, timeout: !!r.timeout });
    }
    if (url === '/send') {
      var r2 = await sendOney(d.chatType || 2, d.peerUid, d.text || '', d.guildId || '');
      return sendJson(res, 200, { ok: !!(r2.data && r2.data.result === 0), result: r2.data });
    }
    if (url === '/rpc') {
      var r3 = await rpc(d.cmd, d.payload || [], d.eventName, d.timeoutMs);
      return sendJson(res, 200, { ok: r3.data !== undefined, result: r3.data, timeout: !!r3.timeout });
    }
    if (url === '/events') {
      var since = Number(q(req.url, 'since') || 0) || 0;
      var only = q(req.url, 'only');
      var ev = events.filter(function(e){ return e.t > since && (!only || e.cmdName.indexOf(only) >= 0); });
      return sendJson(res, 200, { ok: true, count: ev.length, events: ev });
    }
    if (url === '/messages') {
      var since2 = Number(q(req.url, 'since') || 0) || 0;
      var ms = [];
      events.forEach(function(e){ if (e.messages && e.t > since2) e.messages.forEach(function(m){ ms.push(m); }); });
      return sendJson(res, 200, { ok: true, count: ms.length, messages: ms });
    }
    sendJson(res, 404, { status: 'failed', retcode: 404, error: 'not found' });
  } catch (e) {
    log('ERR ' + url + ' ' + (e && e.message));
    sendJson(res, 500, { status: 'failed', retcode: 500, error: String(e && e.message) });
  }
});


// ================= WB_WS_LAYER: OneBot v11 WebSocket (same port as HTTP) =================
const cryptoMod = require('crypto');
const WS_CLIENTS = (global.__wbWsClients = global.__wbWsClients || new Set());

function wsAccept(key) {
  return cryptoMod.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function wsFrame(op, buf) {
  var len = buf.length, h;
  if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
  else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  h[0] = 0x80 | op;
  return Buffer.concat([h, buf]);
}
function wsSend(rec, obj) {
  try {
    if (rec.dead) return false;
    rec.sock.write(wsFrame(1, Buffer.from(JSON.stringify(obj), 'utf8')));
    return true;
  } catch (e) { rec.dead = 1; return false; }
}
function wsBroadcast(obj) {
  var n = 0;
  WS_CLIENTS.forEach(function (rec) { if (wsSend(rec, obj)) n++; });
  return n;
}
function wsToken() {
  try { if (CFG.ws_token) return String(CFG.ws_token).trim(); } catch (e) {}
  try { return fs.readFileSync(path.join(__dirname, 'ws_token.txt'), 'utf8').trim(); } catch (e) { return ''; }
}
function wsFeed(rec, chunk) {
  rec.buf = Buffer.concat([rec.buf, chunk]);
  while (true) {
    var b = rec.buf;
    if (b.length < 2) return;
    var op = b[0] & 0x0f;
    var masked = (b[1] & 0x80) !== 0;
    var len = b[1] & 0x7f;
    var off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    var need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return;
    var mask = masked ? b.slice(off, off + 4) : null;
    var data = b.slice(off + (masked ? 4 : 0), need);
    if (mask) { var c = Buffer.allocUnsafe(len); for (var i = 0; i < len; i++) c[i] = data[i] ^ mask[i & 3]; data = c; }
    rec.buf = b.slice(need);
    if (op === 0x8) { try { rec.sock.end(); } catch (e) {} rec.dead = 1; return; }
    if (op === 0x9) { try { rec.sock.write(wsFrame(0xA, data)); } catch (e) {} continue; }
    if (op === 0x1 || op === 0x2) { try { wsOnText(rec, data.toString('utf8')); } catch (e) { log('WS-MSG-ERR ' + (e && e.message)); } }
  }
}
function wsOnText(rec, txt) {
  var m;
  try { m = JSON.parse(txt); } catch (e) { return; }
  var action = String((m && m.action) || '');
  var params = (m && m.params && typeof m.params === 'object') ? m.params : {};
  if (!action) { wsSend(rec, { status: 'failed', retcode: 1400, data: null, echo: m && m.echo, error: 'no action' }); return; }
  handleAction(action, params).then(function (d) {
    var rc = (d && d.retcode !== undefined) ? d.retcode : 0;
    wsSend(rec, { status: rc === 0 ? 'ok' : 'failed', retcode: rc, data: (d && d.data !== undefined) ? d.data : null,
      echo: (m && m.echo !== undefined) ? m.echo : null, error: (d && d.error) || undefined });
  }, function (e) {
    wsSend(rec, { status: 'failed', retcode: 100, data: null, echo: (m && m.echo !== undefined) ? m.echo : null, error: String(e && e.message || e) });
  });
}
async function fetchAndPush(chatType, peerUid, cnt){
  try {
    var r = await rpc('nodeIKernelMsgService/getMsgsIncludeSelf', [{ peer: { chatType: chatType, peerUid: String(peerUid), guildId: '' }, msgId: '0', cnt: Math.min(Number(cnt) || 6, 8), queryOrder: true }]);
    var ml = (((r || {}).data || {}).msgList) || [];
    var seen = global.__wbSeenMsg || (global.__wbSeenMsg = {});
    var fresh = [];
    ml.map(normMsg).forEach(function(m){
      var id = String(m.msgId || '');
      if (id && seen[id]) return;
      if (id) seen[id] = 1;
      fresh.push(m);
    });
    if (fresh.length) { log('RC-FETCH ct=' + chatType + ' peer=' + String(peerUid).slice(0, 14) + ' n=' + fresh.length); pushMsgs(fresh); }
  } catch(e) { log('RC-FETCH-ERR ' + (e && e.message)); }
}

global.__wbFetchAndPush = fetchAndPush;

async function fetchRecent(chatType, peerUid, cnt){
  var out = [], cursor = '0', guard = 0;
  while (out.length < cnt && guard++ < 6) {
    var take = Math.min(8, cnt - out.length);
    var r = await rpc('nodeIKernelMsgService/getMsgsIncludeSelf', [{ peer: { chatType: chatType, peerUid: String(peerUid), guildId: '' }, msgId: cursor, cnt: take, queryOrder: true }]);
    var ml = (((r || {}).data || {}).msgList) || [];
    if (!ml.length) break;
    for (var i = 0; i < ml.length; i++) {
      var id = String(ml[i].msgId || '');
      var dup = false;
      for (var j = 0; j < out.length; j++) if (String(out[j].msgId) === id) { dup = true; break; }
      if (!dup) out.push(ml[i]);
    }
    if (ml.length < take) break;
    cursor = String(ml[ml.length - 1].msgId || '');
    if (!cursor || cursor === '0') break;
  }
  out.sort(function(a, b){ return Number(a.msgSeq || 0) - Number(b.msgSeq || 0); });
  return out.slice(-cnt);
}

async function fetchById(chatType, peerUid, msgId){
  try {
    var r = await rpc('nodeIKernelMsgService/getMsgsIncludeSelf', [{ peer: { chatType: chatType, peerUid: String(peerUid), guildId: '' }, msgId: String(msgId), cnt: 1, queryOrder: true }]);
    var ml = (((r || {}).data || {}).msgList) || [];
    for (var i = 0; i < ml.length; i++) if (String(ml[i].msgId) === String(msgId)) return ml[i];
    return ml[0] || null;
  } catch(e) { return null; }
}

async function handleAction(action, p) {
  p = p || {};
  if (action === 'send_group_msg' || action === 'send_private_msg' || action === 'send_msg') {
    var type = action === 'send_group_msg' ? 'group' : (action === 'send_private_msg' ? 'private' : (p.message_type || 'group'));
    var target = type === 'group' ? (p.group_id || p.user_id) : (p.user_id || p.group_id);
    var srcMsg = p.message !== undefined ? p.message : p.text;
    var text = flatMessage(srcMsg);
    var chatType = type === 'private' ? 1 : 2;
    if (chatType === 1) {
      var pu3 = await uidOfAsync(target);
      if (String(pu3).indexOf('u_') !== 0) {
        return { retcode: 100, data: null,
          wording: 'cannot resolve ' + target + ' to a uid; send any message to/from that QQ number once so the mapping is learned' };
      }
      target = pu3;
    }
    var rich = needsElems(srcMsg);
    var hasPic = Array.isArray(srcMsg) && srcMsg.some(function (s) { return s && s.type === 'image'; });
    if (!text && !rich) return { retcode: 100, data: null, wording: 'empty message' };
    var r;
    if (rich) {
      var elems = [];
      try { elems = buildElems(srcMsg); } catch (e) { log('WS-IMG-ERR ' + (e && e.message)); }
      r = elems.length ? await sendElems(chatType, target, elems) : await sendOney(chatType, target, text);
    } else {
      r = await sendOney(chatType, target, text);
    }
    var ok = !!(r.data && r.data.result === 0) || (hasPic && !!r.timeout);
    log('WS-SEND ct=' + chatType + ' to=' + target + ' ok=' + ok + ' rich=' + rich + ' pic=' + hasPic);
    return { retcode: ok ? 0 : 100, data: { message_id: ok ? String(Date.now()) : 0, result: r.data } };
  }
  if (action === 'get_login_info') { if (!SELF_NAME) await ensureSelfName(); return { retcode: 0, data: { user_id: SELF_UIN, nickname: SELF_NAME } }; }
  if (action === 'get_status') { return { retcode: 0, data: { online: !!chatWin(), good: !!chatWin() } }; }
  if (action === 'get_version_info') { return { retcode: 0, data: { app_name: 'whalebridge', app_version: '0.1.0', protocol_version: 'v11' } }; }
  if (action === 'get_group_list') { return { retcode: 0, data: await ensureGroups() }; }
  if (action === 'get_recent_messages' || action === 'get_group_msg_history' || action === 'get_friend_msg_history') {
    var g2 = String(p.group_id || p.user_id || p.peer || '');
    var ct2 = (action === 'get_friend_msg_history' || p.message_type === 'private') ? 1 : 2;
    var want = Math.max(1, Math.min(Number(p.count || p.cnt || 20), 40));
    var ms = await fetchRecent(ct2, g2, want);
    return { retcode: 0, data: ms.map(function(m){ return toOneBot(m); }) };
  }
  if (action === 'get_msg') {
    var mid = String(p.message_id || p.msg_id || '');
    var g5 = String(p.group_id || p.user_id || '');
    var ct5 = p.group_id ? 2 : 1;
    var one = await fetchById(ct5, g5, mid);
    if (!one) return { retcode: 1404, data: null, wording: 'message not found' };
    return { retcode: 0, data: toOneBot(one) };
  }
  if (action === 'get_forward_msg') {
    var fid = String(p.id || p.message_id || p.resId || '');
    var g7 = String(p.group_id || p.user_id || '');
    var ct7 = p.group_id ? 2 : 1;
    var peer7 = { chatType: ct7, peerUid: g7, guildId: '' };
    if (!fid) return { retcode: 100, data: null, wording: 'missing id' };
    // getMultiMsg asserts on 3 arguments; the exact slot order is unverified,
    // so try the plausible shapes until one returns a msgList.
    var tries = [[peer7, fid, fid], [peer7, '0', fid], [fid, peer7, 0]];
    for (var ti = 0; ti < tries.length; ti++) {
      var rr = await rpc('nodeIKernelMsgService/getMultiMsg', tries[ti], 'ntApi', 8000);
      var res = (rr && rr.data) || {};
      var ml2 = res.msgList || (res.result && res.result.msgList) || [];
      if (ml2.length) {
        return { retcode: 0, data: { messages: ml2.map(function (m) { return toOneBot(m); }) } };
      }
    }
    return { retcode: 1404, data: null, wording: 'forward message not found' };
  }
  if (action === 'get_group_info') {
    var g6 = String(p.group_id || '');
    if (!groups || !groups.length) { try { await ensureGroups(); } catch(e) {} }
    var gi = null;
    for (var gi2 = 0; gi2 < groups.length; gi2++) if (String(groups[gi2].group_id) === g6) gi = groups[gi2];
    if (!gi) return { retcode: 1404, data: null, wording: 'group not found' };
    return { retcode: 0, data: { group_id: Number(gi.group_id) || g6, group_name: gi.group_name || '',
      member_count: Number(gi.member_count || 0), max_member_count: Number(gi.max_member_count || 0) } };
  }
  if (action === 'get_group_member_list') {
    var gid = String(p.group_id || p.group || '');
    var r1 = await rpc('nodeIKernelGroupService/getAllMemberList', [{ groupCode: gid, forceUpdate: false }]);
    var ids = (((r1 || {}).data || {}).result || {}).ids || [];
    var uids = ids.map(function (x) { return x && (x.uid || x); }).filter(Boolean);
    if (uids.length) {
      await rpc('nodeIKernelProfileService/getUserSimpleInfo', [{ uids: uids.slice(0, 200) }]);
      await new Promise(function (r) { setTimeout(r, 900); });
    }
    var prof = global.__wbProfiles || {};
    return { retcode: 0, data: uids.map(function (u) {
      var pf = prof[u] || {};
      var nick = pf.nick || pf.nickName || (pf.coreInfo && pf.coreInfo.nick) || '';
      var card = pf.cardName || pf.card || pf.remark || '';
      var uin = String(pf.uin || (pf.coreInfo && pf.coreInfo.uin) || 0);
      return { group_id: Number(gid) || gid, user_id: Number(uin) || 0, nickname: nick, card: card, uid: u };
    }) };
  }
  if (action === 'get_friend_list') { return { retcode: 0, data: [] }; }
  if (action === 'get_stranger_info') { return { retcode: 0, data: { user_id: Number(p.user_id || 0), nickname: '' } }; }
  if (action === 'can_send_image' || action === 'can_send_record') { return { retcode: 0, data: { yes: true } }; }
  if (action === 'get_cookies') { return { retcode: 0, data: {} }; }
  if (action === 'get_record') { return { retcode: 1404, data: null, error: 'not supported' }; }
  return { retcode: 1404, data: null, error: 'unknown action ' + action };
}
server.on('upgrade', function (req, sock) {
  try {
    var u2 = new URL(req.url, 'http://127.0.0.1');
    var key = req.headers['sec-websocket-key'];
    if (!key) { sock.destroy(); return; }
    var want = wsToken();
    var got = u2.searchParams.get('access_token') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (want && got !== want) { try { sock.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); } catch (e) {} sock.destroy(); return; }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
    var rec = { sock: sock, buf: Buffer.alloc(0), dead: 0, at: Date.now(), peer: req.socket.remoteAddress };
    WS_CLIENTS.add(rec);
    log('WS OPEN clients=' + WS_CLIENTS.size + ' path=' + u2.pathname);
    sock.on('data', function (ch) { try { wsFeed(rec, ch); } catch (e) { log('WS-FEED ' + (e && e.message)); } });
    sock.on('close', function () { rec.dead = 1; WS_CLIENTS.delete(rec); log('WS CLOSE clients=' + WS_CLIENTS.size); });
    sock.on('error', function () { rec.dead = 1; WS_CLIENTS.delete(rec); });
    wsSend(rec, { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect',
      time: Math.floor(Date.now() / 1000), self_id: SELF_UIN });
  } catch (e) {
    log('WS-UPGRADE-ERR ' + (e && e.message));
    try { sock.destroy(); } catch (_) {}
  }
});
var wsTimer = setInterval(function () {
  if (global.__wbGen !== MYGEN) { clearInterval(wsTimer); return; }
  if (!WS_CLIENTS.size) return;
  wsBroadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat', sub_type: 'heartbeat',
    time: Math.floor(Date.now() / 1000), self_id: SELF_UIN, status: { online: true, good: true }, interval: 30000 });
}, 30000);
// ================= /WB_WS_LAYER =================

server.on('error', function(e){ log('SERVER-ERR ' + e.message); });

server.listen(PORT, '127.0.0.1', function(){ log('ENGINE3 LISTEN ' + PORT + ' pid=' + process.pid); });
global.__wbSrv = server;
module.exports = { rpc: rpc, sendOney: sendOney, events: events, groups: function(){ return groups; } };
