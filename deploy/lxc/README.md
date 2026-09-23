# Déploiement LXC Proxmox

Kit de déploiement natif d'OsteoSoft dans un conteneur LXC Proxmox VE
(Debian 13 par défaut, Debian 12 possible), sans Docker. Déploiement
**mono-service** : l'API Node.js sert à la
fois `/api` **et** le frontend Angular compilé, via un unique service **systemd**.
Aucun nginx requis (identique au modèle de déploiement de Foyer-App).

```
deploy/lxc/
├── proxmox-create-lxc.sh   # exécuté sur l'HÔTE Proxmox : crée le conteneur puis installe
├── install.sh              # exécuté DANS le conteneur : build + service systemd
├── osteosoft-api.service   # gabarit d'unité systemd (API + frontend)
└── nginx.conf              # OPTIONNEL — reverse proxy pour terminer TLS uniquement
```

## Architecture

```
              :4199 (Node — sert le SPA + l'API)
Navigateur ─────────────► osteosoft-api (systemd) ──┬─► /            → dist/OsteoSoft/browser (SPA)
                                                     ├─► /api/        → API Express
                                                     └─► SQLite       /opt/osteosoft/server/data
```

Pour TLS hors LAN, on place un reverse proxy (nginx/Traefik/Caddy) devant le
port `4199` — voir `nginx.conf` (optionnel).

## Option A — tout depuis l'hôte Proxmox (recommandé)

Sur l'hôte Proxmox VE, en root :

```bash
git clone https://github.com/PrudhommeWTF/OsteoSoft.git
cd OsteoSoft/deploy/lxc
./proxmox-create-lxc.sh                 # ou: DOMAIN=osteosoft.example.com ./proxmox-create-lxc.sh
```

Le script crée un conteneur non privilégié, y pousse le code (le checkout
local, donc **fonctionne aussi pour un dépôt privé**), puis lance `install.sh`.

Personnalisation via variables d'environnement :

```bash
CTID=910 CT_HOSTNAME=osteosoft \
STORAGE=local-lvm DISK_GB=8 CORES=2 RAM_MB=2048 \
BRIDGE=vmbr0 IP=192.168.1.50/24 GATEWAY=192.168.1.1 DNS=192.168.1.1 \
API_PORT=4199 DOMAIN=osteosoft.example.com \
./proxmox-create-lxc.sh
```

Défauts : `CT_HOSTNAME=osteosoft`, `STORAGE=local-lvm`, `DISK_GB=8`, `CORES=2`,
`RAM_MB=2048`, `BRIDGE=vmbr0`, `IP=dhcp`, `API_PORT=4199`. Le `CTID` est
auto-attribué si absent.

### Template Debian

Le script ne fige pas de révision de correctif. Il résout automatiquement le
dernier template `debian-<release>-standard` disponible (par défaut
`DEBIAN_RELEASE=13`, Debian 13 « trixie »), d'abord parmi ceux déjà téléchargés,
sinon dans le catalogue `pveam`. On évite ainsi l'échec quand une révision figée
(ex. `12.7-1`) disparaît du catalogue au profit de la suivante.

- `DEBIAN_RELEASE=12` : rester sur Debian 12 « bookworm » (oldstable). Node est
  installé via NodeSource, qui gère le nom de code Debian dans les deux cas.
- `TEMPLATE_NAME=debian-13-standard_13.1-1_amd64.tar.zst` : forcer un template
  précis (contourne la résolution automatique ; adaptez le nom à la révision
  réellement disponible via `pveam available --section system | grep debian`).

## Option B — dans un conteneur LXC déjà existant

Depuis un LXC Debian 13 (ou 12), en root :

```bash
DOMAIN=osteosoft.example.com \
REPO_URL=https://github.com/PrudhommeWTF/OsteoSoft.git BRANCH=main \
bash install.sh
```

Pour un **dépôt privé**, passez un `REPO_URL` authentifié
(`https://<token>@github.com/...`) ou copiez le code dans `/opt/osteosoft`
avant de lancer `install.sh` (le clone est alors ignoré).

`install.sh` refuse de s'exécuter sur l'hôte Proxmox (détection `pct`/`/etc/pve`) ;
forcez avec `ALLOW_HOST=1` si vous êtes sûr d'être dans un conteneur.

## Après l'installation

1. **Premier démarrage** : ouvrir `http://<ip-du-lxc>:4199/` et suivre
   l'assistant. Si l'accès n'est pas local, mettre temporairement
   `ALLOW_REMOTE_SETUP=true` dans `.env` (puis le repasser à `false`).
2. **TLS (obligatoire hors LAN de confiance)** — placer un reverse proxy devant
   le port `4199`. Exemple nginx fourni dans `nginx.conf` :
   ```bash
   apt-get install -y nginx certbot python3-certbot-nginx
   cp deploy/lxc/nginx.conf /etc/nginx/sites-available/osteosoft
   sed -i "s/__DOMAIN__/osteosoft.example.com/; s/__API_PORT__/4199/" /etc/nginx/sites-available/osteosoft
   ln -sf /etc/nginx/sites-available/osteosoft /etc/nginx/sites-enabled/osteosoft
   rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx
   certbot --nginx -d osteosoft.example.com
   ```
   Puis dans `/opt/osteosoft/.env` : `TRUST_PROXY=true` et
   `CLIENT_ORIGIN=https://osteosoft.example.com`, puis
   `systemctl restart osteosoft-api`.
