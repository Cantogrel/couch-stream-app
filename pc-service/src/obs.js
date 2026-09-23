import { EventEmitter } from 'node:events';
import OBSWebSocket from 'obs-websocket-js';

// Nom de la source ajoutée en Phase 0 (voir
// decision-vbcable-obs-source-via-websocket-api dans le vault) — la source
// micro téléphone que l'app doit pouvoir muter/démuter.
const MIC_INPUT_NAME = process.env.MIC_INPUT_NAME || 'Micro Téléphone (Couch Stream App)';

// obs-websocket-js ne rejette pas les requêtes en vol quand la connexion
// tombe (ex. OBS fermé) — sans ça, une requête lancée juste avant la
// coupure reste pendante indéfiniment. Comme wsServer.js sérialise les
// commandes par connexion, UNE requête bloquée gèle tout ce qui suit sur
// cette connexion (aperçu du live interrogé toutes les 3s = déclencheur le
// plus probable). Observé en conditions réelles le 2026-09-22 après un
// redémarrage d'OBS.
const CALL_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`OBS: ${label} sans réponse après ${ms}ms`)), ms)),
  ]);
}

export class ObsController extends EventEmitter {
  constructor({ url, password }) {
    super();
    this.url = url;
    this.password = password;
    this.obs = null;
    this.connected = false;
    this.lastError = null;
    this._reconnectTimer = null;
    // Dernier relevé d'octets sortants, pour calculer le débit par différence.
    this.lastBytes = null;
  }

