import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// Ordre de résolution : l'app Phase 3 (mobile-app/www, future racine
// Capacitor) prime sur les clients de test Phase 1/2 (pc-service/public),
// qui restent joignables par leur nom de fichier (/test.html, /test-audio.html).
const SEARCH_DIRS = [
  join(SERVICE_ROOT, '..', 'mobile-app', 'www'),
  join(SERVICE_ROOT, 'public'),
];

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function resolveFile(urlPath) {
  const safePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  for (const dir of SEARCH_DIRS) {
    const filePath = join(dir, safePath);
    if (filePath !== dir && !filePath.startsWith(dir + sep)) continue;
    try {
      return await readFile(filePath);
    } catch {
      // pas dans ce dossier, on tente le suivant
    }
  }
  return null;
}

// Sert mobile-app/www et pc-service/public en lecture seule (atteignable en
// HTTP depuis le téléphone, contrairement à `file://`). Pas d'authentification
// ici : mêmes garanties que le reste du service, LAN only, le token protège
// les actions (WS), pas la simple page statique.
export function createStaticServer() {
  return createServer(async (req, res) => {
    const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const data = await resolveFile(urlPath);
    if (data === null) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(urlPath)] || 'application/octet-stream' });
    res.end(data);
  });
}
