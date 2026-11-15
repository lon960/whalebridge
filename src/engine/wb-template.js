// wb-template.js - bootstrap written to C:\wb.js by install.ps1 (%PKG% replaced at install time)
var fs = require('fs');
var path = require('path');

var PKG = '__PKG__';
var DIR = path.join(PKG, 'js');
var ENGINE = path.join(DIR, 'engine.cjs');
var FLAG = path.join(DIR, 'reload.flag');

function bootlog(s) {
  try { fs.appendFileSync(path.join(DIR, 'boot.log'), new Date().toISOString() + ' ' + s + '\n'); } catch (e) {}
}

bootlog('wb.js loaded pkg=' + PKG);

var last = -1;

function reload(tag) {
  try { if (global.__wbSrv) { try { global.__wbSrv.close(); } catch (e) {} global.__wbSrv = null; } } catch (e) {}
  try { delete require.cache[require.resolve(ENGINE)]; } catch (e) {}
  try { require(ENGINE); bootlog('engine loaded (' + tag + ')'); }
  catch (e) { bootlog('engine error: ' + (e && e.stack || e)); }
}

setInterval(function () {
  try {
    var t = fs.statSync(FLAG).mtimeMs;
    if (t !== last) { last = t; reload('reload.flag'); }
  } catch (e) {}
}, 800);

reload('first');