import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

// L'app Windows (desktop/, Rust) vérifie et installe les mises à jour signées ;
// ce service n'en est que le relais, par fichiers du dossier de données :
//   update-status.json  écrit par l'app Windows (état de la vérification/installation)
//   update-request.json écrit ici, lu puis supprimé par l'app Windows
// Lancé à la main (npm start), l'app Windows est absente : état « unknown ».
const STATUS_FILE = join(DATA_DIR, 'update-status.json');
const REQUEST_FILE = join(DATA_DIR, 'update-request.json');
const WATCH_MS = 3000;

export class UpdateRelay extends EventEmitter {
  constructor() {
    super();
    this._last = JSON.stringify(this.status());
    this._timer = setInterval(() => {
      const now = JSON.stringify(this.status());
      if (now !== this._last) {
        this._last = now;
        this.emit('change', JSON.parse(now));
      }
    }, WATCH_MS);
    this._timer.unref();
  }

  // { state: unknown | idle | checking | available | uptodate | downloading | installing | error,
  //   current, version, notes, progress, message }
  status() {
    try {
      if (!existsSync(STATUS_FILE)) return { state: 'unknown' };
      return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
    } catch {
      return { state: 'unknown' };
    }
  }

  _request(action) {
    if (this.status().state === 'unknown') throw new Error("Les mises à jour ne sont gérées que par l'application Windows installée.");
    writeFileSync(REQUEST_FILE, JSON.stringify({ action, at: Date.now() }));
  }

  check() {
    this._request('check');
  }

  install() {
    if (this.status().state !== 'available') throw new Error('Aucune mise à jour à installer.');
    this._request('install');
  }
}
