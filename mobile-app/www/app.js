'use strict';

// Phase 3 — UI web pure, servie par le service compagnon PC (même port que
// le WebSocket, cf. pc-service/src/staticServer.js). Pas de build step,
// pas de framework : cohérent avec pc-service/public/test*.html, pour
// itérer vite dans Chrome mobile avant l'empaquetage Capacitor (Phase 4).

const SETTINGS_KEY = 'couchStreamApp.settings';
// Version du protocole PC <-> app (voir pc-service/src/version.js).
const APP_PROTOCOL = 1;
const APP_VERSION_FALLBACK = '1.0';
const TIMEOUT_DURATION_S = 600;

const defaultSettings = () => ({
  host: location.protocol.startsWith('http') ? location.hostname : '',
  port: location.protocol.startsWith('http') && location.port ? location.port : '8765',
  token: '',
  pcId: '',
  pcName: '',
  deviceName: 'Mon téléphone',
  notifChat: false,
  notifCooldownS: 45,
  notifMentions: false,
  mentionKeywords: '',
  notifHealth: false,
  healthDropPct: 2,
  healthCongestionPct: 30,
  notifDisconnect: false,
  ignoredUsers: '',
  micGainPct: 100,
  micLimiter: false,
  jitterMs: 30,
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
  failStreak: 0,
  appVersion: APP_VERSION_FALLBACK,
  pcVersion: null,
  discovering: false,
  lastDiscoveryAt: 0,
  nextId: 1,
  pending: new Map(),
  obs: { scenes: [], currentScene: null, streaming: false, droppedFrames: null, totalFrames: null, congestion: null, micMuted: null, micVolume: null },
  lastChatNotifAt: 0,
  swRegistration: null,
  chatMessagesById: new Map(),
  livePreviewTimer: null,
  streamClock: null,
  healthTimer: null,
  healthSamples: [],
  lastHealthAlertAt: 0,
  mic: { pc: null, stream: null, audioCtx: null, analyser: null, gainNode: null, limiter: null, raf: null, sending: false },
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

  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: app.settings.token, appVersion: app.appVersion, protocol: APP_PROTOCOL }));

  ws.onclose = (e) => {
    setConnected(false);
    log(`[connexion] fermée (code=${e.code} ${e.reason || ''})`);
    // 4003 : token refusé (jumelage révoqué sur le PC, ou PC réinitialisé).
    // Réessayer en boucle n'y changerait rien.
    if (e.code === 4004) {
      // Le PC refuse cette version de l'app (trop ancienne) : inutile de boucler.
      app.manualDisconnect = true;
      return showCompat("L'app est trop ancienne pour ce PC. Mets-la à jour : sur le PC, « Téléphone & infos » → « Installer l'app ».");
    }
    if (e.code === 4003 && !app.manualDisconnect) {
      app.manualDisconnect = true;
      app.settings.token = '';
      saveSettings(app.settings);
      populateSettingsForm();
      renderPcInfo();
      return toast('Jumelage refusé par le PC : scanne à nouveau le QR');
    }
    if (!app.manualDisconnect) {
      // Plusieurs échecs de suite = le PC a sans doute changé d'adresse : on le
      // cherche sur le réseau avant de retenter.
      if (++app.failStreak >= 2) rediscover();
      app.reconnectTimer = setTimeout(connect, 3000);
    }
  };

  ws.onerror = () => log('[connexion] erreur websocket');

  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
}

