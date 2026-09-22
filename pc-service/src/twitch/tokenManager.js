import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '../../.env');

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

// Rafraîchit avant expiration plutôt que d'attendre l'échec d'un appel API
// (voir decision-app-twitch-enregistree-compte-perso-separe : le token
// d'accès expire en ~4h10, le refresh doit être automatique).
const REFRESH_MARGIN_SECONDS = 300;

export class TokenManager extends EventEmitter {
  constructor({ clientId, clientSecret, accessToken, refreshToken }) {
    super();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this._timer = null;
  }

  async start() {
    try {
      const res = await fetch(VALIDATE_URL, {
        headers: { Authorization: `OAuth ${this.accessToken}` },
      });
      if (!res.ok) {
        await this.refresh();
        return;
      }
      const { expires_in } = await res.json();
      this._scheduleRefresh(expires_in);
    } catch (err) {
      console.error('[twitch] validation du token échouée, tentative de refresh:', err.message);
      await this.refresh();
    }
  }

  async refresh() {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(TOKEN_URL, { method: 'POST', body });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Refresh du token Twitch échoué (${res.status}): ${text}`);
    }
    const data = await res.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this._persist();
    this._scheduleRefresh(data.expires_in);
    console.log('[twitch] token rafraîchi, prochaine expiration dans', data.expires_in, 's');
    this.emit('refreshed', this.accessToken);
    return this.accessToken;
  }

  _scheduleRefresh(expiresInSeconds) {
    if (this._timer) clearTimeout(this._timer);
    const delayMs = Math.max((expiresInSeconds - REFRESH_MARGIN_SECONDS) * 1000, 10_000);
    this._timer = setTimeout(() => {
      this.refresh().catch((err) => console.error('[twitch] refresh automatique échoué:', err));
    }, delayMs);
    this._timer.unref();
  }

  _persist() {
    try {
      let content = readFileSync(ENV_PATH, 'utf8');
      content = content.replace(/^TWITCH_ACCESS_TOKEN=.*$/m, `TWITCH_ACCESS_TOKEN=${this.accessToken}`);
      content = content.replace(/^TWITCH_REFRESH_TOKEN=.*$/m, `TWITCH_REFRESH_TOKEN=${this.refreshToken}`);
      writeFileSync(ENV_PATH, content);
    } catch (err) {
      console.error('[twitch] échec de la persistance des tokens dans .env:', err.message);
    }
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
  }
}
