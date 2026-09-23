import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json'), 'utf8'));

export const VERSION = pkg.version;

// Version du protocole PC <-> téléphone. À incrémenter uniquement pour un
// changement incompatible des messages : un téléphone plus ancien que
// MIN_APP_PROTOCOL est refusé avec un message clair, un PC plus ancien que le
// protocole de l'app est signalé par l'app.
export const PROTOCOL = 1;
export const MIN_APP_PROTOCOL = 1;