function showCompat(text) {
  const el = $('compatBanner');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

async function loadAppVersion() {
  try {
    if (isNative() && window.Capacitor.Plugins.App) {
      const info = await window.Capacitor.Plugins.App.getInfo();
      app.appVersion = info.version;
    }
  } catch {
    // version de repli conservée
  }
  renderAbout();
}

function renderAbout() {
  $('aboutInfo').textContent = `App v${app.appVersion} · PC ${app.pcVersion ? 'v' + app.pcVersion : 'non connecté'}`;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      app.failStreak = 0;
      app.pcVersion = msg.pcVersion || null;
      renderAbout();
      // PC plus récent que l'app (protocole supérieur) : certaines fonctions peuvent manquer.
      if (msg.protocol > APP_PROTOCOL) showCompat("Ce PC est plus récent que l'app : mets l'app à jour (sur le PC, « Téléphone & infos » → « Installer l'app »).");
      else showCompat(null);
      learnPc();
      setConnected(true);
      log('[connexion] authentifié');
      // Le PC oublie le buffer de gigue à son redémarrage : on réapplique le
      // choix mémorisé du téléphone à chaque connexion.
      if (app.settings.jitterMs !== 30) cmd('audio.setJitterBuffer', { ms: app.settings.jitterMs }).catch(() => {});
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
    case 'incompatible':
      showCompat("L'app est trop ancienne pour ce PC. Mets-la à jour : sur le PC, « Téléphone & infos » → « Installer l'app ».");
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
      if (!msg.connected) {
        toast('OBS déconnecté côté PC');
        alertDisconnect('OBS');
      }
      break;
    case 'twitch.connection':
      if (!msg.connected) {
        toast('Twitch IRC déconnecté côté PC');
        alertDisconnect('Twitch');
      }
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
  if (!o.streaming) renderHealth(null);
}

// ---------- santé du stream (Phase 5) ----------

const HEALTH_INTERVAL_MS = 2000;
const HEALTH_WINDOW_MS = 60000;
const HEALTH_ALERT_COOLDOWN_MS = 120000;
const NOTIF_ID_HEALTH = 9003;
const NOTIF_ID_DISCONNECT = 9004;

function renderHealth(h) {
  $('bitrate').textContent = h?.bitrateKbps ?? '–';
  $('fps').textContent = h ? h.fps : '–';
  $('cpu').textContent = h ? h.cpuPct + '%' : '–';
  if (h) {
    $('droppedFrames').textContent = h.droppedFrames ?? '–';
    $('totalFrames').textContent = h.totalFrames ?? '–';
    $('congestion').textContent = h.congestion != null ? Math.round(h.congestion * 100) + '%' : '–';
  }
}

async function pollHealth() {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return;
  const onDashboard = $('tab-dashboard').classList.contains('active');
  // Hors live et hors tableau de bord : rien à surveiller ni à afficher.
  if (!app.obs.streaming && !onDashboard) return;
  try {
    const h = await cmd('obs.getHealth');
    $('healthStatus').textContent = '';
    if (!h.streaming) { app.healthSamples = []; return renderHealth(null); }
    renderHealth(h);
    checkHealth(h);
  } catch (err) {
    $('healthStatus').textContent = 'santé indisponible: ' + err.message;
  }
}

// Alerte sur la tendance récente, pas sur le cumul depuis le début du live :
// un pic de frames perdues il y a 2h ne doit pas déclencher d'alerte à vie.
function checkHealth(h) {
  const now = Date.now();
  app.healthSamples.push({ at: now, dropped: h.droppedFrames, total: h.totalFrames });
  while (app.healthSamples.length > 1 && now - app.healthSamples[0].at > HEALTH_WINDOW_MS) app.healthSamples.shift();
  if (!app.settings.notifHealth) return;
  if (now - app.lastHealthAlertAt < HEALTH_ALERT_COOLDOWN_MS) return;

  const first = app.healthSamples[0];
  const dTotal = h.totalFrames - first.total;
  const dropPct = dTotal > 0 ? ((h.droppedFrames - first.dropped) / dTotal) * 100 : 0;
  const congestionPct = (h.congestion ?? 0) * 100;

  const problems = [];
  if (dropPct >= app.settings.healthDropPct) problems.push(`${dropPct.toFixed(1)}% de frames perdues`);
  if (congestionPct >= app.settings.healthCongestionPct) problems.push(`congestion ${Math.round(congestionPct)}%`);
  if (!problems.length) return;
  app.lastHealthAlertAt = now;
  notify(NOTIF_ID_HEALTH, 'Stream : problème de connexion', problems.join(' · '));
}

function alertDisconnect(what) {
  if (!app.settings.notifDisconnect || !app.obs.streaming) return;
  notify(NOTIF_ID_DISCONNECT, `${what} déconnecté`, `${what} a perdu la connexion pendant le live.`);
}

app.healthTimer = setInterval(pollHealth, HEALTH_INTERVAL_MS);

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
    $('livePreview').classList.remove('hidden');
    $('livePreviewPlaceholder').classList.add('hidden');
  } catch (err) {
    // Pas d'image cassée : on masque l'<img> et on explique.
    $('livePreview').classList.add('hidden');
    $('livePreviewPlaceholder').classList.remove('hidden');
    const noObs = /OBS|connect|null|undefined/i.test(err.message);
    $('livePreviewTitle').textContent = noObs ? "OBS n'est pas connecté" : 'Aperçu indisponible';
    $('livePreviewStatus').textContent = noObs
      ? "L'aperçu reviendra tout seul dès qu'OBS sera ouvert sur le PC."
      : err.message;
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
  if (isIgnoredUser(msg.username)) return;
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
    // Résolution élevée : à 640x480 par défaut, un QR affiché sur écran occupe
    // trop peu de pixels pour rester lisible dès que la mise au point flanche.
    qr.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    return toast('Caméra refusée: ' + err.message);
  }
  $('qrVideo').srcObject = qr.stream;
  $('qrScanner').classList.remove('hidden');
  $('qrScanStatus').textContent = 'Vise le QR affiché sur le PC — touche l\'image pour faire la mise au point.';
  setupQrCamera(qr.stream.getVideoTracks()[0]);
  tickQrScan();
}

