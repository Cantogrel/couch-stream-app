# Installation en 5 minutes

Couch Stream App te laisse piloter ton stream (OBS + chat Twitch) depuis ton
téléphone, avec le micro du téléphone envoyé dans le stream. Il y a deux
morceaux : l'application **Windows** (sur le PC qui fait tourner OBS) et
l'application **Android**.

## Ce qu'il te faut

- Un PC **Windows 10 ou 11**.
- **OBS Studio 28 ou plus récent** ([obsproject.com](https://obsproject.com/fr/download)),
  déjà configuré avec ta scène de stream. Le serveur WebSocket dont on a besoin
  est intégré à OBS depuis la version 28.
- Un compte **Twitch** (celui de la chaîne que tu veux piloter).
- Un téléphone **Android**, sur le **même Wi-Fi** que le PC.

## Étape 1 — Installer l'application Windows

1. Lance `Couch Stream App_x.y.z_x64-setup.exe`. Aucun droit administrateur
   n'est demandé.
2. Windows SmartScreen peut afficher « Windows a protégé votre ordinateur »
   (l'installeur n'est pas encore signé par un éditeur reconnu) : clique sur
   **Informations complémentaires → Exécuter quand même**.
3. Une icône apparaît dans la zone de notification (près de l'horloge, parfois
   derrière la flèche `^`). Le service démarre tout seul, y compris à chaque
   démarrage de Windows.

## Étape 2 — L'assistant de configuration

Au premier lancement, une page « Bienvenue dans Couch Stream App » s'ouvre. Tu
peux la rouvrir à tout moment : clic droit sur l'icône → **Assistant de
configuration**. Chaque étape se vérifie toute seule.

1. **OBS Studio** — lance OBS. L'assistant retrouve tout seul le mot de passe
   du serveur WebSocket ; clique sur « Connecter avec les réglages détectés ».
   Si le serveur est désactivé : dans OBS, *Outils → Paramètres du serveur
   WebSocket → Activer*.
2. **Audio du téléphone (VB-Cable)** — un câble audio virtuel gratuit. Clique
   sur « Installer VB-Cable » : le pilote est téléchargé depuis le site officiel
   de VB-Audio, sa signature est vérifiée, puis Windows te demande **une seule
   autorisation administrateur**. VB-CABLE est un logiciel *donationware*
   ([vb-cable.com](https://vb-cable.com)) : une participation est la bienvenue
   si tu le trouves utile.
3. **Compte Twitch** — « Se connecter avec Twitch » : un code s'affiche et la
   page `twitch.tv/activate` s'ouvre. Connecte-toi avec le compte **de la
   chaîne**, entre le code, autorise. Aucun mot de passe n'est saisi dans
   l'application.
4. **Micro dans OBS** — « Créer la source micro » ajoute une source
   « Micro Téléphone » dans tes scènes, sans toucher à tes sources existantes.
5. **Ton téléphone** — deux QR codes : le premier télécharge l'application
   Android, le second la jumelle avec ce PC.

## Étape 3 — L'application Android

1. Scanne le premier QR avec l'appareil photo du téléphone : le fichier
   `CouchStream.apk` se télécharge.
2. Android demande d'autoriser l'installation depuis ton navigateur
   (« Installer des applis inconnues ») : c'est normal, l'application n'est pas
   sur le Play Store.
3. Ouvre l'application, va dans **Réglages → « Jumeler avec le PC »**, et scanne
   le second QR. Si la mise au point est capricieuse, touche l'image pour la
   refaire, ou utilise le curseur de zoom.
4. Autorise le micro et les notifications quand Android le demande.

C'est fini. Tu retrouves le tableau de bord, les scènes, le chat et le micro.

## Au quotidien

- L'icône de la zone de notification : clic gauche = **console PC** (aperçu du
  live, démarrer/arrêter, scènes, santé, chat). Clic droit = menu (jumelage,
  assistant, dossier de données, mise à jour, démarrage avec Windows, quitter).
- OBS n'a pas besoin d'être ouvert avant le service : il se reconnecte tout
  seul, et la console propose un bouton « Ouvrir OBS ».
- Si le PC change d'adresse sur ton réseau, l'application Android le retrouve
  toute seule.
- **Oublier un téléphone** : console → « Téléphone & infos » → « Oublier ».

## En cas de problème

Console → « Téléphone & infos » → **Copier le rapport de diagnostic**, puis
colle-le dans un message à la personne qui t'aide. Le rapport contient les
versions, l'état d'OBS/Twitch/VB-Cable et un extrait du journal ; **aucun mot de
passe ni jeton** n'y figure.

| Symptôme | Piste |
|---|---|
| « OBS n'est pas connecté » | OBS est fermé, ou son serveur WebSocket est désactivé (*Outils → Paramètres du serveur WebSocket*). |
| Pas de son du téléphone dans OBS | VB-Cable absent (étape 2) ou source micro non créée (étape 4). Si l'installation de VB-Cable vient d'être faite, redémarre le PC. |
| Le téléphone ne trouve pas le PC | Même Wi-Fi ? Le pare-feu Windows a-t-il autorisé « Couch Stream App » sur les réseaux privés ? Bouton « Chercher le PC sur le réseau » dans les Réglages de l'app. |
| « Jumelage refusé par le PC » | Le téléphone a été oublié côté PC : rejumelle-le par QR. |
| Le chat Twitch ne se connecte pas | Étape 3 de l'assistant à refaire (le jeton a peut-être expiré ou été révoqué). |

## Confidentialité

Aucune télémétrie. Tout reste sur ton réseau local : le téléphone parle
directement au PC. Les jetons Twitch sont chiffrés avec ton compte Windows. Les
seules connexions sortantes sont Twitch (chat/modération), le téléchargement de
VB-Cable et la vérification des mises à jour.
