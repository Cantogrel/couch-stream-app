import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { setEnvVar } from '../envFile.js';
import { loadSecrets, updateSecrets } from '../secureStore.js';

const RETRY_MS = 10_000;

// Chapeau autour de tokenManager + helix + chat : Twitch n'est plus supposé
// configuré au démarrage. Sans jeton, le service reste en attente ; la
// connexion de l'assistant (ou une ancienne config migrée) déclenche connect().
export class TwitchService extends EventEmitter {
  constructor({ tokenManager, helix, chat, deviceAuth }) {
    super();
    this.tokenManager = tokenManager;
    this.helix = helix;
    this.chat = chat;
    this.state = 'unconfigured'; // unconfigured | connecting | connected
    this.login = null;
    this._generation = 0;

    deviceAuth.on('authorized', (auth) => this.authorize(auth).catch((err) => console.error('[twitch] enregistrement des jetons échoué:', err.message)));
    chat.on('status', ({ connected }) => {
      if (this.state !== 'unconfigured') this.state = connected ? 'connected' : 'connecting';
    });
  }

  // Charge les jetons : magasin chiffré, sinon migration des anciens jetons du
  // .env (effacés du .env une fois le magasin écrit).
  async loadSaved() {
    const secrets = await loadSecrets();
    let { twitchAccessToken: accessToken, twitchRefreshToken: refreshToken, twitchLogin: login } = secrets;

    if (!accessToken && config.twitch.legacyAccessToken && config.twitch.legacyRefreshToken) {
      accessToken = config.twitch.legacyAccessToken;
      refreshToken = config.twitch.legacyRefreshToken;
      login = config.twitch.channelLogin || 'lescopaings_';
      try {
        await updateSecrets({
          twitchAccessToken: accessToken,
          twitchRefreshToken: refreshToken,
          twitchLogin: login,
          ...(config.twitch.clientSecret ? { twitchClientSecret: config.twitch.clientSecret } : {}),
        });
        for (const key of ['TWITCH_ACCESS_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_CLIENT_SECRET']) setEnvVar(key, null);
        console.log('[twitch] anciens jetons migrés vers le magasin chiffré');
      } catch (err) {
        console.error('[twitch] migration des jetons impossible, ils restent dans le .env:', err.message);
      }
    }
    if (!accessToken || !refreshToken) return false;
    this.tokenManager.setTokens({ accessToken, refreshToken });
    // Ancienne app « confidentielle » : son secret vit aussi dans le magasin chiffré.
    if (secrets.twitchClientSecret || config.twitch.clientSecret) this.tokenManager.clientSecret = secrets.twitchClientSecret || config.twitch.clientSecret;
    this.login = login || config.twitch.channelLogin || null;
    return true;
  }

  // Résultat du flux Device Code : on enregistre, puis on (re)connecte.
  async authorize({ accessToken, refreshToken, login }) {
    this.tokenManager.setTokens({ accessToken, refreshToken });
    this.login = login;
    await updateSecrets({ twitchAccessToken: accessToken, twitchRefreshToken: refreshToken, twitchLogin: login });
    this.emit('authorized', { login });
    await this.connect();
  }

  // Démarre (ou redémarre) helix + IRC. Réessaie tant que ça échoue : un
  // service qui abandonne laisserait le chat muet sans explication.
  async connect() {
    if (!this.tokenManager.hasTokens || !this.login) return;
    const generation = ++this._generation;
    this.state = 'connecting';
    const retry = async (label, fn) => {
      for (;;) {
        if (generation !== this._generation) throw new Error('connexion remplacée');
        try {
          return await fn();
        } catch (err) {
          if (generation !== this._generation) throw err;
          console.error(`[twitch] ${label} — nouvelle tentative dans ${RETRY_MS / 1000}s:`, err.message);
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      }
    };
    try {
      await retry('jetons', () => this.tokenManager.start());
      const channel = await retry('helix', () => this.helix.init(this.login));
      console.log(`[twitch] Helix prêt pour ${channel.display_name} (id ${channel.id})`);
      if (this.chat.client) {
        try { await this.chat.client.disconnect(); } catch { /* déjà coupé */ }
      }
      this.chat.channelLogin = this.login;
      await retry('irc', () => this.chat.connect());
      console.log('[twitch] IRC connecté');
      this.state = 'connected';
    } catch (err) {
      if (!/remplacée/.test(err.message)) throw err;
    }
  }

  status() {
    return { state: this.state, login: this.login };
  }
}
