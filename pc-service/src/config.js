import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante: ${name} (voir .env.example)`);
  }
  return value;
}

export const config = {
  obs: {
    url: process.env.OBS_WEBSOCKET_URL || 'ws://127.0.0.1:4455',
    password: process.env.OBS_WEBSOCKET_PASSWORD || '',
  },
  twitch: {
    clientId: required('TWITCH_CLIENT_ID'),
    clientSecret: required('TWITCH_CLIENT_SECRET'),
    accessToken: required('TWITCH_ACCESS_TOKEN'),
    refreshToken: required('TWITCH_REFRESH_TOKEN'),
    // Compte diffuseur/modérateur dont le token a été autorisé (voir
    // decision-app-twitch-enregistree-compte-perso-separe dans le vault).
    channelLogin: process.env.TWITCH_CHANNEL_LOGIN || 'lescopaings_',
  },
  localWs: {
    port: Number(process.env.LOCAL_WS_PORT || 8765),
    token: required('LOCAL_WS_TOKEN'),
  },
};
