import { AudioContext, mediaDevices } from 'node-web-audio-api';

const SAMPLE_RATE = 48000;

// Joue un flux PCM mono 48kHz vers un périphérique de sortie Windows précis
// (VB-Cable "CABLE Input"), via node-web-audio-api : binaire NAPI
// précompilé (cpal), aucune compilation native requise à l'installation —
// contrairement à ffmpeg (aucun build portable n'expose de sortie
// dsound/wasapi) ou aux bindings PortAudio (nécessitent node-gyp + Visual
// Studio). Voir decision-audio-sortie-node-web-audio-api dans le vault.
export class PcmPlayer {
  constructor({ deviceLabelMatch, jitterBufferMs = 30 }) {
    this.deviceLabelMatch = deviceLabelMatch;
    // Délai avant la première lecture : absorbe la gigue réseau/décodage
    // sans décalage perceptible pour de la voix en LAN. Si le flux prend
    // du retard (sous-alimentation), on resynchronise sur ce même délai
    // plutôt que de jouer les paquets en rafale. 30ms est déjà généreux
    // pour du Wi-Fi LAN ; à remonter (config VBCABLE, voir .env.example)
    // seulement si des craquements apparaissent en pratique.
    this.jitterBufferMs = jitterBufferMs;
    this.ctx = null;
    this.nextTime = 0;
    this.device = null;
  }

  // Validation à froid (énumère les périphériques, n'ouvre aucun flux) —
  // appelée une fois au boot pour échouer vite si VB-Cable n'est pas
  // configuré, sans dépendre d'un premier envoi micro pour le découvrir.
  async resolveDevice() {
    const devices = await mediaDevices.enumerateDevices();
    const device = devices.find(
      (d) => d.kind === 'audiooutput' && d.label.includes(this.deviceLabelMatch),
    );
    if (!device) {
      const available = devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => d.label)
        .join(', ');
      throw new Error(
        `Périphérique de lecture introuvable (recherché: "${this.deviceLabelMatch}"). Disponibles: ${available}`,
      );
    }
    this.device = device;
    return device;
  }

  // Ouvre le flux audio natif — tenu ouvert seulement pendant un envoi micro
  // actif (voir wsServer.js, compteur de sessions), pas en continu depuis le
  // boot : un AudioContext cpal gardé ouvert 24/7 s'est révélé être le point
  // de gel le plus probable au redémarrage d'OBS (le seul composant natif
  // actif en permanence, indépendamment de toute activité micro réelle) —
  // voir bug-20260922-service-freeze-obs-restart dans le vault.
  async start() {
    if (this.ctx) return; // déjà démarré (ex. deux clients qui se relaient)
    const device = this.device || (await this.resolveDevice());

    // 'interactive' (déjà la valeur par défaut du spec) demande explicitement
    // au backend audio de minimiser la latence plutôt que d'optimiser pour
    // le CPU/la stabilité — le rendre explicite ici pour ne pas en dépendre
    // implicitement.
    this.ctx = new AudioContext({ sinkId: device.deviceId, sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    this.nextTime = this.ctx.currentTime + this.jitterBufferMs / 1000;
    const hwLatencyMs = Math.round(((this.ctx.outputLatency ?? this.ctx.baseLatency) || 0) * 1000);
    console.log(
      `[audio] sortie micro routée vers "${device.label}" ` +
        `(buffer de gigue: ${this.jitterBufferMs}ms, latence matérielle rapportée: ${hwLatencyMs}ms)`,
    );
  }

  // pcm: Buffer PCM mono 16-bit LE, à SAMPLE_RATE.
  push(pcm) {
    if (!this.ctx) return;

    const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    const frameCount = int16.length;
    const buffer = this.ctx.createBuffer(1, frameCount, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) channel[i] = int16[i] / 32768;

    const now = this.ctx.currentTime;
    if (this.nextTime < now) {
      // Retard accumulé (paquets perdus/en rafale) : on resynchronise au
      // lieu de tout jouer d'un coup.
      this.nextTime = now + this.jitterBufferMs / 1000;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    source.start(this.nextTime);
    this.nextTime += frameCount / SAMPLE_RATE;
  }

  async stop() {
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}
