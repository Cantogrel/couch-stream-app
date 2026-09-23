import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ENV_PATH } from './paths.js';

// Écrit (ou remplace) une variable dans le .env du dossier de données, et la
// reflète dans process.env pour la session en cours. `null` supprime la ligne.
export function setEnvVar(key, value) {
  mkdirSync(dirname(ENV_PATH), { recursive: true });
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const re = new RegExp(`^${key}=.*(\\r?\\n)?`, 'm');
  const line = value === null ? '' : `${key}=${value}\n`;
  let next;
  if (re.test(current)) next = current.replace(re, line);
  else next = value === null ? current : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}`;
  writeFileSync(ENV_PATH, next);
  if (value === null) delete process.env[key];
  else process.env[key] = value;
}
