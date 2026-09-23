import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { release } from 'node:os';
import { DATA_DIR } from './paths.js';
import { setEnvVar } from './envFile.js';
import { findObs, launchObs } from './obsLocator.js';
import { probeObs, readObsWebsocketConfig } from './obsSetup.js';

const SETUP_FILE = join(DATA_DIR, 'setup.json');

// Assistant de premier lancement : agrège l'état de chaque étape (OBS, audio,
// Twitch, source micro, téléphone) et expose les actions correspondantes à la
// page /setup. Chaque étape se re-teste seule, donc l'assistant est reprenable
// à tout moment (fermeture, redémarrage) sans état caché.
export class Setup {
  constructor({ obs, twitchService, deviceAuth, vbcable, getPhoneCount }) {
    this.obs = obs;
    this.twitch = twitchService;
    this.deviceAuth = deviceAuth;
    this.vbcable = vbcable;
    this.getPhoneCount = getPhoneCount;
  }

  isCompleted() {
    try {
      return Boolean(JSON.parse(readFileSync(SETUP_FILE, 'utf8')).completed);
    } catch {
      return false;
    }
  }

  hasSetupFile() {
    return existsSync(SETUP_FILE);
  }

  markCompleted(completed = true, auto = false) {
    writeFileSync(SETUP_FILE, JSON.stringify({ completed, auto, at: Date.now() }));
  }

  async state() {
    const cfg = readObsWebsocketConfig();
    const installed = await this.vbcable.isInstalled();
    let micSource = null;
    if (this.obs.connected) micSource = await this.obs.hasMicSource().catch(() => null);
    return {
      completed: this.isCompleted(),
      system: { windows: release(), ok: parseInt(release().split('.')[0], 10) >= 10 },
      obs: {
        connected: this.obs.connected,
        version: this.obs.obsVersion,
        // obs-websocket est intégré à OBS depuis la version 28.
        versionOk: this.obs.obsVersion ? parseInt(this.obs.obsVersion, 10) >= 28 : null,
        lastError: this.obs.lastError,
        installed: Boolean(await findObs()),
        detected: cfg.found ? { enabled: cfg.enabled, port: cfg.port, authRequired: cfg.authRequired, hasPassword: Boolean(cfg.password) } : null,
      },
      audio: { installed, install: this.vbcable.status(), micSource },
      twitch: { ...this.twitch.status(), auth: this.deviceAuth.status() },
      phones: this.getPhoneCount(),
    };
  }

  // Renvoie l'objet JSON de la réponse.
  async handle(method, path, body) {
    if (path === '/api/setup/state' && method === 'GET') return this.state();

    if (path === '/api/setup/obs/apply' && method === 'POST') {
      const cfg = readObsWebsocketConfig();
      const url = `ws://127.0.0.1:${cfg.found ? cfg.port : 4455}`;
      const password = typeof body.password === 'string' ? body.password : cfg.password;
      const result = await probeObs({ url, password });
      if (result.ok) {
        setEnvVar('OBS_WEBSOCKET_URL', url);
        setEnvVar('OBS_WEBSOCKET_PASSWORD', password || '');
        this.obs.setCredentials({ url, password: password || '' });
      }
      return { ...result, usedDetectedPassword: result.ok && typeof body.password !== 'string' && Boolean(cfg.password) };
    }

    if (path === '/api/setup/obs/launch' && method === 'POST') return launchObs();

    if (path === '/api/setup/vbcable/install' && method === 'POST') {
      if (await this.vbcable.isInstalled()) return { ok: true, already: true };
      this.vbcable.install(); // asynchrone : la page suit l'avancement via /state
      return { ok: true };
    }

    if (path === '/api/setup/mic' && method === 'POST') {
      try {
        return { ok: true, ...(await this.obs.ensureMicSource()) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (path === '/api/setup/twitch/start' && method === 'POST') {
      // Marque l'assistant « en cours » avant que des jetons existent : sinon un
      // redémarrage du service au milieu de l'assistant les prendrait pour une
      // ancienne installation et le déclarerait terminé (voir index.js).
      if (!this.hasSetupFile()) this.markCompleted(false);
      try {
        return { ok: true, ...(await this.deviceAuth.start()) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    if (path === '/api/setup/twitch/cancel' && method === 'POST') {
      this.deviceAuth.cancel();
      return { ok: true };
    }

    if (path === '/api/setup/complete' && method === 'POST') {
      this.markCompleted(true);
      return { ok: true };
    }
    if (path === '/api/setup/reset' && method === 'POST') {
      this.markCompleted(false);
      return { ok: true };
    }
    return null;
  }
}
