// Console PC : aperçu + commandes + santé + chat. Se connecte seule au service
// local (token servi à la boucle locale par /api/session).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const st = {
  ws: null, token: null, nextId: 1, pending: new Map(),
  status: null,            // dernier /api/status
  obs: { connected: false, streaming: false, scenes: [], currentScene: null, micMuted: null },
  clock: null,
  msgs: new Map(),
  previewOk: false, previewError: null,
};

function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ---------- service (HTTP) ----------

async function pollStatus() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    st.status = await r.json();
  } catch {
    st.status = null;
  }
  const s = st.status;
  const wasConnected = st.obs.connected;
  st.obs.connected = Boolean(s?.obs.connected);
  $('obsDot').className = 'dot ' + (s ? (s.obs.connected ? 'ok' : 'bad') : 'warn');
  $('twDot').className = 'dot ' + (s ? (s.twitch.connected ? 'ok' : 'warn') : 'warn');
  $('vbDot').className = 'dot ' + (s ? (s.vbcable.found ? 'ok' : 'bad') : 'warn');
  $('phDot').className = 'dot ' + (s && s.phones ? 'ok' : 'warn');
  $('phText').textContent = s?.phones ? `Téléphone ×${s.phones}` : 'Aucun téléphone';
  $('dlgPhones').textContent = s?.phones ?? '–';
  $('dlgVersion').textContent = s ? 'v' + s.version : '–';
  $('vbDot').parentElement.title = s?.vbcable.found ? s.vbcable.label : 'VB-Cable introuvable : le micro du téléphone ne peut pas être envoyé à OBS.';
  $('twDot').parentElement.title = s?.twitch.connected ? 'Chat Twitch connecté' : 'Chat Twitch en cours de connexion…';
  if (st.obs.connected && !wasConnected) refreshState();
  if (!st.obs.connected) { st.obs.streaming = false; st.clock = null; }
  render();
  if (!st.ws && s) connectWs();
}

// ---------- service (WebSocket) ----------

async function connectWs() {
  if (st.ws) return;
  try {
    if (!st.token) st.token = (await (await fetch('/api/session', { cache: 'no-store' })).json()).token;
  } catch { return; }
  const ws = new WebSocket(`ws://${location.host}`);
  st.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: st.token }));
  ws.onclose = () => { st.ws = null; st.token = null; st.pending.forEach((p) => p.reject(new Error('déconnecté'))); st.pending.clear(); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
}

function cmd(action, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return reject(new Error('service non connecté'));
    const id = st.nextId++;
    st.pending.set(id, { resolve, reject });
    st.ws.send(JSON.stringify({ type: 'command', id, action, payload }));
  });
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome': refreshState(); break;
    case 'state': applyState(msg); break;
    case 'chat-history': msg.messages.forEach(addMessage); break;
    case 'result': {
      const p = st.pending.get(msg.id); if (!p) break;
      st.pending.delete(msg.id);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
      break;
    }
    case 'error': toast(msg.error); break;
    case 'event': onEvent(msg); break;
  }
}

function onEvent(m) {
  switch (m.name) {
    case 'obs.scene_changed': st.obs.currentScene = m.sceneName; break;
    case 'obs.stream_state':
      st.obs.streaming = m.active;
      st.clock = m.active ? { base: 0, at: Date.now() } : null;
      break;
    case 'obs.mic_mute_changed': st.obs.micMuted = m.muted; break;
    case 'chat.message': addMessage(m); break;
    case 'chat.message_deleted': markDeleted(m.id, m); break;
    default: return;
  }
  render();
}

async function refreshState() {
  try { applyState(await cmd('state.get')); } catch { /* réessayé au prochain évènement */ }
}

function applyState(s) {
  Object.assign(st.obs, s);
  st.clock = s.streaming && s.streamDurationMs != null ? { base: s.streamDurationMs, at: Date.now() } : null;
  render();
}

// ---------- rendu ----------

