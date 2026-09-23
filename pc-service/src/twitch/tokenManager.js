import { EventEmitter } from 'node:events';
import { updateSecrets } from '../secureStore.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

// Rafraîchit avant expiration plutôt que d'attendre l'échec d'un appel API
// (voir decision-app-twitch-enregistree-compte-perso-separe : le token
// d'accès expire en ~4h10, le refresh doit être automatique).
const REFRESH_MARGIN_SECONDS = 300;

export class TokenManager extends EventEmitter {
  constructor({ clientId, clientSecret }) {
    super();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = null;
    this.refreshToken = null;
    this._timer = null;
  }

  get hasTokens() {
    return Boolean(this.accessToken && this.refreshToken);
  }

  // Appelé au démarrage (jetons du magasin chiffré) et à la fin de la
  // connexion Twitch de l'assistant.
  setTokens({ accessToken, refreshToken }) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  async start() {
    if (!this.hasTokens) throw new Error('aucun jeton Twitch (connexion à faire dans l’assistant)');
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
    const params = {
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
    };
    // Client public (flux Device Code) : pas de secret. Présent seulement pour
    // une ancienne app « confidentielle ».
    if (this.clientSecret) params.client_secret = this.clientSecret;
    const res = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams(params) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Refresh du token Twitch échoué (${res.status}): ${text}`);
    }
    const data = await res.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    await this.persist();
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

  // Le refresh token change à chaque rafraîchissement : le perdre = devoir
  // se reconnecter, d'où l'écriture immédiate dans le magasin chiffré.
  async persist() {
    try {
      await updateSecrets({ twitchAccessToken: this.accessToken, twitchRefreshToken: this.refreshToken });
    } catch (err) {
      console.error('[twitch] échec de la persistance des jetons:', err.message);
    }
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
  }
}
