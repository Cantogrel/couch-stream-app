'use strict';

// Phase 3 — UI web pure, servie par le service compagnon PC (même port que
// le WebSocket, cf. pc-service/src/staticServer.js). Pas de build step,
// pas de framework : cohérent avec pc-service/public/test*.html, pour
// itérer vite dans Chrome mobile avant l'empaquetage Capacitor (Phase 4).

const SETTINGS_KEY = 'couchStreamApp.settings';
const TIMEOUT_DURATION_S = 600;

const defaultSettings = () => ({
  host: location.protocol.startsWith('http') ? location.hostname : '',
  port: location.protocol.startsWith('http') && location.port ? location.port : '8765',
  token: '',
  notifChat: false,
  notifCooldownS: 45,
  notifMentions: false,
  mentionKeywords: '',
});

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaultSettings(), ...JSON.parse(raw) } : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

const app = {
  settings: loadSettings(),
  ws: null,
  manualDisconnect: false,
  reconnectTimer: null,
  nextId: 1,
  pending: new Map(),
  obs: { scenes: [], currentScene: null, streaming: false, droppedFrames: null, totalFrames: null, congestion: null, micMuted: null, micVolume: null },
  lastChatNotifAt: 0,
  swRegistration: null,
  chatMessagesById: new Map(),
  livePreviewTimer: null,
  streamClock: null,
  mic: { pc: null, stream: null, audioCtx: null, analyser: null, raf: null, sending: false },
};

// ---------- utilitaires UI ----------

const $ = (id) => document.getElementById(id);

// Vrai uniquement dans l'app empaquetée (Phase 4) — le pont natif Capacitor
// s'auto-injecte dans la WebView, absent quand testé dans Chrome (Phase 3).
function isNative() {
  return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

function log(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

window.addEventListener('unhandledrejection', (e) => log('[erreur non gérée] ' + (e.reason?.message || e.reason)));
window.addEventListener('error', (e) => log('[erreur] ' + e.message));

// ---------- onglets ----------

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.tab-btn')) b.classList.remove('active');
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
    // L'aperçu du live n'a de sens que quand on le regarde — pas de polling
    // gaspillé sur les autres onglets.
    if (btn.dataset.tab === 'dashboard') startLivePreview(); else stopLivePreview();
    if (btn.dataset.tab === 'mic') populateMicDevices();
  });
}

// ---------- connexion WebSocket ----------

function setConnected(connected) {
  $('statusDot').className = 'dot ' + (connected ? 'connected' : 'disconnected');
  $('statusText').textContent = connected ? 'connecté' : 'déconnecté';
}

function connect() {
  if (!app.settings.host || !app.settings.port || !app.settings.token) {
    log('[connexion] hôte/port/token manquants — renseigne-les dans Réglages');
    return;
  }
  app.manualDisconnect = false;
  clearTimeout(app.reconnectTimer);

  const url = `ws://${app.settings.host}:${app.settings.port}`;
  log('[connexion] tentative vers ' + url);
  const ws = new WebSocket(url);
  app.ws = ws;

  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: app.settings.token }));

  ws.onclose = (e) => {
    setConnected(false);
    log(`[connexion] fermée (code=${e.code} ${e.reason || ''})`);
    if (!app.manualDisconnect) {
      app.reconnectTimer = setTimeout(connect, 3000);
    }
  };

  ws.onerror = () => log('[connexion] erreur websocket');

  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      setConnected(true);
      log('[connexion] authentifié');
      startKeepAlive();
      break;
    case 'state':
      applyState(msg);
      break;
    case 'chat-history':
      applyChatHistory(msg.messages);
      break;
    case 'event':
      handleEvent(msg);
      break;
    case 'result':
      handleResult(msg);
      break;
    case 'webrtc-answer':
      handleWebrtcAnswer(msg);
      break;
    case 'webrtc-ice':
      handleWebrtcIce(msg);
      break;
    case 'error':
      toast(msg.error);
      log('[erreur serveur] ' + msg.error);
      break;
    default:
      log('[msg] ' + JSON.stringify(msg));
  }
}

function cmd(action, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('non connecté'));
    }
    const id = app.nextId++;
    app.pending.set(id, { resolve, reject });
    app.ws.send(JSON.stringify({ type: 'command', id, action, payload }));
  });
}