const ICON_OBS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M3 3l18 18" /></svg>';

function renderPlaceholder() {
  const ph = $('placeholder'), img = $('preview');
  const showImg = st.obs.connected && st.previewOk;
  img.classList.toggle('hidden', !showImg);
  ph.classList.toggle('hidden', showImg);
  if (showImg) return;
  const s = st.status;
  let title, text, action = '';
  if (!s) {
    title = 'Le service ne répond pas';
    text = 'Il démarre ou redémarre. Cette page se remet à jour toute seule.';
  } else if (!s.obs.connected) {
    const err = s.obs.lastError || '';
    const refused = !err || /ECONNREFUSED|sans réponse|closed/i.test(err);
    title = "OBS n'est pas connecté";
    text = refused
      ? "OBS n'est pas lancé (ou son serveur WebSocket est désactivé). Le service s'y connectera tout seul dès qu'il sera ouvert."
      : `Connexion impossible : ${esc(err)}. Vérifie le mot de passe et le port d'obs-websocket.`;
    action = '<button class="btn primary" id="obsLaunch">Ouvrir OBS</button><div id="obsMsg" style="color:var(--bad);font-size:.8rem"></div>';
  } else {
    title = 'Aperçu en cours de chargement…';
    text = st.previewError || '';
  }
  const key = title + text + action;
  if (ph.dataset.key === key) return;
  ph.dataset.key = key;
  ph.innerHTML = `${ICON_OBS}<b>${title}</b><p>${text}</p>${action}`;
  $('obsLaunch')?.addEventListener('click', launchObs);
}

