import { config } from './config.js';
import { ObsController } from './obs.js';
import { TokenManager } from './twitch/tokenManager.js';
import { TwitchChat } from './twitch/irc.js';
import { HelixClient } from './twitch/helix.js';
import { LocalWsServer } from './wsServer.js';
import { PcmPlayer } from './audio/pcmPlayer.js';

async function main() {
  const obs = new ObsController(config.obs);

  const tokenManager = new TokenManager(config.twitch);
  await tokenManager.start();

  const helix = new HelixClient({ clientId: config.twitch.clientId, tokenManager });
  const chat = new TwitchChat({ channelLogin: config.twitch.channelLogin, tokenManager });

  const pcmPlayer = new PcmPlayer({ deviceLabelMatch: config.audio.outputDeviceLabel, jitterBufferMs: config.audio.jitterBufferMs });
  await pcmPlayer.start();

  // Le serveur s'abonne aux évènements obs/chat AVANT que ces derniers ne se
  // connectent, pour ne pas rater les évènements "status" initiaux.
  const server = new LocalWsServer({ port: config.localWs.port, token: config.localWs.token, obs, chat, helix, pcmPlayer });
  server.start();

  await obs.connect();
  console.log('[obs] connecté');

  const channel = await helix.init(config.twitch.channelLogin);
  console.log(`[twitch] Helix prêt pour ${channel.display_name} (id ${channel.id})`);

  await chat.connect();
  console.log('[twitch] IRC connecté');

  const shutdown = () => {
    console.log('\nArrêt du service...');
    tokenManager.stop();
    pcmPlayer.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Échec du démarrage du service compagnon:', err);
  process.exit(1);
});