function handleResult(msg) {
  const p = app.pending.get(msg.id);
  if (!p) return;
  app.pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.data);
  else p.reject(new Error(msg.error));
}

// ---------- état OBS / dashboard ----------

function applyState(state) {
  Object.assign(app.obs, state);
  if (state.streaming && state.streamDurationMs != null) startStreamClock(state.streamDurationMs);
  else stopStreamClock();
  renderDashboard();
}

function handleEvent(msg) {
  switch (msg.name) {
    case 'obs.scene_changed':
      app.obs.currentScene = msg.sceneName;
      renderDashboard();
      break;
    case 'obs.stream_state':
      app.obs.streaming = msg.active;
      // Un stream qui démarre part de 0 ; un stream qui vient de commencer
      // avant qu'on ait reçu cet évènement (fenêtre de quelques ms) aura une
      // durée légèrement sous-estimée au pire, sans conséquence pratique.
      if (msg.active) startStreamClock(0);
      else stopStreamClock();
      renderDashboard();
      break;
    case 'obs.mic_mute_changed':
      app.obs.micMuted = msg.muted;
      syncMicUI();
      break;
    case 'obs.mic_volume_changed':
      app.obs.micVolume = msg.volume;
      syncMicUI();
      break;
    case 'obs.connection':
      if (!msg.connected) toast('OBS déconnecté côté PC');
      break;
    case 'twitch.connection':
      if (!msg.connected) toast('Twitch IRC déconnecté côté PC');
      break;
    case 'chat.message':
      onChatMessage(msg);
      break;
    case 'chat.message_deleted':
      markMessageDeleted(msg.id, { reason: msg.reason, duration: msg.duration });
      break;
    case 'webrtc.connection':
      $('micSendStatus').textContent = 'état: ' + msg.state;
      break;
    default:
      log('[event] ' + JSON.stringify(msg));
  }
}

function renderDashboard() {
  const o = app.obs;
  $('liveBadge').classList.toggle('hidden', !o.streaming);
  $('streamState').textContent = o.streaming ? 'EN DIRECT' : 'hors ligne';
  renderStreamDuration();

  const btn = $('streamToggleBtn');
  btn.textContent = o.streaming ? 'Arrêter' : 'Démarrer';
  btn.classList.toggle('live', Boolean(o.streaming));

  $('droppedFrames').textContent = o.droppedFrames ?? '–';
  $('totalFrames').textContent = o.totalFrames ?? '–';
  $('congestion').textContent = o.congestion != null ? Math.round(o.congestion * 100) + '%' : '–';

  syncMicUI();
  renderScenes();
}

// Le service n'envoie la durée du stream qu'au moment de l'état initial ou
// d'un changement (scène, mute...) — sans ça, l'affichage restait figé
// entre deux évènements (retour utilisateur : "il faudrait le voir tourner
// en direct"). On ancre la durée connue à l'instant de réception, puis on
// l'incrémente localement chaque seconde, sans aucun aller-retour réseau.
function startStreamClock(baseDurationMs) {
  app.streamClock = { baseDurationMs, anchorAt: Date.now() };
}

function stopStreamClock() {
  app.streamClock = null;
}

function renderStreamDuration() {
  const el = $('streamDuration');
  if (!app.streamClock) { el.textContent = ''; return; }
  const elapsed = app.streamClock.baseDurationMs + (Date.now() - app.streamClock.anchorAt);
  el.textContent = formatDuration(elapsed);
}

setInterval(renderStreamDuration, 1000);

// Reflète l'état du micro OBS à la fois sur le tableau de bord et l'onglet
// Micro (les deux affichent/pilotent la même source OBS).
function syncMicUI() {
  const o = app.obs;
  const muteLabel = o.micMuted == null ? '–' : (o.micMuted ? 'muet' : 'actif');
  $('obsMicState').textContent = muteLabel;
  $('micTabMuteState').textContent = muteLabel;

  // Ne pas écraser le slider pendant que l'utilisateur le manipule — sinon
  // l'écho serveur (InputVolumeChanged) le fait sauter sous le doigt.
  if (o.micVolume != null && document.activeElement !== $('micVolumeSlider')) {
    const pct = Math.round(o.micVolume * 100);
    $('micVolumeSlider').value = pct;
    $('micVolumeValue').textContent = pct;
  }
}