// Mise au point continue si la caméra la propose, mise au point à la demande
// en touchant l'image (comme l'appareil photo), et zoom pour scanner de plus
// loin — un QR d'écran se lit mal de trop près, là où l'autofocus décroche.
function setupQrCamera(track) {
  qr.track = track;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const modes = caps.focusMode || [];
  const apply = (advanced) => track.applyConstraints({ advanced: [advanced] }).catch(() => {});
  if (modes.includes('continuous')) apply({ focusMode: 'continuous' });

  const view = document.querySelector('.qr-view');
  view.onclick = (e) => {
    const ring = $('qrFocusRing');
    const r = view.getBoundingClientRect();
    ring.style.left = e.clientX - r.left + 'px';
    ring.style.top = e.clientY - r.top + 'px';
    ring.classList.remove('hidden');
    ring.style.animation = 'none';
    void ring.offsetWidth; // relance l'animation
    ring.style.animation = '';
    setTimeout(() => ring.classList.add('hidden'), 900);
    // Relance la mise au point : passage par « single-shot » puis retour en continu.
    if (modes.includes('single-shot')) {
      apply({ focusMode: 'single-shot' });
      if (modes.includes('continuous')) setTimeout(() => apply({ focusMode: 'continuous' }), 1200);
    } else if (modes.includes('continuous')) {
      apply({ focusMode: 'manual' });
      setTimeout(() => apply({ focusMode: 'continuous' }), 150);
    }
  };

  const zoom = caps.zoom;
  $('qrZoomRow').classList.toggle('hidden', !zoom);
  if (zoom) {
    const slider = $('qrZoom');
    slider.min = zoom.min; slider.max = Math.min(zoom.max, 5); slider.step = zoom.step || 0.1;
    slider.value = zoom.min;
    slider.oninput = () => apply({ zoom: Number(slider.value) });
  }
}

function stopQrScan() {
  if (qr.raf) cancelAnimationFrame(qr.raf);
  qr.raf = null;
  if (qr.stream) { qr.stream.getTracks().forEach((t) => t.stop()); qr.stream = null; }
  qr.track = null;
  $('qrVideo').srcObject = null;
  $('qrScanner').classList.add('hidden');
}

// Analyse en 800 px de large max : plus rapide que la pleine résolution (donc
// plus d'essais par seconde) tout en gardant assez de détail pour le QR.
const QR_SCAN_MAX_WIDTH = 800;
let qrLastScanAt = 0;

