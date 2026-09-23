import { Bonjour } from 'bonjour-service';

// Annonce ce PC sur le réseau local (mDNS/Bonjour, `_couchstream._tcp`) : le
// téléphone le retrouve sans connaître son IP, y compris après un changement
// d'adresse DHCP. Le TXT `id` permet de reconnaître SON PC parmi d'autres.
export function advertise({ identity, port }) {
  let bonjour = null;
  try {
    bonjour = new Bonjour();
    bonjour.publish({ name: `Couch Stream (${identity.name})`, type: 'couchstream', protocol: 'tcp', port, txt: { id: identity.id, name: identity.name } });
    console.log('[mdns] annonce _couchstream._tcp sur le réseau local');
  } catch (err) {
    // Non fatal : la redécouverte par balayage du sous-réseau reste possible.
    console.error('[mdns] annonce impossible:', err.message);
  }
  return () => {
    try {
      bonjour?.unpublishAll(() => bonjour.destroy());
    } catch {
      // arrêt du process : rien à faire de plus
    }
  };
}
