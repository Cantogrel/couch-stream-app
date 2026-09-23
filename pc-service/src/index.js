import { config } from './config.js';
import { ObsController } from './obs.js';
import { TokenManager } from './twitch/tokenManager.js';
import { TwitchChat } from './twitch/irc.js';
import { HelixClient } from './twitch/helix.js';
import { LocalWsServer } from './wsServer.js';
import { PcmPlayer } from './audio/pcmPlayer.js';
import { learnObsPath } from './obsLocator.js';

const SERVICE_VERSION = '0.1.0';

// Réessaie tant que ça échoue (ex. pas encore de réseau au démarrage de
// Windows) plutôt que de quitter : un service qui sort en boucle laisse
// l'UI injoignable, sans explication.
async function withRetry(label, fn, delayMs = 10_000) {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      console.error(`[${label}] échec, nouvelle tentative dans ${delayMs / 1000}s:`, err.message);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  const obs = new ObsController(config.obs);

  const tokenManager = new TokenManager(config.twitch);

  const helix = new HelixClient({ clientId: config.twitch.clientId, tokenManager });
  const chat = new TwitchChat({ channelLogin: config.twitch.channelLogin, tokenManager });

  const pcmPlayer = new PcmPlayer({ deviceLabelMatch: config.audio.outputDeviceLabel, jitterBufferMs: config.audio.jitterBufferMs });
  // Vérifie que VB-Cable est bien présent dès le boot (échec rapide et
  // clair), mais n'ouvre le flux audio natif qu'à la demande, pendant un
  // envoi micro actif (voir wsServer.js) — pas en continu depuis le boot.
  await pcmPlayer.resolveDevice().catch((err) => {
    // Non fatal : le reste (OBS, chat, UI) doit fonctionner sans VB-Cable ;
    // start() réessaie à chaque envoi micro.
    console.error('[audio] VB-Cable indisponible au démarrage:', err.message);
  });

  // Le serveur s'abonne aux évènements obs/chat AVANT que ces derniers ne se
  // connectent, pour ne pas rater les évènements "status" initiaux.
  const server = new LocalWsServer({ port: config.localWs.port, token: config.localWs.token, obs, chat, helix, pcmPlayer, service: { version: SERVICE_VERSION } });
  server.start();

  // OBS peut être fermé au démarrage : on ne bloque pas le reste dessus.
  obs.on('status', ({ connected }) => {
    console.log(connected ? '[obs] connecté' : '[obs] déconnecté');
    if (connected) learnObsPath();
  });
  obs.startConnecting();

  // Twitch après le serveur : sans réseau ou avec un token invalide, l'UI
  // (page /desktop) reste joignable et l'explique au lieu d'être muette.
  await withRetry('twitch', () => tokenManager.start());
  const channel = await withRetry('twitch', () => helix.init(config.twitch.channelLogin));
  console.log(`[twitch] Helix prêt pour ${channel.display_name} (id ${channel.id})`);

  await withRetry('twitch', () => chat.connect());
  console.log('[twitch] IRC connecté');

  const shutdown = () => {
    console.log('\nArrêt du service...');
    tokenManager.stop();
    pcmPlayer.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Lancé par l'app Windows (desktop/) : si elle disparaît (crash, kill), stdin
// se ferme et le service s'arrête au lieu de rester orphelin.
if (process.env.COUCH_PARENT_STDIN === '1') {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}

main().catch((err) => {
  console.error('Échec du démarrage du service compagnon:', err);
  process.exit(1);
});
