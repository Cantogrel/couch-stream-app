// Assistant de premier lancement. L'état vient entièrement du service
// (/api/setup/state, interrogé toutes les 2 s) : la page ne mémorise rien.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const post = (path, body = {}) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).then((r) => r.json());

let S = null;            // dernier état
const local = { obsMsg: null, obsBusy: false, micMsg: null, micBusy: false, twMsg: null, openedFor: null, pair: null, qrAt: 0, pairSkipped: false };

const STEPS = [
  { key: 'obs', title: 'OBS Studio', done: (s) => s.obs.connected, badge: (s) => (s.obs.connected ? 'connecté' : 'à connecter'), render: renderObs },
  { key: 'audio', title: 'Audio du téléphone (VB-Cable)', done: (s) => s.audio.installed, badge: (s) => (s.audio.installed ? 'installé' : 'à installer'), render: renderAudio },
  { key: 'twitch', title: 'Compte Twitch', done: (s) => s.twitch.state === 'connected', badge: (s) => (s.twitch.state === 'connected' ? `connecté (${s.twitch.login})` : s.twitch.state === 'connecting' ? 'connexion…' : 'à connecter'), render: renderTwitch },
  { key: 'mic', title: 'Micro dans OBS', done: (s) => s.audio.micSource === true, badge: (s) => (s.audio.micSource ? 'prêt' : 'à créer'), render: renderMic },
  { key: 'phone', title: 'Ton téléphone', done: (s) => s.phones > 0 || local.pairSkipped, badge: (s) => (s.phones > 0 ? 'jumelé' : local.pairSkipped ? 'ignoré' : 'à jumeler'), render: renderPhone },
];

// ---------- OBS ----------
function renderObs(s) {
  const o = s.obs;
  if (o.connected) {
    return `<p class="msg ok">OBS ${esc(o.version || '')} répond.</p>` +
      (o.versionOk === false ? `<p class="msg err">Cette version d'OBS est trop ancienne : Couch Stream App demande OBS 28 ou plus récent (le serveur WebSocket n'y est pas intégré avant).</p>` : '');
  }
  let h = '';
  if (!o.installed) {
    h += `<p><b>OBS Studio n'est pas installé</b> (ou introuvable). Installe-le depuis <a href="https://obsproject.com/fr/download" target="_blank" rel="noopener">obsproject.com</a> (version 28 ou plus récente, qui inclut le serveur WebSocket), lance-le une fois, puis reviens ici.</p>`;
  } else {
    h += `<p>Le service doit pouvoir parler à OBS. Lance OBS, puis vérifie que son serveur WebSocket est activé.</p><button id="obsLaunch" class="secondary">Ouvrir OBS</button>`;
  }
  if (o.detected && !o.detected.enabled) {
    h += `<p><b>Le serveur WebSocket d'OBS est désactivé.</b> Dans OBS : menu <b>Outils → Paramètres du serveur WebSocket</b>, coche <b>Activer le serveur WebSocket</b>, garde l'authentification activée, puis clique OK.</p>`;
  }
  if (o.detected?.hasPassword) {
    h += `<p>Le mot de passe d'OBS a été retrouvé automatiquement.</p><button id="obsApply">Connecter avec les réglages détectés</button>`;
  } else {
    h += `<p><input id="obsPwd" type="password" placeholder="Mot de passe du serveur WebSocket" autocomplete="off"> <button id="obsApply">Tester la connexion</button></p>
      <p class="note">Le mot de passe est dans OBS : Outils → Paramètres du serveur WebSocket → Afficher les informations de connexion.</p>`;
  }
  if (local.obsMsg) h += `<div class="msg ${local.obsMsg.ok ? 'ok' : 'err'}">${esc(local.obsMsg.text)}</div>`;
  return h;
}

// ---------- Audio ----------
function renderAudio(s) {
  const a = s.audio;
  if (a.installed) return `<p class="msg ok">VB-Cable est présent. Le micro de ton téléphone pourra être envoyé à OBS.</p>`;
  const st = a.install;
  const running = ['downloading', 'verifying', 'installing', 'waiting'].includes(st.step);
  let h = `<p>Pour envoyer le micro du téléphone à OBS, on utilise <b>VB-Cable</b>, un câble audio virtuel gratuit. Le pilote est téléchargé depuis le site officiel de VB-Audio, sa signature est vérifiée, puis installé — Windows te demandera une seule autorisation administrateur.</p>
    <button id="vbInstall" ${running ? 'disabled' : ''}>${running ? 'Installation en cours…' : 'Installer VB-Cable'}</button>`;
  if (st.message) h += `<div class="msg ${st.step === 'error' ? 'err' : ''}">${esc(st.message)}</div>`;
  h += `<p class="note">VB-CABLE est un logiciel « donationware » de VB-Audio Software (<a href="https://vb-cable.com" target="_blank" rel="noopener">www.vb-cable.com</a>) : toute participation est la bienvenue, si tu le trouves utile.</p>`;
  return h;
}

