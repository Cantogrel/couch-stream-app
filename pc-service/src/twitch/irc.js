import { EventEmitter } from 'node:events';
import tmi from 'tmi.js';

// Assez large pour ne jamais gêner en pratique (petit streamer, peu de
// messages), tout en bornant la mémoire du service — voir retour
// utilisateur Phase 3 (historique manquant au rechargement de page).
const HISTORY_CAP = 300;

export class TwitchChat extends EventEmitter {
  constructor({ channelLogin, tokenManager }) {
    super();
    this.channelLogin = channelLogin;
    this.tokenManager = tokenManager;
    this.client = null;
    this.history = [];
    this.historyById = new Map();

    // Le token peut être rafraîchi en cours de route (voir tokenManager) —
    // tmi.js ne relit pas le mot de passe tout seul, il faut reconnecter.
    tokenManager.on('refreshed', () => this._reconnectWithFreshToken());
  }

  getHistory() {
    return this.history;
  }

  _buildClient() {
    return new tmi.Client({
      options: { skipMembership: true },
      connection: { reconnect: true, secure: true },
      identity: {
        username: this.channelLogin,
        password: `oauth:${this.tokenManager.accessToken}`,
      },
      channels: [this.channelLogin],
    });
  }

  async connect() {
    this.client = this._buildClient();

    this.client.on('message', (channel, tags, text, self) => {
      // self=true = message envoyé par ce compte lui-même (ex. via chat.send
      // depuis l'app) : émis quand même, sinon le diffuseur perd le retour de
      // ses propres messages dans le chat de l'app (aucun risque de boucle
      // ici, ce handler ne renvoie jamais rien vers IRC).
      const msg = {
        id: tags.id,
        userId: tags['user-id'],
        username: tags.username,
        displayName: tags['display-name'] || tags.username,
        text,
        self: Boolean(self),
        isMod: Boolean(tags.mod) || tags.badges?.broadcaster === '1',
        isBroadcaster: tags.badges?.broadcaster === '1',
        timestamp: Number(tags['tmi-sent-ts']) || Date.now(),
        deleted: false,
      };
      this._remember(msg);
      this.emit('message', msg);
    });

    // CLEARMSG Twitch — se déclenche pour toute suppression d'UN message,
    // qu'elle vienne de cette app (Helix) ou d'un autre outil de modération
    // (site Twitch, dock chat dans OBS, autre bot...). Sans ça, un message
    // supprimé restait affiché tel quel côté app tant que la page n'était
    // pas rechargée (retour utilisateur Phase 3).
    this.client.on('messagedeleted', (channel, username, deletedMessage, userstate) => {
      const id = userstate?.['target-msg-id'];
      console.log(`[twitch] CLEARMSG reçu (user=${username}, target-msg-id=${id || '?'})`);
      if (!id) return;
      this._markDeleted(id, { reason: 'delete' });
    });

    // CLEARCHAT Twitch (ban/timeout) — distinct de CLEARMSG : Twitch efface
    // TOUS les messages récents d'un utilisateur d'un coup, sans lister
    // leurs ID un par un. Absent avant ce correctif (retour utilisateur) :
    // un timeout/ban fait depuis Twitch (ou via chat.timeout/chat.ban de
    // cette app) supprimait bien le message côté Twitch mais l'app ne le
    // voyait jamais repasser en "supprimé".
    this.client.on('ban', (channel, username) => {
      console.log(`[twitch] CLEARCHAT ban reçu (user=${username})`);
      this._markUserModerated(username, { reason: 'ban' });
    });
    this.client.on('timeout', (channel, username, reasonText, duration) => {
      console.log(`[twitch] CLEARCHAT timeout reçu (user=${username}, duration=${duration}s)`);
      this._markUserModerated(username, { reason: 'timeout', duration });
    });

    this.client.on('disconnected', (reason) => {
      this.emit('status', { connected: false, reason });
    });

    await this.client.connect();
    this.emit('status', { connected: true });
  }

  async _reconnectWithFreshToken() {
    if (!this.client) return;
    try {
      await this.client.disconnect();
    } catch {
      // déjà déconnecté, sans importance
    }
    await this.connect();
    console.log('[twitch] IRC reconnecté avec le token rafraîchi');
  }

  async sendMessage(text) {
    if (!this.client) throw new Error('IRC non connecté');
    await this.client.say(this.channelLogin, text);
  }

  _remember(msg) {
    this.history.push(msg);
    this.historyById.set(msg.id, msg);
    if (this.history.length > HISTORY_CAP) {
      const evicted = this.history.shift();
      this.historyById.delete(evicted.id);
    }
  }

  _markDeleted(id, extra) {
    const stored = this.historyById.get(id);
    // Muté sur l'objet en mémoire : un rechargement de page (chat-history)
    // renvoie donc directement l'état à jour, pas seulement les clients
    // déjà connectés au moment de la suppression.
    if (stored) Object.assign(stored, { deleted: true }, extra);
    this.emit('message-deleted', { id, ...extra });
  }

  _markUserModerated(username, extra) {
    for (const msg of this.history) {
      if (msg.username === username && !msg.deleted) this._markDeleted(msg.id, extra);
    }
  }
}
