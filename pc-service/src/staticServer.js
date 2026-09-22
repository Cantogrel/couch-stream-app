import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Sert public/ en lecture seule (clients de test avant toute UI mobile —
// depuis un téléphone, `file://` n'est pas atteignable, il faut du HTTP).
// Pas d'authentification ici : mêmes garanties que le reste du service,
// LAN only, le token protège les actions (WS), pas la simple page statique.
export function createStaticServer() {
  return createServer(async (req, res) => {
    const urlPath = req.url === '/' ? '/test.html' : req.url.split('?')[0];
    const safePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(PUBLIC_DIR, safePath);
    if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
}