function renderScenes() {
  const div = $('scenes');
  div.innerHTML = '';
  for (const name of app.obs.scenes) {
    const b = document.createElement('button');
    b.className = 'scene-btn' + (name === app.obs.currentScene ? ' current' : '');
    b.textContent = name;
    b.onclick = () => cmd('obs.switchScene', { sceneName: name }).catch((err) => toast(err.message));
    div.appendChild(b);
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

$('streamToggleBtn').addEventListener('click', async () => {
  try {
    if (app.obs.streaming) {
      if (!confirm('Arrêter le stream en cours ?')) return;
      await cmd('obs.stopStream');
    } else {
      await cmd('obs.startStream');
    }
  } catch (err) {
    toast(err.message);
  }
});

$('obsMicToggleBtn').addEventListener('click', async () => {
  try {
    await cmd('obs.toggleMic');
  } catch (err) {
    toast(err.message);
  }
});

$('micTabMuteBtn').addEventListener('click', async () => {
  try {
    await cmd('obs.toggleMic');
  } catch (err) {
    toast(err.message);
  }
});

$('micVolumeSlider').addEventListener('change', async (e) => {
  try {
    await cmd('obs.setMicVolume', { volume: Number(e.target.value) / 100 });
  } catch (err) {
    toast(err.message);
  }
});
$('micVolumeSlider').addEventListener('input', (e) => {
  $('micVolumeValue').textContent = e.target.value;
});

// ---------- aperçu du live ----------

const LIVE_PREVIEW_INTERVAL_MS = 3000;

function startLivePreview() {
  if (app.livePreviewTimer) return;
  fetchScreenshot();
  app.livePreviewTimer = setInterval(fetchScreenshot, LIVE_PREVIEW_INTERVAL_MS);
}

function stopLivePreview() {
  clearInterval(app.livePreviewTimer);
  app.livePreviewTimer = null;
}

async function fetchScreenshot() {
  try {
    const { dataUrl } = await cmd('obs.getScreenshot');
    $('livePreview').src = dataUrl;
    $('livePreviewStatus').textContent = '';
  } catch (err) {
    $('livePreviewStatus').textContent = 'aperçu indisponible: ' + err.message;
  }
}

// ---------- chat ----------

// Rejoué une fois à la connexion (voir wsServer.js) — jamais de notif sur
// du contenu déjà passé, seule l'activité live doit alerter.
function applyChatHistory(messages) {
  for (const m of messages) appendChatMessage(m);
}

function onChatMessage(msg) {
  appendChatMessage(msg);
  // Pas de notif pour ses propres messages (envoyés depuis cette app ou
  // depuis un autre client IRC du même compte) — seule l'activité des
  // autres doit alerter.
  if (msg.self) return;
  checkChatActivity(msg);
  checkMention(msg);
}

function appendChatMessage(msg) {
  app.chatMessagesById.set(String(msg.id), msg);

  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.dataset.msgId = msg.id;
  renderChatMessageContent(div, msg);

  div.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    div.classList.toggle('expanded');
  });

  const chatLog = $('chatLog');
  const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
  chatLog.appendChild(div);
  while (chatLog.children.length > 200) {
    const evicted = chatLog.firstChild;
    app.chatMessagesById.delete(evicted.dataset.msgId);
    chatLog.removeChild(evicted);
  }
  if (atBottom) chatLog.scrollTop = chatLog.scrollHeight;
}

function renderChatMessageContent(div, msg) {
  const authorClass = msg.isBroadcaster ? 'broadcaster' : (msg.isMod ? 'mod' : '');
  const authorHtml = `<span class="author ${authorClass}">${escapeHtml(msg.displayName)}${msg.self ? ' (toi)' : ''}</span>`;

  if (msg.deleted) {
    div.classList.add('deleted');
    const label = msg.reason === 'ban' ? '[banni]'
      : msg.reason === 'timeout' ? `[timeout${msg.duration ? ' ' + Math.round(msg.duration) + 's' : ''}]`
      : '[message supprimé]';
    div.innerHTML = `${authorHtml}<span class="text">${label}</span>`;
    return;
  }

  // Twitch interdit de supprimer les messages du broadcaster/modérateur via
  // l'API (confirmé côté Twitch — voir SUMMARY du vault) : aucune action de
  // modération proposée sur ses propres messages, elle échouerait toujours.
  const actions = msg.self ? '' : `
    <button data-act="delete">Supprimer</button>
    <button data-act="timeout">Timeout 10 min</button>
    <button data-act="ban" class="danger">Ban</button>
  `;
  div.innerHTML = `${authorHtml}<span class="text">${escapeHtml(msg.text)}</span>` +
    (actions ? `<div class="actions">${actions}</div>` : '');

  div.querySelector('[data-act="delete"]')?.addEventListener('click', () =>
    cmd('chat.delete', { messageId: msg.id })
      .then(() => markMessageDeleted(msg.id, { reason: 'delete' }))
      .catch((err) => toast(err.message)));
  div.querySelector('[data-act="timeout"]')?.addEventListener('click', () =>
    cmd('chat.timeout', { username: msg.username, duration: TIMEOUT_DURATION_S }).catch((err) => toast(err.message)));
  div.querySelector('[data-act="ban"]')?.addEventListener('click', () => {
    if (!confirm(`Bannir ${msg.displayName} ?`)) return;
    cmd('chat.ban', { username: msg.username }).catch((err) => toast(err.message));
  });
}