// ---------- Twitch ----------
function renderTwitch(s) {
  const t = s.twitch, a = t.auth;
  if (t.state === 'connected' && a.status !== 'pending') {
    return `<p class="msg ok">Connecté en tant que <b>${esc(t.login)}</b>. Le chat et la modération sont prêts.</p>
      <p class="note">Ce n'est pas la bonne chaîne ? Sur la page Twitch, clique « Ce n'est pas vous ? Déconnectez-vous » pour choisir le compte de ta chaîne.</p>
      <button class="secondary" id="twStart">Changer de compte Twitch</button>`;
  }
  if (t.state === 'connecting') return `<p>Connexion au chat de <b>${esc(t.login)}</b>…</p>`;
  let h = '';
  if (a.status === 'pending') {
    h += `<p>Sur la page Twitch qui vient de s'ouvrir, entre ce code puis autorise l'application. Connecte-toi avec le compte <b>de la chaîne</b> que tu veux piloter.</p>
      <div class="code">${esc(a.userCode)}</div><br>
      <a class="btn secondary" href="${esc(a.verificationUri)}" target="_blank" rel="noopener">Rouvrir la page Twitch</a>
      <button class="secondary" id="twCancel">Annuler</button>
      <p class="note">En attente de ton autorisation…</p>`;
  } else {
    h += `<p>Autorise Couch Stream App à lire le chat, écrire et modérer sur ta chaîne. Aucun mot de passe n'est demandé ici : tout se passe sur twitch.tv.</p><button id="twStart">Se connecter avec Twitch</button>`;
    if (['expired', 'denied', 'error', 'cancelled'].includes(a.status)) {
      const why = { expired: 'Le code a expiré.', denied: "L'autorisation a été refusée.", cancelled: 'Connexion annulée.' }[a.status] || `Erreur : ${a.error}`;
      h += `<div class="msg err">${esc(why)}</div>`;
    }
  }
  if (local.twMsg) h += `<div class="msg err">${esc(local.twMsg)}</div>`;
  return h;
}

// ---------- Micro OBS ----------
function renderMic(s) {
  if (s.audio.micSource) return `<p class="msg ok">La source « Micro Téléphone » existe dans OBS.</p>`;
  if (!s.obs.connected || !s.audio.installed) return `<p>Disponible dès que OBS est connecté et VB-Cable installé.</p>`;
  let h = `<p>On ajoute dans OBS une source audio « Micro Téléphone », branchée sur VB-Cable, dans toutes tes scènes. Tes sources existantes ne sont pas modifiées.</p><button id="micCreate" ${local.micBusy ? 'disabled' : ''}>Créer la source micro</button>`;
  if (local.micMsg) h += `<div class="msg ${local.micMsg.ok ? 'ok' : 'err'}">${esc(local.micMsg.text)}</div>`;
  return h;
}

// ---------- Téléphone ----------
function renderPhone(s) {
  if (s.phones > 0) return `<p class="msg ok">Un téléphone est connecté.</p>`;
  const p = local.pair;
  if (!p) return '<p>Chargement…</p>';
  if (!p.qrDataUrl) return `<p class="msg err">Impossible de détecter l'adresse de ce PC sur le réseau : vérifie qu'il est connecté au Wi-Fi ou au câble réseau.</p>`;
  // Deux temps : d'abord installer l'app (le téléphone est sur le même réseau
  // que ce PC), ensuite la jumeler.
  const install = p.apk
    ? `<div class="sub-step"><h3>A. Installe l'application (Android)</h3>
        <p>Avec l'appareil photo du téléphone (même Wi-Fi que ce PC), scanne ce code : l'app (${esc(p.apk.sizeMb)} Mo) se télécharge.</p>
        <img class="qr" src="${p.apk.qrDataUrl}" alt="QR de téléchargement">
        <p class="note">Ou ouvre ce lien dans le navigateur du téléphone : <b>${esc(p.apk.url)}</b><br>
        Android demandera d'autoriser l'installation depuis ce navigateur (« Installer des applis inconnues ») : c'est normal, l'app n'est pas sur le Play Store.</p></div>`
    : `<div class="sub-step"><h3>A. Installe l'application</h3><p>Le fichier de l'app n'est pas inclus dans cette installation : récupère l'APK auprès de la personne qui t'a donné Couch Stream App.</p></div>`;
  const pair = `<div class="sub-step"><h3>B. Jumelle-la avec ce PC</h3>
      <p>Ouvre l'app, va dans <b>Réglages → « Jumeler avec le PC »</b> et scanne ce code (valable 10 minutes, il se renouvelle tout seul).</p>
      <img class="qr" src="${p.qrDataUrl}" alt="QR de jumelage"></div>`;
  return `${install}${pair}<button class="secondary" id="phSkip">Le faire plus tard</button>`;
}

