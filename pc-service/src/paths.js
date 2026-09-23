import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// Dossier de données utilisateur. L'app Windows (desktop/) le fixe via
// COUCH_DATA_DIR (%APPDATA%\CouchStreamApp) ; lancé à la main (`npm start`),
// on garde l'ancien comportement : .env à la racine de pc-service/.
export const DATA_DIR = process.env.COUCH_DATA_DIR || SERVICE_ROOT;
export const ENV_PATH = join(DATA_DIR, '.env');

// Migration one-shot de l'ancien .env vers le dossier de données : source
// explicite (COUCH_LEGACY_ENV) ou pc-service/.env voisin du code (checkout de
// dev). Ne réécrase jamais un .env déjà présent.
export function migrateLegacyEnv() {
  if (DATA_DIR === SERVICE_ROOT || existsSync(ENV_PATH)) return false;
  const legacy = [process.env.COUCH_LEGACY_ENV, join(SERVICE_ROOT, '.env')].find((p) => p && existsSync(p));
  if (!legacy) return false;
  mkdirSync(dirname(ENV_PATH), { recursive: true });
  copyFileSync(legacy, ENV_PATH);
  console.log(`[config] ancien .env migré: ${legacy} -> ${ENV_PATH}`);
  return true;
}
