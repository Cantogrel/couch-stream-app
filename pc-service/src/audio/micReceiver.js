import { RTCPeerConnection } from 'werift';
import { OpusDecoder } from './opusDecoder.js';

const STALL_MS = 5000;

// Une connexion WebRTC (une offre/réponse) par client audio. Pas de serveur
// STUN/TURN : usage LAN uniquement, les candidats host suffisent (voir
// contrainte projet "pas d'accès distant hors domicile").
export class MicReceiver {
  constructor({ pcmPlayer, onIceCandidate, onStatus }) {
    this.pcmPlayer = pcmPlayer;
    this.onIceCandidate = onIceCandidate;
    this.onStatus = onStatus || (() => {});
    this.decoder = null;

    this.pc = new RTCPeerConnection({ iceServers: [] });

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.onIceCandidate(candidate);
    };
    // Flux « connecté » mais plus aucun paquet audio (téléphone en veille, Wi-Fi
    // coupé sans que WebRTC s'en aperçoive) : on le signale au téléphone, qui
    // relance alors l'envoi tout seul au lieu de laisser un micro muet.
    this.lastRtpAt = Date.now();
    this.stalled = false;
    this.pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') this.lastRtpAt = Date.now();
      this.onStatus(state);
    });
    this._watch = setInterval(() => {
      if (this.pc.connectionState !== 'connected' || this.stalled) return;
      if (Date.now() - this.lastRtpAt > STALL_MS) {
        this.stalled = true;
        this.onStatus('stalled');
      }
    }, 2000);
    this._watch.unref?.();

    this.pc.ontrack = ({ track }) => {
      if (track.kind !== 'audio') return;
      this.decoder = new OpusDecoder();
      track.onReceiveRtp.subscribe((rtp) => {
        this.lastRtpAt = Date.now();
        if (this.stalled) {
          this.stalled = false;
          this.onStatus('connected');
        }
        try {
          const pcm = this.decoder.decode(rtp.payload);
          this.pcmPlayer.push(pcm);
        } catch (err) {
          console.error('[audio] décodage opus échoué:', err.message);
        }
      });
    };
  }

  async handleOffer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this.pc.localDescription.sdp;
  }

  async addIceCandidate(candidate) {
    if (!candidate) return;
    await this.pc.addIceCandidate(candidate);
  }

  close() {
    clearInterval(this._watch);
    this.decoder?.close();
    this.decoder = null;
    this.pc.close().catch(() => {});
  }
}
