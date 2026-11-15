import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const buf = readFileSync('dsh-decisions-board-0.1.0.tgz');
const tar = gunzipSync(buf);
let off = 0; const files = [];
while (off + 512 <= tar.length) {
  const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
  if (!name) { off += 512; continue; }
  const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
  files.push({ name, size, data: tar.subarray(off + 512, off + 512 + size) });
  off += 512 + Math.ceil(size / 512) * 512;
}
const pkg = JSON.parse(files.find((f) => f.name === 'package/package.json').data.toString('utf8'));
console.log(JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  patch: pkg.dsh?.bundle?.patch,
  platform: pkg.dsh?.client?.platform,
  inject: pkg.dsh?.client?.inject,
  clientExport: pkg.exports?.['./client'],
  bytes: buf.length,
  files: files.map((f) => f.name + ' (' + f.size + ')')
}, null, 2));