  // Attache les listeners à une instance OBSWebSocket donnée — extrait pour
  // pouvoir en recréer une neuve à chaque tentative de connexion (voir
  // connect()).
  _bindClient(obs) {
    obs.on('ConnectionClosed', () => {
      this.connected = false;
      this.emit('status', { connected: false });
      this._scheduleReconnect();
    });
    obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
      this.emit('event', { name: 'obs.scene_changed', sceneName });
    });
    obs.on('StreamStateChanged', ({ outputActive }) => {
      this.emit('event', { name: 'obs.stream_state', active: outputActive });
    });
    obs.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
      if (inputName === MIC_INPUT_NAME) {
        this.emit('event', { name: 'obs.mic_mute_changed', muted: inputMuted });
      }
    });
    obs.on('InputVolumeChanged', ({ inputName, inputVolumeMul }) => {
      if (inputName === MIC_INPUT_NAME) {
        this.emit('event', { name: 'obs.mic_volume_changed', volume: inputVolumeMul });
      }
    });
  }

  async connect() {
    // Une instance OBSWebSocket fraîche à CHAQUE tentative plutôt que de
    // réutiliser toujours la même : si une tentative précédente a laissé
    // l'instance dans un état interne corrompu (ex. son socket bloqué en
    // CONNECTING, qui ne répond jamais à .close() — la lib n'a aucun
    // timeout sur connect() NI sur disconnect(), vérifié dans son code),
    // la réutiliser condamnerait TOUTES les reconnexions futures à échouer
    // de la même façon indéfiniment. Observé en conditions réelles le
    // 2026-09-22 : la 1re reconnexion après un redémarrage d'OBS marchait,
    // la 2e plus jamais — voir bug-20260922-service-freeze-obs-restart.
    // L'ancienne instance est juste abandonnée (pas de disconnect() dessus,
    // qui pourrait lui-même traîner) : on préfère un abandon propre à un
    // nouveau blocage.
    this.obs?.removeAllListeners();
    const obs = new OBSWebSocket();
    this._bindClient(obs);
    await withTimeout(obs.connect(this.url, this.password), CALL_TIMEOUT_MS, 'connexion à OBS');
    this.obs = obs;
    this.connected = true;
    this.lastError = null;
    this.emit('status', { connected: true });
  }

  _call(requestType, requestData) {
    return withTimeout(this.obs.call(requestType, requestData), CALL_TIMEOUT_MS, requestType);
  }

  // Démarre la connexion sans jamais bloquer ni faire échouer l'appelant :
  // OBS peut être lancé bien après le service (démarrage automatique avec
  // Windows) — on réessaie toutes les 5s jusqu'à ce qu'il réponde.
  startConnecting() {
    this._attempt();
  }

  _attempt() {
    this.connect().catch((err) => {
      this.lastError = err.message;
      console.error('[obs] connexion échouée, nouvelle tentative dans 5s:', err.message);
      this._scheduleReconnect();
    });
  }

  // Idempotent : ConnectionClosed et un échec de connect() peuvent tous deux
  // le demander pour la même tentative.
  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._attempt();
    }, 5000);
    this._reconnectTimer.unref();
  }

  async getState() {
    const [{ scenes, currentProgramSceneName }, streamStatus, { inputMuted }, { inputVolumeMul }] = await Promise.all([
      this._call('GetSceneList'),
      this._call('GetStreamStatus'),
      this._call('GetInputMute', { inputName: MIC_INPUT_NAME }).catch(() => ({ inputMuted: null })),
      this._call('GetInputVolume', { inputName: MIC_INPUT_NAME }).catch(() => ({ inputVolumeMul: null })),
    ]);
    return {
      scenes: scenes.map((s) => s.sceneName).reverse(),
      currentScene: currentProgramSceneName,
      streaming: streamStatus.outputActive,
      streamDurationMs: streamStatus.outputDuration,
      droppedFrames: streamStatus.outputSkippedFrames,
      totalFrames: streamStatus.outputTotalFrames,
      congestion: streamStatus.outputCongestion,
      micMuted: inputMuted,
      micVolume: inputVolumeMul,
    };
  }

  // Santé du stream (Phase 5) : débit calculé par différence d'octets entre
  // deux appels (obs-websocket n'expose pas de bitrate directement), plus
  // fps/CPU de GetStats. Le premier appel après un (re)démarrage n'a pas de
  // point de comparaison → bitrateKbps null.
  async getHealth() {
    const [status, stats] = await Promise.all([this._call('GetStreamStatus'), this._call('GetStats')]);
    const now = Date.now();
    let bitrateKbps = null;
    if (status.outputActive && this.lastBytes && status.outputBytes >= this.lastBytes.bytes) {
      const dtS = (now - this.lastBytes.at) / 1000;
      if (dtS > 0) bitrateKbps = Math.round(((status.outputBytes - this.lastBytes.bytes) * 8) / 1000 / dtS);
    }
    this.lastBytes = status.outputActive ? { bytes: status.outputBytes, at: now } : null;
    return {
      streaming: status.outputActive,
      bitrateKbps,
      fps: Math.round(stats.activeFps * 10) / 10,
      cpuPct: Math.round(stats.cpuUsage * 10) / 10,
      renderMs: Math.round(stats.averageFrameRenderTime * 10) / 10,
      skippedRender: stats.renderSkippedFrames,
      droppedFrames: status.outputSkippedFrames,
      totalFrames: status.outputTotalFrames,
      congestion: status.outputCongestion,
    };
  }

  async switchScene(sceneName) {
    await this._call('SetCurrentProgramScene', { sceneName });
  }

  async startStream() {
    await this._call('StartStream');
  }

  async stopStream() {
    await this._call('StopStream');
  }

  async setMicMuted(muted) {
    await this._call('SetInputMute', { inputName: MIC_INPUT_NAME, inputMuted: muted });
  }

  async toggleMic() {
    const { inputMuted } = await this._call('ToggleInputMute', { inputName: MIC_INPUT_NAME });
    return inputMuted;
  }

  async setMicVolume(volumeMul) {
    await this._call('SetInputVolume', { inputName: MIC_INPUT_NAME, inputVolumeMul: volumeMul });
  }

  // Capture la scène programme actuelle plutôt qu'une source fixe : c'est
  // ce qui part réellement à l'antenne (bascule automatiquement avec
  // obs.switchScene). Résolution/qualité volontairement basses — un aperçu
  // sur LAN Wi-Fi rafraîchi toutes les quelques secondes, pas un flux.
  async getScreenshot() {
    const { currentProgramSceneName } = await this._call('GetCurrentProgramScene');
    const { imageData } = await this._call('GetSourceScreenshot', {
      sourceName: currentProgramSceneName,
      imageFormat: 'jpeg',
      imageWidth: 480,
      imageCompressionQuality: 55,
    });
    return imageData;
  }
}
