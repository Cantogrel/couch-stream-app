import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import OBSWebSocket from 'obs-websocket-js';

// Réglages du serveur WebSocket d'OBS (Outils → Paramètres du serveur
// WebSocket) : OBS les garde dans un JSON en clair, mot de passe compris. Les
// lire évite à l'utilisateur de le recopier ; la saisie manuelle reste possible.
export function readObsWebsocketConfig() {
  const path = join(process.env.APPDATA || '', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
  if (!existsSync(path)) return { found: false };
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    return {
      found: true,
      enabled: Boolean(c.server_enabled),
      port: Number(c.server_port) || 4455,
      authRequired: Boolean(c.auth_required),
      password: c.auth_required ? String(c.server_password || '') : '',
    };
  } catch {
    return { found: false };
  }
}

// Essaie une connexion jetable (sans toucher à celle du service) et classe
// l'échec : OBS fermé / WebSocket désactivé, ou mot de passe refusé.
export async function probeObs({ url, password }) {
  const obs = new OBSWebSocket();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
  try {
    const { obsWebSocketVersion, obsStudioVersion } = await Promise.race([obs.connect(url, password || undefined), timeout]);
    return { ok: true, obsVersion: obsStudioVersion, wsVersion: obsWebSocketVersion };
  } catch (err) {
    const msg = String(err?.message || err);
    if (err?.code === 4009 || /authentication/i.test(msg)) return { ok: false, reason: 'bad-password', message: 'Mot de passe refusé par OBS.' };
    if (/ECONNREFUSED|timeout|closed|ENOTFOUND/i.test(msg)) return { ok: false, reason: 'unreachable', message: "OBS n'est pas lancé, ou son serveur WebSocket est désactivé." };
    return { ok: false, reason: 'error', message: msg };
  } finally {
    obs.disconnect().catch(() => {});
  }
}
