// patch-config.mjs - 把 bridge/config.json 里的地址类字段改成现场值（文本级替换，保留其余内容原样）
import fs from 'node:fs';

const cfgPath = process.argv[2];
const port = process.argv[3] || '3902';
const dshPort = process.argv[4] || '';
const allowGroups = process.argv[5] || '';
const allowPrivate = process.argv[6] || '';

let txt = fs.readFileSync(cfgPath, 'utf8');
const before = txt;

function setKey(text, key, value) {
  const re = new RegExp('("' + key + '"\\s*:\\s*")[^"]*(")', 'g');
  return text.replace(re, (_m, a, b) => a + value + b);
}

txt = setKey(txt, 'httpUrl', 'http://127.0.0.1:' + port);
txt = setKey(txt, 'wsUrl', 'ws://127.0.0.1:' + port + '/');
if (dshPort) txt = setKey(txt, 'baseUrl', 'http://127.0.0.1:' + dshPort);

function setList(text, key, ids) {
  if (!ids.length) return text;
  const arr = '[' + ids.map((v) => '"' + v + '"').join(',') + ']';
  const re = new RegExp('("' + key + '"\\s*:\\s*)\\[[^\\]]*\\]');
  return text.replace(re, (_m, a) => a + arr);
}

const groups = String(allowGroups).split(/[,\s]+/).filter(Boolean);
const privates = String(allowPrivate).split(/[,\s]+/).filter(Boolean);
txt = setList(txt, 'groups', groups);
txt = setList(txt, 'private', privates);

fs.writeFileSync(cfgPath, txt, 'utf8');
console.log('patched=' + (txt !== before) + ' port=' + port + ' dsh=' + (dshPort || '(unchanged)') + ' groups=' + groups.length + ' private=' + privates.length);