// Appelé en optimiste juste après un chat.delete réussi, et par les
// évènements CLEARMSG/CLEARCHAT relayés par le service (suppression ou
// timeout/ban fait depuis ailleurs) — tous les chemins convergent ici,
// idempotent. `extra` précise la raison affichée (delete/timeout/ban).
function markMessageDeleted(id, extra = {}) {
  const msg = app.chatMessagesById.get(String(id));
  if (!msg || msg.deleted) return;
  Object.assign(msg, { deleted: true }, extra);
  const div = $('chatLog').querySelector(`[data-msg-id="${CSS.escape(String(id))}"]`);
  if (div) renderChatMessageContent(div, msg);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  cmd('chat.send', { message: text }).catch((err) => toast(err.message));
  input.value = '';
});

// ---------- pont natif (Phase 4) ----------

// Service de premier plan (notification persistante + wake lock) qui garde
// le process vivant écran éteint / app en arrière-plan, condition posée dès
// decision-capacitor-plutot-que-pwa. Démarré une fois à la connexion plutôt
// que par bascule — pas de scénario réel où on veut rester connecté sans
// vouloir que le chat/micro restent fiables en arrière-plan.
function startKeepAlive() {
  if (!isNative() || !window.Capacitor.Plugins.KeepAlive) return;
  window.Capacitor.Plugins.KeepAlive.start().catch((err) => log('[keepalive] échec: ' + err.message));
}

// ---------- QR de pairing ----------

const qr = { stream: null, raf: null };

async function startQrScan() {
  try {
    qr.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    return toast('Caméra refusée: ' + err.message);
  }
  $('qrVideo').srcObject = qr.stream;
  $('qrScanner').classList.remove('hidden');
  $('qrScanStatus').textContent = 'Vise le QR affiché sur /pair…';
  tickQrScan();
}

function stopQrScan() {
  if (qr.raf) cancelAnimationFrame(qr.raf);
  qr.raf = null;
  if (qr.stream) { qr.stream.getTracks().forEach((t) => t.stop()); qr.stream = null; }
  $('qrVideo').srcObject = null;
  $('qrScanner').classList.add('hidden');
}

function tickQrScan() {
  const video = $('qrVideo');
  if (video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR) {
    const canvas = $('qrCanvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR(imageData.data, imageData.width, imageData.height);
    if (code) return onQrDecoded(code.data);
  }
  qr.raf = requestAnimationFrame(tickQrScan);
}

function onQrDecoded(text) {
  stopQrScan();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return toast('QR invalide (pas du JSON de pairing)');
  }
  if (!data.host || !data.port || !data.token) return toast('QR invalide (champs manquants)');
  $('cfgHost').value = data.host;
  $('cfgPort').value = String(data.port);
  $('cfgToken').value = data.token;
  toast('Pairing scanné — connexion…');
  $('saveConnBtn').click();
}

$('qrScanBtn').addEventListener('click', startQrScan);
$('qrCancelBtn').addEventListener('click', stopQrScan);

// ---------- notifications ----------

// Web (Chrome, Phase 3) : Chrome pour Android impose
// `ServiceWorkerRegistration.showNotification()` — le constructeur direct
// `new Notification()` y lève "Illegal constructor". Voir sw.js. Inutile côté
// natif (Phase 4), qui passe par @capacitor/local-notifications à la place —
// plus fiable en arrière-plan, c'est tout l'objet de cette phase.
async function initServiceWorker() {
  if (isNative() || !('serviceWorker' in navigator)) return;
  try {
    app.swRegistration = await navigator.serviceWorker.register('sw.js');
  } catch (err) {
    log('[notification] service worker indisponible: ' + err.message);
  }
}

