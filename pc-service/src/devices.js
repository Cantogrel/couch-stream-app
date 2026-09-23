import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

const IDENTITY_FILE = join(DATA_DIR, 'identity.json');
const DEVICES_FILE = join(DATA_DIR, 'devices.json');
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_LIVE_CODES = 5;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// Identité stable de ce PC : le téléphone la mémorise au jumelage pour le
// retrouver sur le réseau même si son IP change.
export function loadIdentity() {
  let id = readJson(IDENTITY_FILE, null);
  if (!id?.id) {
    id = { id: randomUUID(), name: hostname() };
    writeJson(IDENTITY_FILE, id);
  }
  return id;
}

// Téléphones jumelés : un token par appareil (seul son hash est stocké), pour
// pouvoir en révoquer un sans toucher aux autres. Le QR ne porte qu'un code à
// usage unique et à durée limitée, échangé contre le vrai token via /api/pair.
export class DeviceStore {
  constructor() {
    this.devices = readJson(DEVICES_FILE, []);
    this.codes = new Map(); // code -> expiration
  }

  createPairingCode() {
    const now = Date.now();
    for (const [code, exp] of this.codes) if (exp < now) this.codes.delete(code);
    while (this.codes.size >= MAX_LIVE_CODES) this.codes.delete(this.codes.keys().next().value);
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, now + CODE_TTL_MS);
    return code;
  }

  // Renvoie {token, device} ou null si le code est inconnu/expiré. Le code est
  // consommé dans tous les cas (un seul essai).
  redeem(code, name) {
    const exp = this.codes.get(code);
    this.codes.delete(code);
    if (!exp || exp < Date.now()) return null;
    const token = randomBytes(24).toString('hex');
    const device = {
      id: randomUUID(),
      name: String(name || 'Téléphone').slice(0, 60),
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.devices.push(device);
    this._save();
    return { token, device: this._public(device) };
  }

  verify(token) {
    if (typeof token !== 'string' || !token) return null;
    const hash = sha256(token);
    return this.devices.find((d) => d.tokenHash === hash) || null;
  }

  touch(id, appVersion) {
    const d = this.devices.find((x) => x.id === id);
    if (d) {
      d.lastSeenAt = Date.now();
      if (appVersion) d.appVersion = appVersion;
      this._save();
    }
  }

  revoke(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== before) this._save();
    return this.devices.length !== before;
  }

  list() {
    return this.devices.map((d) => this._public(d));
  }

  _public({ id, name, createdAt, lastSeenAt, appVersion }) {
    return { id, name, createdAt, lastSeenAt, appVersion: appVersion || null };
  }

  _save() {
    writeJson(DEVICES_FILE, this.devices);
  }
}
