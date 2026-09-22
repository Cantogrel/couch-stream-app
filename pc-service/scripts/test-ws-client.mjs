// Client de test au clavier pour le serveur WebSocket local (Phase 1) —
// permet de valider le service compagnon avant toute UI mobile/web.
// Usage: npm run test-ws
import 'dotenv/config';
import readline from 'node:readline/promises';
import WebSocket from 'ws';

const port = process.env.LOCAL_WS_PORT || 8765;
const token = process.env.LOCAL_WS_TOKEN;
if (!token) {
  console.error('LOCAL_WS_TOKEN manquant dans .env');
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let nextId = 1;

const HELP = `Commandes disponibles:
  state                         état courant (scènes, stream, micro)
  scene <nom>                   changer de scène
  start / stop                  démarrer / arrêter le stream
  mute / unmute / togglemic     micro téléphone
  say <message>                 envoyer un message dans le chat
  delete <messageId>            supprimer un message
  timeout <user> <sec> [raison] timeout un utilisateur
  ban <user> [raison]           ban un utilisateur
  unban <user>                  unban un utilisateur
  help                          afficher cette aide
  quit                          quitter`;

function send(action, payload = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ type: 'command', id, action, payload }));
  return id;
}

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'welcome') {
    console.log(`Connecté et authentifié.\n${HELP}\n`);
  } else if (msg.type === 'state') {
    console.log('[état]', msg);
  } else if (msg.type === 'event' && msg.name === 'chat.message') {
    console.log(`[chat] ${msg.displayName}: ${msg.text}  (id=${msg.id})`);
  } else if (msg.type === 'event') {
    console.log('[event]', msg);
  } else if (msg.type === 'result') {
    console.log(`[résultat #${msg.id}]`, msg.ok ? msg.data ?? 'ok' : `erreur: ${msg.error}`);
  } else {
    console.log('[?]', msg);
  }
});

ws.on('close', (code, reason) => {
  console.log(`Connexion fermée (${code}) ${reason}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('Erreur WebSocket:', err.message);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function repl() {
  for (;;) {
    const line = (await rl.question('> ')).trim();
    if (!line) continue;
    const [cmd, ...rest] = line.split(' ');
    const arg = rest.join(' ');

    switch (cmd) {
      case 'help':
        console.log(HELP);
        break;
      case 'state':
        send('state.get');
        break;
      case 'scene':
        send('obs.switchScene', { sceneName: arg });
        break;
      case 'start':
        send('obs.startStream');
        break;
      case 'stop':
        send('obs.stopStream');
        break;
      case 'mute':
        send('obs.setMicMuted', { muted: true });
        break;
      case 'unmute':
        send('obs.setMicMuted', { muted: false });
        break;
      case 'togglemic':
        send('obs.toggleMic');
        break;
      case 'say':
        send('chat.send', { message: arg });
        break;
      case 'delete':
        send('chat.delete', { messageId: arg });
        break;
      case 'timeout': {
        const [user, seconds, ...reasonParts] = rest;
        send('chat.timeout', { username: user, duration: Number(seconds) || 600, reason: reasonParts.join(' ') });
        break;
      }
      case 'ban': {
        const [user, ...reasonParts] = rest;
        send('chat.ban', { username: user, reason: reasonParts.join(' ') });
        break;
      }
      case 'unban':
        send('chat.unban', { username: arg });
        break;
      case 'quit':
      case 'exit':
        ws.close();
        rl.close();
        return;
      default:
        console.log(`Commande inconnue: ${cmd}. Tape "help".`);
    }
  }
}

ws.on('open', () => repl());
