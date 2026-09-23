import { config } from './config.js';
import { ObsController } from './obs.js';
import { TokenManager } from './twitch/tokenManager.js';
import { TwitchChat } from './twitch/irc.js';
import { HelixClient } from './twitch/helix.js';
import { LocalWsServer } from './wsServer.js';
import { PcmPlayer } from './audio/pcmPlayer.js';
import { learnObsPath } from './obsLocator.js';
import { DeviceStore, loadIdentity } from './devices.js';
import { advertise } from './discovery.js';
import { DeviceAuth } from './twitch/deviceAuth.js';
import { TwitchService } from './twitch/twitchService.js';
import { VbCableInstaller } from './vbcable.js';
import { Setup } from './setup.js';
import { VERSION } from './version.js';

async function main() {
  const obs = new ObsController(config.obs);

  const tokenManager = new TokenManager(config.twitch);
  const helix = new HelixClient({ clientId: config.twitch.clientId, tokenManager });
  const chat = new TwitchChat({ channelLogin: config.twitch.channelLogin, tokenManager });
  const deviceAuth = new DeviceAuth({ clientId: config.twitch.clientId });
  const twitch = new TwitchService({ tokenManager, helix, chat, deviceAuth });

  const pcmPlayer = new PcmPlayer({ deviceLabelMatch: config.audio.outputDeviceLabel, jitterBufferMs: config.audio.jitterBufferMs });
  // Vérifie que VB-Cable est bien présent dès le boot, mais n'ouvre le flux
  // audio natif qu'à la demande, pendant un envoi micro actif (voir
  // wsServer.js) — pas en continu depuis le boot.
  await pcmPlayer.resolveDevice().catch((err) => {
    // Non fatal : le reste (OBS, chat, UI) doit fonctionner sans VB-Cable ;
    // start() réessaie à chaque envoi micro, l'assistant propose de l'installer.
    console.error('[audio] VB-Cable indisponible au démarrage:', err.message);
  });

  // Le serveur s'abonne aux évènements obs/chat AVANT que ces derniers ne se
  // connectent, pour ne pas rater les évènements "status" initiaux.
  const identity = loadIdentity();
  const devices = new DeviceStore();
  const vbcable = new VbCableInstaller({ pcmPlayer });
  let server;
  const setup = new Setup({ obs, twitchService: twitch, deviceAuth, vbcable, getPhoneCount: () => server.getStatus().phones });
  server = new LocalWsServer({ port: config.localWs.port, token: config.localWs.token, obs, chat, helix, pcmPlayer, service: { version: VERSION }, devices, identity, setup, twitch });
  await server.start();
  const stopAdvertising = advertise({ identity, port: config.localWs.port });

  // OBS peut être fermé au démarrage : on ne bloque pas le reste dessus.
  obs.on('status', ({ connected }) => {
    console.log(connected ? '[obs] connecté' : '[obs] déconnecté');
    if (connected) learnObsPath();
  });
  obs.startConnecting();

  // Twitch après le serveur : sans jeton (premier lancement) ou sans réseau,
  // l'UI reste joignable et guide l'utilisateur au lieu d'être muette.
  const hadTokens = await twitch.loadSaved();
  if (hadTokens) {
    // Installation existante (jetons déjà présents) : pas d'assistant à imposer.
    if (!setup.hasSetupFile()) setup.markCompleted(true, true);
    twitch.connect().catch((err) => console.error('[twitch] connexion impossible:', err.message));
    twitch.on('reauth-needed', () => setup.markCompleted(false));
  } else {
    console.log('[twitch] pas encore connecté — à faire dans l’assistant de configuration');
  }

  const shutdown = () => {
    console.log('\nArrêt du service...');
    tokenManager.stop();
    stopAdvertising();
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
