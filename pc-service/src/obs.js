import { EventEmitter } from 'node:events';
import OBSWebSocket from 'obs-websocket-js';

// Nom de la source ajoutée en Phase 0 (voir
// decision-vbcable-obs-source-via-websocket-api dans le vault) — la source
// micro téléphone que l'app doit pouvoir muter/démuter.
const MIC_INPUT_NAME = process.env.MIC_INPUT_NAME || 'Micro Téléphone (Couch Stream App)';

export class ObsController extends EventEmitter {
  constructor({ url, password }) {
    super();
    this.url = url;
    this.password = password;
    this.obs = new OBSWebSocket();
    this.connected = false;

    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
      this.emit('status', { connected: false });
      this._scheduleReconnect();
    });
    this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
      this.emit('event', { name: 'obs.scene_changed', sceneName });
    });
    this.obs.on('StreamStateChanged', ({ outputActive }) => {
      this.emit('event', { name: 'obs.stream_state', active: outputActive });
    });
    this.obs.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
      if (inputName === MIC_INPUT_NAME) {
        this.emit('event', { name: 'obs.mic_mute_changed', muted: inputMuted });
      }
    });
  }

  async connect() {
    await this.obs.connect(this.url, this.password);
    this.connected = true;
    this.emit('status', { connected: true });
  }

  _scheduleReconnect() {
    setTimeout(() => {
      this.connect().catch((err) => {
        console.error('[obs] reconnexion échouée, nouvelle tentative dans 5s:', err.message);
        this._scheduleReconnect();
      });
    }, 5000).unref();
  }

  async getState() {
    const [{ scenes, currentProgramSceneName }, streamStatus, { inputMuted }] = await Promise.all([
      this.obs.call('GetSceneList'),
      this.obs.call('GetStreamStatus'),
      this.obs.call('GetInputMute', { inputName: MIC_INPUT_NAME }).catch(() => ({ inputMuted: null })),
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
    };
  }

  async switchScene(sceneName) {
    await this.obs.call('SetCurrentProgramScene', { sceneName });
  }

  async startStream() {
    await this.obs.call('StartStream');
  }

  async stopStream() {
    await this.obs.call('StopStream');
  }

  async setMicMuted(muted) {
    await this.obs.call('SetInputMute', { inputName: MIC_INPUT_NAME, inputMuted: muted });
  }

  async toggleMic() {
    const { inputMuted } = await this.obs.call('ToggleInputMute', { inputName: MIC_INPUT_NAME });
    return inputMuted;
  }
}