// ---------- rendu ----------
let lastKey = '';
function render() {
  if (!S) return;
  const firstTodo = STEPS.findIndex((st) => !st.done(S));
  const sysWarn = S.system && !S.system.ok ? `<div class="step"><p class="msg err">Windows ${esc(S.system.windows)} détecté : Couch Stream App demande Windows 10 ou 11.</p></div>` : '';
  const html = sysWarn + STEPS.map((st, i) => {
    const done = st.done(S);
    return `<div class="step ${done ? 'done' : ''} ${i === firstTodo ? 'current' : ''}" data-key="${st.key}">
      <div class="head"><span class="num">${done ? '✓' : i + 1}</span><h2>${st.title}</h2><span class="badge">${esc(st.badge(S))}</span></div>
      <div class="body ${done && st.key !== 'twitch' ? 'collapsible' : ''}">${st.render(S)}</div></div>`;
  }).join('');
  // Ne réécrit le DOM que si le contenu change : préserve la saisie en cours.
  const key = html + JSON.stringify(local.obsMsg) + local.micBusy;
  if (key !== lastKey) {
    const pwd = $('obsPwd')?.value;
    $('steps').innerHTML = html;
    if (pwd) $('obsPwd').value = pwd;
    lastKey = key;
    bind();
  }
  const required = STEPS.slice(0, 3).every((st) => st.done(S));
  $('finishBtn').disabled = !required;
  $('finishMsg').textContent = required ? '' : 'Termine les étapes 1 à 3 pour continuer (le micro et le téléphone peuvent attendre).';
}

function bind() {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('obsLaunch', async () => { local.obsMsg = { ok: true, text: 'OBS se lance… (le service s’y connecte tout seul)' }; render(); await post('/api/setup/obs/launch'); });
  on('obsApply', async () => {
    local.obsMsg = { ok: true, text: 'Test de la connexion…' }; render();
    const r = await post('/api/setup/obs/apply', $('obsPwd') ? { password: $('obsPwd').value } : {});
    local.obsMsg = r.ok ? { ok: true, text: `Connecté à OBS ${r.obsVersion || ''}.` } : { ok: false, text: r.message || r.error };
    refresh();
  });
  on('vbInstall', async () => { await post('/api/setup/vbcable/install'); refresh(); });
  on('twStart', async () => {
    local.twMsg = null;
    const r = await post('/api/setup/twitch/start');
    if (!r.ok) local.twMsg = r.error;
    else window.open(r.verificationUri, '_blank', 'noopener');
    refresh();
  });
  on('twCancel', async () => { await post('/api/setup/twitch/cancel'); refresh(); });
  on('micCreate', async () => {
    local.micBusy = true; render();
    const r = await post('/api/setup/mic');
    local.micBusy = false;
    local.micMsg = r.ok ? { ok: true, text: r.created ? `Source créée dans ${r.scenes} scène(s).` : 'Source déjà présente, périphérique resynchronisé.' } : { ok: false, text: r.error };
    refresh();
  });
  on('phSkip', () => { local.pairSkipped = true; lastKey = ''; render(); });
}

$('finishBtn').onclick = async () => { await post('/api/setup/complete'); location.href = '/desktop'; };

async function loadQr() {
  if (Date.now() - local.qrAt < 120000 && local.pair) return;
  local.qrAt = Date.now();
  try { local.pair = await (await fetch('/api/pairing', { cache: 'no-store' })).json(); lastKey = ''; } catch { /* réessayé */ }
}

async function refresh() {
  try {
    S = await (await fetch('/api/setup/state', { cache: 'no-store' })).json();
    if (!STEPS[4].done(S)) loadQr();
    render();
  } catch {
    $('finishMsg').textContent = 'Le service ne répond pas — il démarre peut-être encore.';
  }
}
refresh();
setInterval(refresh, 2000);
