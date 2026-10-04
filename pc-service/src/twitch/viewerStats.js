import { EventEmitter } from 'node:events';

const POLL_MS = 30_000;
// Sans le scope moderator:read:chatters (jeton antérieur), on ne réessaie que
// rarement : chaque essai est un appel API voué à l'échec.
const SCOPE_RETRY_MS = 10 * 60_000;

// Nombre de spectateurs (Helix /streams) et de personnes connectées au chat
// (Helix /chat/chatters). Twitch rafraîchit ces chiffres environ chaque minute :
// un relevé toutes les 30 s suffit. Aucun appel tant qu'aucun client n'écoute
// (hasListeners) ni tant que Helix n'est pas prêt.
export class ViewerStats extends EventEmitter {
  constructor({ helix, hasListeners }) {
    super();
    this.helix = helix;
    this.hasListeners = hasListeners;
    this.value = { live: false, viewers: null, chatters: null };
    this._scopeMissingAt = 0;
    this._timer = setInterval(() => this.refresh(), POLL_MS);
    this._timer.unref();
  }

  async refresh() {
    if (!this.helix.broadcasterId || !this.hasListeners()) return;
    const next = { ...this.value };
    try {
      const stream = await this.helix.getStreamInfo();
      next.live = Boolean(stream);
      next.viewers = stream ? stream.viewer_count : null;
    } catch {
      return; // réseau/Twitch indisponible : on garde la dernière valeur
    }
    if (!this._scopeMissingAt || Date.now() - this._scopeMissingAt > SCOPE_RETRY_MS) {
      try {
        next.chatters = (await this.helix.getChatters({ first: 1 })).total;
        this._scopeMissingAt = 0;
      } catch (err) {
        if (err.missingScope) this._scopeMissingAt = Date.now();
        next.chatters = null;
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(this.value)) {
      this.value = next;
      this.emit('change', next);
    }
  }

  // Liste des connectés. Sans le scope : repli sur les personnes ayant écrit
  // récemment (`partial`), avec la raison pour que l'app l'explique.
  async chatters(recentUsers) {
    if (!this.helix.broadcasterId) return { total: null, names: recentUsers, partial: true, reason: 'twitch' };
    try {
      const { total, logins } = await this.helix.getChatters();
      this._scopeMissingAt = 0;
      return { total, names: logins, partial: false };
    } catch (err) {
      if (!err.missingScope) throw err;
      this._scopeMissingAt = Date.now();
      return { total: null, names: recentUsers, partial: true, reason: 'scope' };
    }
  }
}
