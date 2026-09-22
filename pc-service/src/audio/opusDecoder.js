import OpusScript from 'opusscript';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;

// Décodeur WASM pur (opusscript) plutôt qu'un binding natif : aucune
// compilation requise à l'installation, portable sur toute plateforme
// supportée par Node.
export class OpusDecoder {
  constructor() {
    this.decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  }

  // Un paquet RTP Opus WebRTC correspond à une trame Opus complète : pas de
  // dépaquetage supplémentaire nécessaire avant decode().
  decode(opusPacket) {
    return this.decoder.decode(opusPacket);
  }

  close() {
    this.decoder.delete();
  }
}
