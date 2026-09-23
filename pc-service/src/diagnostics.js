import { existsSync, readFileSync } from 'node:fs';
import { arch, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';
import { PROTOCOL } from './version.js';

// Rapport à coller à quelqu'un qui aide à dépanner : aucune valeur secrète
// (mots de passe, jetons, token local) — seuls les noms des réglages présents
// et un extrait du journal, expurgé des longues chaînes qui ressemblent à un
// secret.
const LOG_LINES = 150;

function redact(text) {
  return text
    .replace(/(oauth:|bearer\s+|password[=:]\s*|token[=:]\s*|secret[=:]\s*)\S+/gi, '$1<masqué>')
    .replace(/[A-Za-z0-9_\-]{28,}/g, '<masqué>');
}

function tail(path, n) {
  if (!existsSync(path)) return '(journal absent)';
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

export async function buildReport(server) {
  const status = server.getStatus();
  const setupState = await server.setup.state().catch(() => null);
  const devices = server.listDevices();
  const envKeys = existsSync(join(DATA_DIR, '.env'))
    ? readFileSync(join(DATA_DIR, '.env'), 'utf8').split(/\r?\n/).map((l) => l.split('=')[0]).filter((k) => /^[A-Z_]+$/.test(k))
    : [];

  const out = [
    '=== Couch Stream App — rapport de diagnostic ===',
    `Date : ${new Date().toISOString()}`,
    `Service : v${status.version} (protocole ${PROTOCOL}) — Node ${process.version}`,
    `Système : Windows ${release()} ${arch()} — ${Math.round(totalmem() / 1073741824)} Go de RAM`,
    `Dossier de données : ${DATA_DIR}`,
    '',
    '--- État ---',
    `OBS : ${status.obs.connected ? `connecté (v${status.obs.version || '?'})` : `non connecté — ${status.obs.lastError || 'aucune erreur'}`}`,
    `Twitch : ${status.twitch.state}${status.twitch.login ? ` (${status.twitch.login})` : ''}`,
    `VB-Cable : ${status.vbcable.found ? status.vbcable.label : 'introuvable'}`,
    `Assistant terminé : ${setupState ? setupState.completed : '?'}`,
    `Source micro OBS : ${setupState ? setupState.audio.micSource : '?'}`,
    '',
    `--- Téléphones (${devices.length}) ---`,
    ...devices.map((d) => `- ${d.name} — app ${d.appVersion || '?'} — ${d.online ? 'connecté' : 'hors ligne'}`),
    '',
    `--- Réglages présents (.env, valeurs masquées) ---`,
    envKeys.join(', ') || '(aucun)',
    '',
    `--- Journal du service (${LOG_LINES} dernières lignes) ---`,
    redact(tail(join(DATA_DIR, 'service.log'), LOG_LINES)),
  ];
  return out.join('\n');
}