// Canal + notification postée nativement (KeepAlivePlugin.ensureAlarmChannel
// / postAlert) plutôt que via l'API JS de @capacitor/local-notifications :
// il faut USAGE_ALARM (contourne le mode silencieux) et setBypassDnd(true)
// (contourne Ne pas déranger, si l'utilisateur a accordé l'accès), ni l'un
// ni l'autre n'est exposé côté JS — et schedule() écrase de toute façon le
// son du canal avec un son par défaut sur cet appareil (voir postAlert côté
// natif). Id de canal distinct de l'ancien "chat-alerts" pour repartir propre
// (un canal Android est immuable une fois créé).

// IDs fixes (pas de Date.now()) : chaque nouvelle alerte remplace la
// précédente de la même catégorie au lieu de s'empiler. Avec un id qui change
// à chaque notif, Android finit par les auto-grouper après quelques-unes et
// n'alerte plus (son/vibration/bannière) que pour le groupe — bug constaté
// en test réel (12 notifs postées, alerte perçue une seule fois).
const NOTIF_ID_CHAT = 9001;
const NOTIF_ID_MENTION = 9002;

async function ensureNotifChannel() {
  if (!isNative()) return;
  try {
    // Nettoyage best-effort de l'ancien canal (Phase 4, avant l'ajout du
    // contournement DND/silencieux) — un canal orphelin n'est pas grave en
    // soi, mais autant ne pas laisser deux canaux "alertes chat" dans les
    // réglages système de l'utilisateur.
    await window.Capacitor.Plugins.LocalNotifications.deleteChannel({ id: 'chat-alerts' });
  } catch {
    // Rien à nettoyer (canal jamais créé sur cet appareil) — normal.
  }
  try {
    await window.Capacitor.Plugins.KeepAlive.ensureAlarmChannel();
  } catch (err) {
    log('[notification] création du canal échouée: ' + err.message);
  }
}

// Demande la permission au moment où l'utilisateur coche la case dans
// Réglages plutôt que d'attendre la première notif réelle — sinon la popup
// système surgit au moment le moins pratique (un message arrive en direct),
// retour utilisateur explicite.
async function ensureNotifPermission() {
  if (isNative()) {
    const current = await window.Capacitor.Plugins.LocalNotifications.checkPermissions();
    if (current.display === 'granted') return true;
    const res = await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
    return res.display === 'granted';
  }
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const perm = await Notification.requestPermission();
  return perm === 'granted';
}

// Notifie dès le premier message (utile vu le faible volume de messages
// attendu), puis au plus une fois par cooldown même en cas d'afflux —
// évite le spam sans jamais rater un premier commentaire. Uniquement en
// live : pas d'alerte à propos d'un chat qui n'intéresse personne hors stream
// (retour utilisateur explicite).
function checkChatActivity(msg) {
  if (!app.settings.notifChat || !app.obs.streaming) {
    console.log('[notification] checkChatActivity bloqué', { notifChat: app.settings.notifChat, streaming: app.obs.streaming });
    return;
  }
  const now = Date.now();
  const cooldownMs = Math.max(1, app.settings.notifCooldownS) * 1000;
  const remainingMs = cooldownMs - (now - app.lastChatNotifAt);
  if (remainingMs > 0) {
    console.log(`[notification] cooldown actif, encore ${Math.round(remainingMs / 1000)}s`);
    return;
  }
  app.lastChatNotifAt = now;
  console.log('[notification] déclenchement notify() pour chat.message');
  notify(NOTIF_ID_CHAT, `${msg.displayName} dans le chat`, msg.text);
}

function checkMention(msg) {
  if (!app.settings.notifMentions || !app.obs.streaming) return;
  const keywords = app.settings.mentionKeywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!keywords.length) return;
  const text = msg.text.toLowerCase();
  if (keywords.some((k) => text.includes(k))) {
    notify(NOTIF_ID_MENTION, `Mention par ${msg.displayName}`, msg.text);
  }
}

