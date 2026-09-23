// Génère latest.json (manifeste du Tauri updater) à partir de l'installeur NSIS
// et de sa signature. Usage : node make-latest-json.mjs OWNER/REPO vX.Y.Z "notes"
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [repo, tag, notes = ''] = process.argv.slice(2);
if (!repo || !tag) {
  console.error('Usage : node make-latest-json.mjs OWNER/REPO vX.Y.Z "notes"');
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const exe = readdirSync(dir).find((f) => f.endsWith('-setup.exe'));
if (!exe) throw new Error(`Aucun installeur dans ${dir} — lance d'abord "npm run build".`);
const signature = readFileSync(join(dir, `${exe}.sig`), 'utf8').trim();

const manifest = {
  version: tag.replace(/^v/, ''),
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      // GitHub remplace les espaces du nom de fichier par des points.
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(exe.replace(/ /g, '.'))}`,
    },
  },
};
const out = join(dir, 'latest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`latest.json écrit : ${out}\nInstalleur à joindre à la release : ${exe}`);
