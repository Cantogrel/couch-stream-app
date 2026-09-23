import { EventEmitter } from 'node:events';
import { TWITCH_SCOPES } from '../config.js';

const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

// Device Code Grant : aucun secret client, aucun serveur à héberger. Le
// service affiche un code + une URL ; l'utilisateur autorise sur twitch.tv
// (depuis n'importe quel navigateur/appareil) pendant que le service interroge
// Twitch jusqu'à obtenir les jetons.
export class DeviceAuth extends EventEmitter {
  constructor({ clientId }) {
    super();
    this.clientId = clientId;
    this.session = null; // { userCode, verificationUri, expiresAt, status, error }
    this._timer = null;
  }

  status() {
    if (!this.session) return { status: 'idle' };
    const { userCode, verificationUri, expiresAt, status, error } = this.session;
    return { status, userCode, verificationUri, expiresAt, error };
  }

  async start() {
    this.cancel();
    const res = await fetch(DEVICE_URL, {
      method: 'POST',
      body: new URLSearchParams({ client_id: this.clientId, scopes: TWITCH_SCOPES.join(' ') }),
    });
    if (!res.ok) throw new Error(`Twitch a refusé la demande de connexion (${res.status}) : ${await res.text()}`);
    const d = await res.json();
    this.session = {
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUri: d.verification_uri,
      expiresAt: Date.now() + d.expires_in * 1000,
      interval: (d.interval || 5) * 1000,
      status: 'pending',
      error: null,
    };
    this._schedule();
    return this.status();
  }

  cancel() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this.session?.status === 'pending') this.session.status = 'cancelled';
  }

  _schedule() {
    const s = this.session;
    this._timer = setTimeout(() => this._poll(s), s.interval);
    this._timer.unref?.();
  }

  async _poll(s) {
    if (this.session !== s || s.status !== 'pending') return;
    if (Date.now() > s.expiresAt) {
      s.status = 'expired';
      return;
    }
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: this.clientId,
          scopes: TWITCH_SCOPES.join(' '),
          device_code: s.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const data = await res.json();
      if (res.ok) return this._finish(s, data);
      const msg = String(data.message || '');
      if (msg === 'authorization_pending') return this._schedule();
      if (msg === 'slow_down') {
        s.interval += 5000;
        return this._schedule();
      }
      s.status = /denied|access_denied/i.test(msg) ? 'denied' : 'error';
      s.error = msg || `HTTP ${res.status}`;
    } catch (err) {
      // Réseau coupé un instant : on réessaie tant que le code est valable.
      console.error('[twitch] interrogation du code appareil échouée:', err.message);
      this._schedule();
    }
  }

  async _finish(s, data) {
    try {
      const v = await fetch(VALIDATE_URL, { headers: { Authorization: `OAuth ${data.access_token}` } });
      const info = await v.json();
      s.status = 'authorized';
      s.login = info.login;
      s.userId = info.user_id;
      this.emit('authorized', {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        login: info.login,
        userId: info.user_id,
      });
    } catch (err) {
      s.status = 'error';
      s.error = err.message;
    }
  }
}