async function notify(id, title, body) {
  if (isNative()) {
    try {
      // KeepAlive.postAlert, pas LocalNotifications.schedule() : ce dernier
      // fixe toujours un son par défaut sur la notification elle-même, qui
      // prend le pas sur les AudioAttributes/USAGE_ALARM du canal sur cet
      // appareil — voir le commentaire dans KeepAlivePlugin.postAlert.
      await window.Capacitor.Plugins.KeepAlive.postAlert({ id, title, body });
      console.log('[notification] postAlert() ok');
    } catch (err) {
      log('[notification] échec native: ' + err.message);
      console.error('[notification] échec native', err.message, JSON.stringify(err));
    }
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (app.swRegistration) {
    try {
      await app.swRegistration.showNotification(title, { body });
      return;
    } catch (err) {
      log('[notification] échec via service worker: ' + err.message);
    }
  }
  try {
    new Notification(title, { body });
  } catch (err) {
    log('[notification] échec: ' + err.message);
  }
}

$('notifPermBtn').addEventListener('click', async () => {
  const granted = await ensureNotifPermission();
  toast('Permission notifications: ' + (granted ? 'accordée' : 'refusée'));
});

$('notifTestBtn').addEventListener('click', () => {
  notify(NOTIF_ID_CHAT, 'Test Couch Stream App', 'Si tu vois ceci, les notifications marchent.');
});

// Demande la permission dès qu'on active une case de notif, pas seulement via
// le bouton dédié — évite que la popup système n'apparaisse plus tard, en
// pleine réception d'un message.
async function onNotifCheckboxChange(e) {
  if (!e.target.checked) return;
  const granted = await ensureNotifPermission();
  if (!granted) toast('Permission notifications refusée — les alertes ne fonctionneront pas');
}
$('cfgNotifChat').addEventListener('change', onNotifCheckboxChange);
$('cfgNotifMentions').addEventListener('change', onNotifCheckboxChange);

// ---------- micro WebRTC (envoi vers le PC) ----------

function forceOpusPtime(sdp, ptimeMs) {
  const lines = sdp.split('\r\n');
  const startIdx = lines.findIndex((l) => l.startsWith('m=audio'));
  if (startIdx === -1) return sdp;
  let endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith('m='));
  if (endIdx === -1) endIdx = lines.length;
  const before = lines.slice(0, startIdx + 1);
  const audioSection = lines.slice(startIdx + 1, endIdx).filter((l) => !l.startsWith('a=ptime:'));
  const after = lines.slice(endIdx);
  return [...before, `a=ptime:${ptimeMs}`, ...audioSection, ...after].join('\r\n');
}

async function startMicSend() {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return toast('Connecte-toi au service d\'abord');
  if (!window.isSecureContext) {
    log('[micro] origine non sécurisée — getUserMedia sera indisponible avant empaquetage Capacitor.');
  }
  try {
    const deviceId = $('micDeviceSelect').value;
    app.mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    // RECORD_AUDIO vient d'être accordée (getUserMedia a réussi) — on relance
    // le service de premier plan pour qu'il se promeuve au type "microphone"
    // (voir le commentaire dans KeepAliveService.java : impossible de le
    // déclarer avant que la permission soit accordée, sur Android 14+).
    startKeepAlive();
    startMeter(app.mic.stream);

    const pc = new RTCPeerConnection({ iceServers: [] });
    app.mic.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) app.ws.send(JSON.stringify({ type: 'webrtc-ice', candidate: e.candidate.toJSON() }));
    };
    pc.onconnectionstatechange = () => log('[webrtc local] état: ' + pc.connectionState);
    for (const track of app.mic.stream.getTracks()) pc.addTrack(track, app.mic.stream);

    const offer = await pc.createOffer();
    const sdp = forceOpusPtime(offer.sdp, 10);
    await pc.setLocalDescription({ type: 'offer', sdp });
    app.ws.send(JSON.stringify({ type: 'webrtc-offer', sdp }));

    app.mic.sending = true;
    $('micSendBtn').textContent = 'Couper l\'envoi';
    $('micSendBtn').classList.add('live');
  } catch (err) {
    toast('Micro refusé: ' + err.message);
    log('[erreur micro] ' + err.name + ': ' + err.message);
  }
}

function stopMicSend() {
  if (app.mic.pc) { app.mic.pc.close(); app.mic.pc = null; }
  if (app.mic.stream) { app.mic.stream.getTracks().forEach((t) => t.stop()); app.mic.stream = null; }
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify({ type: 'webrtc-hangup' }));
  stopMeter();
  app.mic.sending = false;
  $('micSendBtn').textContent = 'Démarrer l\'envoi';
  $('micSendBtn').classList.remove('live');
  $('micSendStatus').textContent = '';
}

