import { RTCPeerConnection } from 'werift';
import { OpusDecoder } from './opusDecoder.js';

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
    this.pc.connectionStateChange.subscribe((state) => this.onStatus(state));

    this.pc.ontrack = ({ track }) => {
      if (track.kind !== 'audio') return;
      this.decoder = new OpusDecoder();
      track.onReceiveRtp.subscribe((rtp) => {
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
    this.decoder?.close();
    this.decoder = null;
    this.pc.close().catch(() => {});
  }
}
