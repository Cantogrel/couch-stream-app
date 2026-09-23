import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { ENV_PATH, migrateLegacyEnv } from './paths.js';
import { setEnvVar } from './envFile.js';

migrateLegacyEnv();
dotenv.config({ path: ENV_PATH });

// Client ID de l'app Twitch « Couch Stream App » partagée par tous les
// utilisateurs (flux Device Code, pas de secret client embarqué : un Client ID
// n'est pas un secret). Surchargeable par TWITCH_CLIENT_ID.
export const DEFAULT_TWITCH_CLIENT_ID = 'uo0n5gaqqlgm26o089d5cam2jk4u6g';

// Ancienne app Twitch « confidentielle » (supprimée) : un .env qui la référence
// encore est nettoyé, sinon elle primerait sur le Client ID public ci-dessus.
const RETIRED_CLIENT_ID = '6x9xjpr9oltl5amsoop7ixaedupu20';

// Scopes demandés à la connexion Twitch : chat + modération des messages/bans.
export const TWITCH_SCOPES = ['chat:read', 'chat:edit', 'moderator:manage:banned_users', 'moderator:manage:chat_messages'];

// Aucune variable n'est plus obligatoire : c'est l'assistant de premier
// lancement (/setup) qui renseigne OBS et Twitch. Seul le token local est
// généré ici s'il manque, pour que la console PC puisse toujours s'y connecter.
if (process.env.TWITCH_CLIENT_ID === RETIRED_CLIENT_ID) {
  for (const key of ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_REDIRECT_URI']) setEnvVar(key, null);
}

if (!process.env.LOCAL_WS_TOKEN) setEnvVar('LOCAL_WS_TOKEN', randomBytes(24).toString('hex'));

export const config = {
  obs: {
    url: process.env.OBS_WEBSOCKET_URL || 'ws://127.0.0.1:4455',
    password: process.env.OBS_WEBSOCKET_PASSWORD || '',
  },
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID || DEFAULT_TWITCH_CLIENT_ID,
    // Optionnel : uniquement pour une ancienne installation dont l'app Twitch
    // est de type « confidentiel ». Jamais requis par le flux Device Code.
    clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
    // Anciens jetons du .env : lus une seule fois pour être migrés vers le
    // magasin chiffré (voir twitchService.js), puis effacés du .env.
    legacyAccessToken: process.env.TWITCH_ACCESS_TOKEN || '',
    legacyRefreshToken: process.env.TWITCH_REFRESH_TOKEN || '',
    channelLogin: process.env.TWITCH_CHANNEL_LOGIN || '',
  },
  localWs: {
    port: Number(process.env.LOCAL_WS_PORT || 8765),
    token: process.env.LOCAL_WS_TOKEN,
  },
  audio: {
    // Sous-chaîne du libellé du périphérique de lecture Windows (voir
    // decision-vbcable-obs-source-via-websocket-api : "CABLE Output" est le
    // côté capture utilisé par OBS, "CABLE Input" est le côté lecture où ce
    // service doit injecter l'audio micro reçu du téléphone).
    outputDeviceLabel: process.env.VBCABLE_OUTPUT_DEVICE_LABEL || 'CABLE Input (VB-Audio Virtual Cable)',
    // À remonter seulement si des craquements/coupures apparaissent en
    // pratique (Wi-Fi instable) — plus bas = moins de latence perçue.
    jitterBufferMs: Number(process.env.AUDIO_JITTER_BUFFER_MS || 30),
  },
};