3. **Pare-feu** : n'exposer que le port utile (`4199` en direct, ou `443` si
   reverse proxy).

## Exploitation

| Action | Commande (dans le conteneur) |
|---|---|
| État du service | `systemctl status osteosoft-api` |
| Logs | `journalctl -u osteosoft-api -f` |
| Redémarrer | `systemctl restart osteosoft-api` |
| Données SQLite | `/opt/osteosoft/server/data/` |
| Secrets | `/opt/osteosoft/.env` |

## Mise à jour

Relancer `install.sh` récupère la dernière version du code, recompile le
frontend, élague les dépendances et redémarre le service. Le `.env` (secrets) et
`server/data` (base SQLite) sont **toujours préservés**.

Selon le mode d'installation, `install.sh` récupère le code ainsi :

- installation via `git clone` (le dossier a un `.git`) : `git pull` ;
- exécution depuis un checkout local distinct (ex. sur l'hôte Proxmox) : copie
  de ce checkout ;
- conteneur sans `.git` (cas Option A) : récupération depuis `REPO_URL` (par
  défaut le dépôt public GitHub) et superposition.

Depuis le conteneur, en root :

```bash
cd /opt/osteosoft
bash deploy/lxc/install.sh
```

Pour un **dépôt privé**, fournir un `REPO_URL` authentifié :

```bash
REPO_URL=https://<token>@github.com/PrudhommeWTF/OsteoSoft.git bash deploy/lxc/install.sh
```

> Note : la superposition met à jour et ajoute les fichiers mais ne supprime pas
> ceux retirés en amont. Pour repartir d'une base propre, recréez un conteneur
> (les données sont dans `server/data`, à sauvegarder au préalable).

## Sauvegarde / restauration

- **À sauvegarder** : `/opt/osteosoft/server/data/` (base SQLite) **et**
  la clé `OSTEOSOFT_DATA_KEY` de `.env`, conservée **séparément** — sans elle,
  les données chiffrées sont irrécupérables.
- Les snapshots/backups Proxmox du conteneur contiennent la clé à côté des
  données ; pour respecter la séparation exigée par le guide RGPD, préférez une
  sauvegarde applicative de `server/data` et un stockage distinct de la clé.

## Prérequis dans le conteneur (installés automatiquement)

Node.js 22 (NodeSource), `build-essential` + `python3` (compilation du module
natif `better-sqlite3`), git.

## Configuration initiale à distance

L'assistant d'installation (création du premier cabinet, instance de démo) est
ouvert depuis un navigateur sur le LAN, donc « à distance » du conteneur. Par
sécurité, l'application refuse par défaut la configuration initiale hors
loopback ; le kit active donc `ALLOW_REMOTE_SETUP=true` dans le `.env`. La
fenêtre d'exposition se limite au tout premier démarrage : dès que le premier
cabinet est créé, la configuration initiale est close quoi qu'il arrive. Faites
donc la configuration initiale **sans tarder, sur un réseau de confiance**. Pour
durcir davantage, mettez `ALLOW_REMOTE_SETUP=false` et faites la configuration
via un tunnel SSH (`ssh -L 4199:localhost:4199 …`) puis remettez la valeur.

## Dépannage

**Page blanche à l'ouverture**

L'API et le frontend étant servis sur la même origine avec une CSP stricte
(`script-src 'self'`), toute ressource inline ou tierce est bloquée. Deux causes
historiques, désormais corrigées et couvertes par un test end-to-end
(`e2e/05-csp-integrity.spec.ts`) :

- l'inlining de CSS critique injectait un `onload` inline sur la feuille de
  style (bloqué par la CSP → application non stylée) : désactivé côté build ;
- des polices Google étaient chargées (bloquées par la CSP, contraires à la
  règle « aucun appel tiers ») : supprimées, la typographie retombe sur les
  polices système.

**Page blanche en accès HTTP direct (LAN), console montrant des ressources
demandées en HTTPS**

En HTTP direct sans TLS, la directive CSP `upgrade-insecure-requests` (ajoutée
par défaut par helmet) fait charger le JS/CSS en `https://<ip>:<port>` — qui
n'existe pas → page blanche. Elle est désormais **désactivée par défaut** ;
`FORCE_HTTPS=true` (dans `.env`) ne doit être mis **que derrière un reverse
proxy TLS**. Ce cas échappe aux tests navigateur (les navigateurs exemptent
`localhost` de cet upgrade), il est donc couvert par un test d'en-têtes
(`server/test/csp-headers.test.mjs`).

Si une page blanche réapparaît après une modification du frontend :

1. Ouvrir la console du navigateur (F12) : une violation CSP y est explicite
   (« Refused to … because it violates the Content Security Policy »).
2. Vérifier que le service tourne : `systemctl status osteosoft-api` et
   `journalctl -u osteosoft-api -n 50`.
3. Vérifier que le build est présent : `ls <APP_DIR>/dist/OsteoSoft/browser/index.html`.
4. Rejouer `npm run test:e2e` en local : le scénario CSP échoue si une ressource
   inline ou tierce a été réintroduite.