function handleWebrtcAnswer(msg) {
  if (!app.mic.pc) return;
  app.mic.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
    .then(() => log('[webrtc] réponse appliquée'))
    .catch((err) => log('[webrtc] erreur: ' + err.message));
}

function handleWebrtcIce(msg) {
  if (!app.mic.pc) return;
  app.mic.pc.addIceCandidate(msg.candidate).catch((err) => log('[webrtc] candidat ICE refusé: ' + err.message));
}

// Cas d'usage explicite : un micro externe branché sur le téléphone plutôt
// que le micro intégré. Les libellés ne sont disponibles qu'après une
// première autorisation micro accordée (limitation navigateur, pas un bug).
async function populateMicDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const select = $('micDeviceSelect');
    const current = select.value;
    select.innerHTML = '<option value="">Micro par défaut</option>';
    let n = 1;
    for (const d of devices.filter((d) => d.kind === 'audioinput')) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Micro ${n++}`;
      select.appendChild(opt);
    }
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  } catch (err) {
    log('[micro] liste des sources indisponible: ' + err.message);
  }
}

if (navigator.mediaDevices) navigator.mediaDevices.ondevicechange = populateMicDevices;

function startMeter(stream) {
  app.mic.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = app.mic.audioCtx.createMediaStreamSource(stream);
  app.mic.analyser = app.mic.audioCtx.createAnalyser();
  app.mic.analyser.fftSize = 512;
  source.connect(app.mic.analyser);
  const data = new Uint8Array(app.mic.analyser.frequencyBinCount);
  const tick = () => {
    app.mic.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    $('meterBar').style.width = Math.min(100, (peak / 128) * 100) + '%';
    app.mic.raf = requestAnimationFrame(tick);
  };
  tick();
}

function stopMeter() {
  if (app.mic.raf) cancelAnimationFrame(app.mic.raf);
  if (app.mic.audioCtx) { app.mic.audioCtx.close(); app.mic.audioCtx = null; }
  $('meterBar').style.width = '0%';
}

$('micSendBtn').addEventListener('click', () => {
  if (app.mic.sending) stopMicSend();
  else startMicSend();
});

// ---------- réglages ----------

function populateSettingsForm() {
  $('cfgHost').value = app.settings.host;
  $('cfgPort').value = app.settings.port;
  $('cfgToken').value = app.settings.token;
  $('cfgNotifChat').checked = app.settings.notifChat;
  $('cfgNotifCooldown').value = app.settings.notifCooldownS;
  $('cfgNotifMentions').checked = app.settings.notifMentions;
  $('cfgMentionKeywords').value = app.settings.mentionKeywords;
}

function readSettingsForm() {
  app.settings.host = $('cfgHost').value.trim();
  app.settings.port = $('cfgPort').value.trim();
  app.settings.token = $('cfgToken').value.trim();
  app.settings.notifChat = $('cfgNotifChat').checked;
  app.settings.notifCooldownS = Number($('cfgNotifCooldown').value) || 45;
  app.settings.notifMentions = $('cfgNotifMentions').checked;
  app.settings.mentionKeywords = $('cfgMentionKeywords').value;
  saveSettings(app.settings);
}

// Persiste les réglages de notifications dès qu'ils changent, sans attendre
// le bouton "Enregistrer et connecter" (qui ne concerne que la connexion).
for (const id of ['cfgNotifChat', 'cfgNotifCooldown', 'cfgNotifMentions', 'cfgMentionKeywords']) {
  $(id).addEventListener('change', readSettingsForm);
}

$('saveConnBtn').addEventListener('click', () => {
  readSettingsForm();
  if (app.ws) { app.manualDisconnect = true; app.ws.close(); }
  connect();
});

// ---------- démarrage ----------

initServiceWorker();
ensureNotifChannel();
populateSettingsForm();
populateMicDevices();
startLivePreview(); // le tableau de bord est l'onglet actif par défaut
if (app.settings.host && app.settings.port && app.settings.token) {
  connect();
} else {
  log('[connexion] renseigne hôte/port/token dans Réglages pour te connecter');
  document.querySelector('.tab-btn[data-tab="settings"]').click();
}