async function launchObs() {
  const b = $('obsLaunch'); b.disabled = true; b.textContent = 'OBS se lance…';
  try {
    const r = await (await fetch('/api/obs/launch', { method: 'POST' })).json();
    if (!r.ok) $('obsMsg').textContent = r.error;
  } catch { $('obsMsg').textContent = 'Le service ne répond pas.'; }
  setTimeout(() => { if ($('obsLaunch')) { b.disabled = false; b.textContent = 'Ouvrir OBS'; } }, 8000);
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

function render() {
  const o = st.obs, on = o.connected;
  $('liveBadge').classList.toggle('hidden', !o.streaming);
  const ss = $('streamState');
  ss.textContent = !on ? 'OBS non connecté' : o.streaming ? 'EN DIRECT' : 'Hors ligne';
  ss.classList.toggle('live', on && o.streaming);
  const sb = $('streamBtn');
  sb.disabled = !on;
  sb.textContent = o.streaming ? 'Arrêter le stream' : 'Démarrer le stream';
  sb.className = 'btn ' + (o.streaming ? 'danger' : 'primary');
  const mb = $('micBtn');
  mb.disabled = !on || o.micMuted == null;
  mb.textContent = 'Micro OBS : ' + (o.micMuted == null ? '–' : o.micMuted ? 'muet' : 'actif');
  tickClock();

  const sc = $('scenes');
  if (!on || !o.scenes?.length) sc.innerHTML = `<span class="empty">${on ? 'Aucune scène' : 'OBS non connecté'}</span>`;
  else {
    sc.innerHTML = '';
    for (const name of o.scenes) {
      const b = document.createElement('button');
      b.className = 'btn scene' + (name === o.currentScene ? ' current' : '');
      b.textContent = name;
      b.onclick = () => cmd('obs.switchScene', { sceneName: name }).catch((e) => toast(e.message));
      sc.appendChild(b);
    }
  }
  renderPlaceholder();
}

function tickClock() {
  $('duration').textContent = st.clock && st.obs.streaming ? fmt(st.clock.base + Date.now() - st.clock.at) : '';
}
setInterval(tickClock, 1000);

$('streamBtn').onclick = async () => {
  try {
    if (st.obs.streaming) {
      if (!confirm('Arrêter le stream en cours ?')) return;
      await cmd('obs.stopStream');
    } else await cmd('obs.startStream');
  } catch (e) { toast(e.message); }
};
$('micBtn').onclick = () => cmd('obs.toggleMic').catch((e) => toast(e.message));

// ---------- aperçu + santé ----------

async function previewTick() {
  if (document.hidden || !st.obs.connected) { st.previewOk = false; return; }
  try {
    const { dataUrl } = await cmd('obs.getScreenshot', { width: 960 });
    $('preview').src = dataUrl;
    st.previewOk = true; st.previewError = null;
  } catch (e) {
    st.previewOk = false; st.previewError = 'Aperçu indisponible (' + e.message + ')';
  }
  renderPlaceholder();
}
setInterval(previewTick, 2500);

async function healthTick() {
  if (document.hidden || !st.obs.connected) return;
  try {
    const h = await cmd('obs.getHealth');
    const live = h.streaming;
    $('hDropped').textContent = live ? h.droppedFrames ?? '–' : '–';
    $('hTotal').textContent = live ? h.totalFrames ?? '–' : '–';
    $('hCong').textContent = live && h.congestion != null ? Math.round(h.congestion * 100) + '%' : '–';
    $('hKbps').textContent = live ? h.bitrateKbps ?? '–' : '–';
    $('hFps').textContent = h.fps != null ? Math.round(h.fps) : '–';
    $('hCpu').textContent = h.cpuPct != null ? h.cpuPct + '%' : '–';
  } catch { /* transitoire */ }
}
setInterval(healthTick, 2000);

// ---------- chat ----------

function addMessage(m) {
  st.msgs.set(String(m.id), m);
  $('chatEmpty')?.remove();
  const log = $('chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const div = document.createElement('div');
  div.className = 'msg';
  div.dataset.id = m.id;
  fillMessage(div, m);
  log.appendChild(div);
  while (log.children.length > 300) { st.msgs.delete(log.firstChild.dataset.id); log.firstChild.remove(); }
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function fillMessage(div, m) {
  const cls = m.isBroadcaster ? 'broadcaster' : m.isMod ? 'mod' : '';
  const author = `<span class="author ${cls}">${esc(m.displayName)}${m.self ? ' (toi)' : ''}</span>`;
  if (m.deleted) {
    div.classList.add('deleted');
    const label = m.reason === 'ban' ? '[banni]' : m.reason === 'timeout' ? `[timeout${m.duration ? ' ' + Math.round(m.duration) + 's' : ''}]` : '[message supprimé]';
    div.innerHTML = `${author}<span class="text">${label}</span>`;
    return;
  }
  // Twitch refuse la suppression/modération de ses propres messages.
  const tools = m.self ? '' : '<div class="tools"><button data-a="del">Supprimer</button><button data-a="to">Timeout 10 min</button><button class="danger" data-a="ban">Bannir</button></div>';
  div.innerHTML = `${author}<span class="text">${esc(m.text)}</span>${tools}`;
  div.querySelector('[data-a=del]')?.addEventListener('click', () =>
    cmd('chat.delete', { messageId: m.id }).then(() => markDeleted(m.id, { reason: 'delete' })).catch((e) => toast(e.message)));
  div.querySelector('[data-a=to]')?.addEventListener('click', () =>
    cmd('chat.timeout', { username: m.username, duration: 600 }).catch((e) => toast(e.message)));
  div.querySelector('[data-a=ban]')?.addEventListener('click', () => {
    if (confirm(`Bannir ${m.displayName} ?`)) cmd('chat.ban', { username: m.username }).catch((e) => toast(e.message));
  });
}

function markDeleted(id, extra) {
  const m = st.msgs.get(String(id));
  if (!m || m.deleted) return;
  Object.assign(m, { deleted: true, reason: extra.reason, duration: extra.duration });
  const div = $('chatLog').querySelector(`[data-id="${CSS.escape(String(id))}"]`);
  if (div) fillMessage(div, m);
}

$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  $('chatInput').value = '';
  cmd('chat.send', { message: text }).catch((err) => toast(err.message));
};

// ---------- téléphone & infos ----------

function pane(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  $('pairBox').classList.toggle('hidden', name !== 'pair');
  $('apkBox').classList.toggle('hidden', name !== 'apk');
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => pane(b.dataset.pane)));

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`;
};

async function loadDevices() {
  try {
    const list = await (await fetch('/api/devices', { cache: 'no-store' })).json();
    $('devBox').innerHTML = list.length
      ? '<div class="card-title" style="margin-top:.8rem">Téléphones jumelés</div>' + list.map((d) =>
        `<div class="dev"><div class="info"><b>${esc(d.name)}</b><small>${d.online ? '● connecté' : 'vu ' + ago(d.lastSeenAt)}${d.appVersion ? ' · app v' + esc(d.appVersion) : ''}</small></div><button data-id="${esc(d.id)}">Oublier</button></div>`).join('')
      : '';
    $('devBox').querySelectorAll('button').forEach((b) => (b.onclick = async () => {
      if (!confirm(b.dataset.id === 'legacy' ? 'Oublier les téléphones jumelés avec l’ancien token partagé ? Ils devront être jumelés à nouveau par QR.' : 'Oublier ce téléphone ? Il devra être jumelé à nouveau.')) return;
      await fetch('/api/devices/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' });
      loadDevices();
    }));
  } catch { /* liste indisponible */ }
}

async function loadPairing() {
  try {
    const p = await (await fetch('/api/pairing', { cache: 'no-store' })).json();
    $('pairBox').innerHTML = p.qrDataUrl
      ? `<p>Scanne ce code depuis l'app, dans <b>Réglages → Scanner le QR de pairing</b>. Il est à usage unique et se renouvelle tout seul.</p><img src="${p.qrDataUrl}" alt="QR de pairing">`
      : "<p>Impossible de détecter l'IP de ce PC sur le réseau — vérifie la connexion.</p>";
    $('apkBox').innerHTML = !p.apk
      ? "<p>Le fichier de l'app n'est pas inclus dans cette installation.</p>"
      : `<p>Sur le téléphone (même Wi-Fi), scanne ce code avec l'appareil photo pour télécharger l'app (${p.apk.sizeMb} Mo).</p><img src="${p.apk.qrDataUrl}" alt="QR de téléchargement"><p>Ou ouvre <code>${esc(p.apk.url)}</code>. Android demandera d'autoriser l'installation depuis ce navigateur.</p>`;
  } catch { $('pairBox').innerHTML = '<p>Le service ne répond pas.</p>'; }
}

let dlgTimer = null;
async function openDialog() {
  pane('pair');
  $('dlg').showModal();
  loadPairing();
  loadDevices();
  // Code valable 10 min : on le renouvelle avant l'expiration, et on rafraîchit
  // la liste (un jumelage réussi doit apparaître sans rouvrir la fenêtre).
  clearInterval(dlgTimer);
  let n = 0;
  dlgTimer = setInterval(() => { loadDevices(); if (++n % 40 === 0) loadPairing(); }, 15000 / 5);
}
$('copyReport').onclick = async () => {
  try {
    const { text } = await (await fetch('/api/diagnostics', { cache: 'no-store' })).json();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Presse-papiers refusé : repli par sélection d'un champ temporaire.
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    $('reportMsg').textContent = 'Rapport copié : colle-le dans un message (aucun mot de passe ni jeton n\'y figure).';
  } catch { $('reportMsg').textContent = 'Le service ne répond pas.'; }
};
$('settingsBtn').onclick = openDialog;
$('dlgClose').onclick = () => $('dlg').close();
$('dlg').addEventListener('close', () => clearInterval(dlgTimer));
if (location.hash === '#pair') openDialog();

pollStatus();
setInterval(pollStatus, 2000);
