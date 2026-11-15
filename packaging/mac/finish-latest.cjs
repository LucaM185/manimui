// electron-builder writes latest-mac.yml while it packages; notarizing + stapling the dmg afterwards
// changes the dmg's bytes. Recompute size + sha512 of every listed file from the final files, and
// drop the dmg's blockMapSize (its .blockmap is not published: updates use the zip).
//   node packaging/mac/finish-latest.cjs <latest-mac.yml> <dir with the files>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const [file, dir] = process.argv.slice(2);
const info = yaml.load(fs.readFileSync(file, 'utf8'));
const sha512 = (p) => crypto.createHash('sha512').update(fs.readFileSync(p)).digest('base64');
for (const f of info.files || []) {
  const p = path.join(dir, f.url);
  if (!fs.existsSync(p)) throw new Error(`latest-mac.yml lists ${f.url}, not found in ${dir}`);
  f.sha512 = sha512(p);
  f.size = fs.statSync(p).size;
  if (/\.dmg$/.test(f.url)) delete f.blockMapSize;
}
const zip = (info.files || []).find((f) => /\.zip$/.test(f.url));
if (!zip) throw new Error('no zip in latest-mac.yml: the Mac updater needs it');
// (a Mac zip's blockmap is a separate <zip>.blockmap file, not a blockMapSize field)
if (!fs.existsSync(path.join(dir, `${zip.url}.blockmap`))) throw new Error(`${zip.url}.blockmap missing: differential updates need it`);
// top-level path/sha512 = the file updaters fall back to; make it the zip
info.path = zip.url;
info.sha512 = zip.sha512;
fs.writeFileSync(file, yaml.dump(info, { lineWidth: 8000 }));
console.log(`latest-mac.yml ${info.version}: ${info.files.map((f) => `${f.url} (${(f.size / 1e6).toFixed(0)} MB)`).join(', ')}`);