function tickQrScan() {
  const video = $('qrVideo');
  const now = performance.now();
  if (video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR && now - qrLastScanAt > 80) {
    qrLastScanAt = now;
    const canvas = $('qrCanvas');
    const scale = Math.min(1, QR_SCAN_MAX_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
    if (code) return onQrDecoded(code.data);
  }
  qr.raf = requestAnimationFrame(tickQrScan);
}

async function onQrDecoded(text) {
  stopQrScan();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return toast('QR invalide (pas un QR de pairing)');
  }
  if (!data.host || !data.port) return toast('QR invalide (champs manquants)');

  // Ancien format {host, port, token} (PC non mis à jour) : accepté tel quel.
  if (!data.code) {
    if (!data.token) return toast('QR invalide (champs manquants)');
    Object.assign(app.settings, { host: data.host, port: String(data.port), token: data.token });
    return finishPairing('Pairing scanné — connexion…');
  }

  // QR à code unique : échangé contre un token propre à ce téléphone.
  toast('Jumelage en cours…');
  try {
    const res = await fetch(`http://${data.host}:${data.port}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ code: data.code, name: app.settings.deviceName }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'refusé');
    Object.assign(app.settings, { host: data.host, port: String(data.port), token: body.token, pcId: body.pcId, pcName: body.name });
    finishPairing(`Jumelé avec ${body.name}`);
  } catch (err) {
    toast('Jumelage échoué : ' + err.message + ' (le QR expire au bout de 10 min, réaffiche-le sur le PC)');
  }
}

function finishPairing(message) {
  saveSettings(app.settings);
  populateSettingsForm();
  renderPcInfo();
  toast(message);
  if (app.ws) { app.manualDisconnect = true; app.ws.close(); }
  app.failStreak = 0;
  connect();
}

// ---------- découverte du PC (IP qui change) ----------

const DISCOVERY_COOLDOWN_MS = 30000;

function renderPcInfo() {
  const el = $('pcInfo');
  if (!app.settings.token) {
    el.className = 'pc-info none';
    el.textContent = 'Aucun PC jumelé.';
  } else {
    el.className = 'pc-info';
    el.innerHTML = `PC jumelé : <b>${escapeHtml(app.settings.pcName || 'PC')}</b> (${escapeHtml(app.settings.host)})`;
  }
}

// Interroge /hello : identité du PC (aucun secret). null si ce n'est pas un
// service Couch Stream ou s'il ne répond pas assez vite.
async function probeHello(host, port, timeoutMs = 900) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/hello`, { signal: ctl.signal, cache: 'no-store' });
    const info = await res.json();
    return info.app === 'couch-stream' ? info : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// mDNS natif (plugin Discovery) : marche même si le sous-réseau a changé.
async function discoverViaMdns() {
  if (!isNative() || !window.Capacitor.Plugins.Discovery) return [];
  try {
    const { services } = await window.Capacitor.Plugins.Discovery.find({ timeoutMs: 3500 });
    return services || [];
  } catch (err) {
    log('[découverte] mDNS: ' + err.message);
    return [];
  }
}

// Repli : balayage du /24 de la dernière adresse connue (le cas courant d'un
// bail DHCP qui change dans le même réseau).
async function discoverViaSubnetScan() {
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(app.settings.host || '');
  if (!m) return [];
  const port = app.settings.port || '8765';
  const found = [];
  const hosts = Array.from({ length: 254 }, (_, i) => `${m[1]}.${i + 1}`);
  for (let i = 0; i < hosts.length; i += 48) {
    const batch = await Promise.all(hosts.slice(i, i + 48).map(async (h) => {
      const info = await probeHello(h, port);
      return info ? { host: h, port: info.port, id: info.id, name: info.name } : null;
    }));
    found.push(...batch.filter(Boolean));
    if (found.length) break;
  }
  return found;
}

// Renvoie le PC qui correspond à celui jumelé (même id), ou l'unique PC
// trouvé si on ne connaît pas encore son id (jumelage d'avant cette version).
function pickPc(services) {
  if (app.settings.pcId) return services.find((s) => s.id === app.settings.pcId) || null;
  return services.length === 1 ? services[0] : null;
}

async function rediscover({ manual = false } = {}) {
  if (app.discovering) return;
  if (!manual && Date.now() - app.lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) return;
  app.discovering = true;
  app.lastDiscoveryAt = Date.now();
  if (manual) toast('Recherche du PC…');
  try {
    let pc = pickPc(await discoverViaMdns());
    if (!pc) pc = pickPc(await discoverViaSubnetScan());
    if (!pc) {
      log('[découverte] PC introuvable');
      if (manual) toast('PC introuvable sur le réseau : est-il allumé, sur le même Wi-Fi ?');
      return;
    }
    log(`[découverte] PC retrouvé: ${pc.host}:${pc.port}`);
    Object.assign(app.settings, { host: pc.host, port: String(pc.port), pcId: pc.id, pcName: pc.name || app.settings.pcName });
    saveSettings(app.settings);
    populateSettingsForm();
    renderPcInfo();
    if (manual) toast('PC retrouvé : ' + pc.host);
    clearTimeout(app.reconnectTimer);
    app.failStreak = 0;
    if (app.ws) { app.manualDisconnect = true; app.ws.close(); }
    connect();
  } finally {
    app.discovering = false;
  }
}

// Jumelage fait avant cette version : on complète l'identité du PC à la
// première connexion réussie, pour pouvoir le retrouver plus tard.
async function learnPc() {
  if (app.settings.pcId) return;
  const info = await probeHello(app.settings.host, app.settings.port, 2000);
  if (!info) return;
  Object.assign(app.settings, { pcId: info.id, pcName: info.name });
  saveSettings(app.settings);
  renderPcInfo();
}

$('qrScanBtn').addEventListener('click', startQrScan);
$('qrCancelBtn').addEventListener('click', stopQrScan);
$('findPcBtn').addEventListener('click', () => rediscover({ manual: true }));

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
function isIgnoredUser(username) {
  const ignored = app.settings.ignoredUsers.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  return ignored.includes(String(username).toLowerCase());
}

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
$('cfgNotifHealth').addEventListener('change', onNotifCheckboxChange);
$('cfgNotifDisconnect').addEventListener('change', onNotifCheckboxChange);

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
    const raw = await navigator.mediaDevices.getUserMedia({
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
    app.mic.stream = raw;
    const processed = buildMicChain(raw);

    const pc = new RTCPeerConnection({ iceServers: [] });
    app.mic.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) app.ws.send(JSON.stringify({ type: 'webrtc-ice', candidate: e.candidate.toJSON() }));
    };
    pc.onconnectionstatechange = () => log('[webrtc local] état: ' + pc.connectionState);
    for (const track of processed.getTracks()) pc.addTrack(track, processed);

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

// Chaîne source → gain → limiteur → (VU-mètre + flux envoyé). Le VU-mètre
// mesure le signal traité, donc exactement ce que le PC reçoit. Le limiteur
// est un compresseur toujours en place, rendu transparent (ratio 1) quand
// désactivé — permet de le basculer en direct sans reconstruire la chaîne.
function buildMicChain(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume?.();
  app.mic.audioCtx = ctx;
  const source = ctx.createMediaStreamSource(stream);
  app.mic.gainNode = ctx.createGain();
  app.mic.limiter = ctx.createDynamicsCompressor();
  const dest = ctx.createMediaStreamDestination();
  source.connect(app.mic.gainNode);
  app.mic.gainNode.connect(app.mic.limiter);
  app.mic.limiter.connect(dest);
  applyMicAudioSettings();
  startMeter(app.mic.limiter);
  return dest.stream;
}

function applyMicAudioSettings() {
  if (app.mic.gainNode) app.mic.gainNode.gain.value = app.settings.micGainPct / 100;
  const l = app.mic.limiter;
  if (!l) return;
  if (app.settings.micLimiter) {
    l.threshold.value = -6; l.knee.value = 0; l.ratio.value = 20; l.attack.value = 0.003; l.release.value = 0.1;
  } else {
    l.threshold.value = 0; l.knee.value = 0; l.ratio.value = 1;
  }
}

function startMeter(node) {
  app.mic.analyser = app.mic.audioCtx.createAnalyser();
  app.mic.analyser.fftSize = 512;
  node.connect(app.mic.analyser);
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
  app.mic.gainNode = null;
  app.mic.limiter = null;
  $('meterBar').style.width = '0%';
}

$('micGainSlider').addEventListener('input', (e) => {
  $('micGainValue').textContent = e.target.value;
  app.settings.micGainPct = Number(e.target.value);
  applyMicAudioSettings();
});
$('micGainSlider').addEventListener('change', () => saveSettings(app.settings));
$('micLimiter').addEventListener('change', (e) => {
  app.settings.micLimiter = e.target.checked;
  saveSettings(app.settings);
  applyMicAudioSettings();
});
$('jitterSelect').addEventListener('change', async (e) => {
  app.settings.jitterMs = Number(e.target.value);
  saveSettings(app.settings);
  try {
    await cmd('audio.setJitterBuffer', { ms: app.settings.jitterMs });
  } catch (err) {
    toast(err.message);
  }
});

$('micSendBtn').addEventListener('click', () => {
  if (app.mic.sending) stopMicSend();
  else startMicSend();
});

// ---------- réglages ----------

function populateSettingsForm() {
  $('cfgHost').value = app.settings.host;
  $('cfgPort').value = app.settings.port;
  $('cfgToken').value = app.settings.token;
  $('cfgDeviceName').value = app.settings.deviceName;
  $('cfgNotifChat').checked = app.settings.notifChat;
  $('cfgNotifCooldown').value = app.settings.notifCooldownS;
  $('cfgNotifMentions').checked = app.settings.notifMentions;
  $('cfgMentionKeywords').value = app.settings.mentionKeywords;
  $('cfgNotifHealth').checked = app.settings.notifHealth;
  $('cfgHealthDropPct').value = app.settings.healthDropPct;
  $('cfgHealthCongestionPct').value = app.settings.healthCongestionPct;
  $('cfgNotifDisconnect').checked = app.settings.notifDisconnect;
  $('cfgIgnoredUsers').value = app.settings.ignoredUsers;
  $('micGainSlider').value = app.settings.micGainPct;
  $('micGainValue').textContent = app.settings.micGainPct;
  $('micLimiter').checked = app.settings.micLimiter;
  $('jitterSelect').value = String(app.settings.jitterMs);
}

function readSettingsForm() {
  app.settings.host = $('cfgHost').value.trim();
  app.settings.port = $('cfgPort').value.trim();
  app.settings.token = $('cfgToken').value.trim();
  app.settings.deviceName = $('cfgDeviceName').value.trim() || 'Mon téléphone';
  app.settings.notifChat = $('cfgNotifChat').checked;
  app.settings.notifCooldownS = Number($('cfgNotifCooldown').value) || 45;
  app.settings.notifMentions = $('cfgNotifMentions').checked;
  app.settings.mentionKeywords = $('cfgMentionKeywords').value;
  app.settings.notifHealth = $('cfgNotifHealth').checked;
  app.settings.healthDropPct = Number($('cfgHealthDropPct').value) || 2;
  app.settings.healthCongestionPct = Number($('cfgHealthCongestionPct').value) || 30;
  app.settings.notifDisconnect = $('cfgNotifDisconnect').checked;
  app.settings.ignoredUsers = $('cfgIgnoredUsers').value;
  saveSettings(app.settings);
}

// Persiste les réglages de notifications dès qu'ils changent, sans attendre
// le bouton "Enregistrer et connecter" (qui ne concerne que la connexion).
for (const id of ['cfgNotifChat', 'cfgNotifCooldown', 'cfgNotifMentions', 'cfgMentionKeywords',
  'cfgNotifHealth', 'cfgHealthDropPct', 'cfgHealthCongestionPct', 'cfgNotifDisconnect', 'cfgIgnoredUsers', 'cfgDeviceName']) {
  $(id).addEventListener('change', readSettingsForm);
}

// Remet tout sauf la connexion (hôte/port/token) : un reset ne doit jamais
// obliger à re-scanner le QR de pairing.
$('resetDefaultsBtn').addEventListener('click', () => {
  if (!confirm('Restaurer les valeurs par défaut (notifications et audio) ?')) return;
  const { host, port, token, pcId, pcName, deviceName } = app.settings;
  app.settings = { ...defaultSettings(), host, port, token, pcId, pcName, deviceName };
  saveSettings(app.settings);
  populateSettingsForm();
  applyMicAudioSettings();
  cmd('audio.setJitterBuffer', { ms: app.settings.jitterMs }).catch(() => {});
  toast('Valeurs par défaut restaurées');
});

$('saveConnBtn').addEventListener('click', () => {
  readSettingsForm();
  if (app.ws) { app.manualDisconnect = true; app.ws.close(); }
  connect();
});

// ---------- démarrage ----------

initServiceWorker();
ensureNotifChannel();
populateSettingsForm();
renderPcInfo();
loadAppVersion();
populateMicDevices();
startLivePreview(); // le tableau de bord est l'onglet actif par défaut
if (app.settings.host && app.settings.port && app.settings.token) {
  connect();
} else {
  log('[connexion] renseigne hôte/port/token dans Réglages pour te connecter');
  document.querySelector('.tab-btn[data-tab="settings"]').click();
}
