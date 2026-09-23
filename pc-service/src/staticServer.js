import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { config } from './config.js';
import { getLanAddress } from './lanAddress.js';

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

// Page de pairing Phase 4 : encode {host, port, token} dans un QR que l'app
// scanne (www/lib/jsQR.js) pour se configurer sans saisie manuelle — élimine
// la friction notée en Phase 2 (token recopié à la main). Générée à la volée
// (pas un fichier statique) car l'IP LAN peut changer d'une exécution à
// l'autre (DHCP, voir SUMMARY du vault) et doit toujours refléter l'état réel.
async function buildPairingPage() {
  const host = getLanAddress();
  const payload = JSON.stringify({ host, port: config.localWs.port, token: config.localWs.token });
  const qrDataUrl = host ? await QRCode.toDataURL(payload, { margin: 1, scale: 6 }) : null;

  const body = host
    ? `<img src="${qrDataUrl}" alt="QR de pairing" width="280" height="280">
       <p>Scanne ce code depuis l'app (Réglages → Scanner QR).</p>
       <p class="fallback">Ou saisis manuellement :<br>
       Hôte : <code>${host}</code><br>
       Port : <code>${config.localWs.port}</code><br>
       Token : <code>${config.localWs.token}</code></p>`
    : `<p>Impossible de détecter une IP LAN sur ce PC — vérifie la connexion réseau.</p>`;

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pairing — Couch Stream App</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111; color: #eee; text-align: center; padding: 24px; }
  img { background: #fff; padding: 12px; border-radius: 8px; }
  code { background: #222; padding: 2px 6px; border-radius: 4px; }
  .fallback { font-size: 0.9em; color: #aaa; margin-top: 24px; }
</style></head>
<body><h1>Couch Stream App — Pairing</h1>${body}</body></html>`;
}

// Sert mobile-app/www et pc-service/public en lecture seule (atteignable en
// HTTP depuis le téléphone, contrairement à `file://`). Pas d'authentification
// ici : mêmes garanties que le reste du service, LAN only, le token protège
// les actions (WS), pas la simple page statique. /pair expose le token en
// clair par QR/texte — c'est le but (pairing), toujours LAN only.
// Ces routes déclenchent des actions sur le PC (lancer OBS) ou exposent son
// état : réservées à la machine locale (page /desktop ouverte depuis l'icône),
// jamais au téléphone.
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

export function createStaticServer({ getStatus, launchObs }) {
  return createServer(async (req, res) => {
    const urlPath = req.url === '/' ? '/index.html' : req.url === '/desktop' ? '/desktop.html' : req.url.split('?')[0];

    if (urlPath.startsWith('/api/')) {
      if (!isLoopback(req)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (urlPath === '/api/status' && req.method === 'GET') return json(getStatus());
      if (urlPath === '/api/obs/launch' && req.method === 'POST') return json(await launchObs());
      res.writeHead(404);
      return res.end('Not found');
    }

    if (urlPath === '/pair') {
      const html = await buildPairingPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    const data = await resolveFile(urlPath);
    if (data === null) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(urlPath)] || 'application/octet-stream' });
    res.end(data);
  });
}
