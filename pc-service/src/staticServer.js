import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
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
// APK de l'app téléphone : embarqué par l'installeur (sidecar/app.apk) ou, en
// dev, le dernier build debug du dépôt.
const APK_CANDIDATES = [
  join(SERVICE_ROOT, '..', 'app.apk'),
  join(SERVICE_ROOT, '..', 'mobile-app', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
];

async function findApk() {
  for (const path of APK_CANDIDATES) {
    try {
      return { path, size: (await stat(path)).size };
    } catch {
      // absent, on tente le suivant
    }
  }
  return null;
}

// Le QR porte un code de jumelage à usage unique (10 min), jamais le token :
// le téléphone l'échange contre son propre token via POST /api/pair.
async function buildPairingData({ devices, identity }) {
  const host = getLanAddress();
  const port = config.localWs.port;
  const payload = JSON.stringify({ v: 2, host, port, pcId: identity.id, name: identity.name, code: devices.createPairingCode() });
  const qrDataUrl = host ? await QRCode.toDataURL(payload, { margin: 1, scale: 6 }) : null;
  const apk = await findApk();
  const apkUrl = host ? `http://${host}:${port}/app.apk` : null;
  return {
    host,
    port,
    qrDataUrl,
    apk: apk && apkUrl ? { url: apkUrl, sizeMb: (apk.size / 1048576).toFixed(1), qrDataUrl: await QRCode.toDataURL(apkUrl, { margin: 1, scale: 6 }) } : null,
  };
}

async function buildPairingPage(ctx) {
  const { host, qrDataUrl } = await buildPairingData(ctx);

  const body = host
    ? `<img src="${qrDataUrl}" alt="QR de pairing" width="280" height="280">
       <p>Scanne ce code depuis l'app (Réglages → Scanner le QR de pairing). Il expire au bout de 10 minutes.</p>`
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
// Le contrôle de l'en-tête Host bloque le DNS rebinding (une page web qui
// ferait résoudre son domaine vers 127.0.0.1 pour lire /api/session).
const isLoopback = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
  /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };

async function readBody(req, limit = 4096) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('corps trop gros');
  }
  return raw ? JSON.parse(raw) : {};
}

export function createStaticServer({ getStatus, launchObs, devices, identity, listDevices, revokeDevice, service }) {
  return createServer(async (req, res) => {
    const urlPath = req.url === '/' ? '/index.html' : req.url === '/desktop' ? '/desktop.html' : req.url.split('?')[0];

    // Routes LAN pour le téléphone (CORS : l'app tourne sur http://localhost).
    // Le téléphone s'y identifie sans token : /hello ne révèle que l'identité
    // du PC, /api/pair exige un code à usage unique affiché sur ce PC.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (urlPath === '/hello' && req.method === 'GET') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ app: 'couch-stream', id: identity.id, name: identity.name, version: service.version, port: config.localWs.port }));
    }
    if (urlPath === '/api/pair' && req.method === 'POST') {
      let result = null;
      try {
        const body = await readBody(req);
        result = devices.redeem(String(body.code || ''), body.name);
      } catch {
        // corps invalide : traité comme un code refusé
      }
      res.writeHead(result ? 200 : 403, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result ? { token: result.token, pcId: identity.id, name: identity.name } : { error: 'code invalide ou expiré' }));
    }

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
      // La console PC (/desktop) s'authentifie seule : token servi uniquement
      // à la boucle locale, jamais au LAN.
      if (urlPath === '/api/session' && req.method === 'GET') return json({ token: config.localWs.token });
      if (urlPath === '/api/pairing' && req.method === 'GET') return json(await buildPairingData({ devices, identity }));
      if (urlPath === '/api/devices' && req.method === 'GET') return json(listDevices());
      if (urlPath.startsWith('/api/devices/') && req.method === 'DELETE') {
        const id = decodeURIComponent(urlPath.slice('/api/devices/'.length));
        return json({ ok: revokeDevice(id) });
      }
      if (urlPath === '/api/obs/launch' && req.method === 'POST') return json(await launchObs());
      res.writeHead(404);
      return res.end('Not found');
    }

    if (urlPath === '/app.apk') {
      const apk = await findApk();
      if (!apk) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': apk.size,
        'Content-Disposition': 'attachment; filename="CouchStream.apk"',
      });
      return createReadStream(apk.path).pipe(res);
    }

    if (urlPath === '/pair') {
      // Réservée à ce PC : afficher un code de jumelage à quelqu'un d'autre
      // sur le réseau reviendrait à lui donner accès.
      if (!isLoopback(req)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      const html = await buildPairingPage({ devices, identity });
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
