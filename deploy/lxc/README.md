# Déploiement LXC Proxmox

Kit de déploiement natif d'OsteoSoft dans un conteneur LXC Proxmox VE
(Debian 12), sans Docker. Déploiement **mono-service** : l'API Node.js sert à la
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
CTID=910 HOSTNAME=osteosoft \
STORAGE=local-lvm DISK_GB=8 CORES=2 RAM_MB=2048 \
BRIDGE=vmbr0 IP=192.168.1.50/24 GATEWAY=192.168.1.1 DNS=192.168.1.1 \
API_PORT=4199 DOMAIN=osteosoft.example.com \
./proxmox-create-lxc.sh
```

Défauts : `HOSTNAME=osteosoft`, `STORAGE=local-lvm`, `DISK_GB=8`, `CORES=2`,
`RAM_MB=2048`, `BRIDGE=vmbr0`, `IP=dhcp`, `API_PORT=4199`. Le `CTID` est
auto-attribué si absent.

### Template Debian

Le script ne fige pas de révision de correctif. Il résout automatiquement le
dernier template `debian-<release>-standard` disponible (par défaut
`DEBIAN_RELEASE=12`), d'abord parmi ceux déjà téléchargés, sinon dans le
catalogue `pveam`. On évite ainsi l'échec quand une révision figée (ex.
`12.7-1`) disparaît du catalogue au profit de la suivante.

- `DEBIAN_RELEASE=13` : viser une autre version majeure (Node est installé via
  NodeSource, qui gère le nom de code Debian).
- `TEMPLATE_NAME=debian-12-standard_12.12-1_amd64.tar.zst` : forcer un template
  précis (contourne la résolution automatique).

## Option B — dans un conteneur LXC déjà existant

Depuis un LXC Debian 12, en root :

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

Relancer `install.sh` est idempotent : il met à jour le code (si cloné),
recompile le frontend, élague les dépendances et redémarre le service. Le
`.env` existant (donc les secrets) est **conservé**.

```bash
cd /opt/osteosoft && git pull   # si installé via clone
bash deploy/lxc/install.sh
```

## Sauvegarde / restauration

- **À sauvegarder** : `/opt/osteosoft/server/data/` (base SQLite) **et**
  la clé `OSTEOSOFT_DATA_KEY` de `.env`, conservée **séparément** — sans elle,
  les données chiffrées sont irrécupérables.
- Les snapshots/backups Proxmox du conteneur contiennent la clé à côté des
  données ; pour respecter la séparation exigée par le guide RGPD, préférez une
  sauvegarde applicative de `server/data` et un stockage distinct de la clé.

## Prérequis dans le conteneur (installés automatiquement)

Node.js 20 (NodeSource), `build-essential` + `python3` (compilation du module
natif `better-sqlite3`), git.
