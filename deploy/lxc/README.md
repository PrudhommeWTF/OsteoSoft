# Déploiement LXC Proxmox

Kit de déploiement natif d'OsteoSoft dans un conteneur LXC Proxmox VE
(Debian 12), sans Docker. Le frontend Angular compilé et l'API Node.js sont
servis par **nginx** (statique + proxy `/api`), l'API tournant en service
**systemd**.

```
deploy/lxc/
├── proxmox-create-lxc.sh   # exécuté sur l'HÔTE Proxmox : crée le conteneur puis installe
├── install.sh              # exécuté DANS le conteneur : build + services
├── osteosoft-api.service   # gabarit d'unité systemd (API)
└── nginx.conf              # gabarit de site nginx (statique + proxy /api)
```

## Architecture

```
              :80 / :443 (nginx, TLS)
Navigateur ─────────────► nginx ──┬─► /            → dist/OsteoSoft/browser (SPA Angular)
                                  └─► /api/         → 127.0.0.1:4199 (API Node, systemd)
                                                        └─► SQLite  /opt/osteosoft/server/data
```

## Option A — tout depuis l'hôte Proxmox (recommandé)

Sur l'hôte Proxmox VE, en root :

```bash
git clone https://github.com/PrudhommeWTF/OsteoSoft.git
cd OsteoSoft/deploy/lxc
DOMAIN=osteosoft.example.com ./proxmox-create-lxc.sh
```

Le script crée un conteneur non privilégié, y pousse le code (le checkout
local, donc **fonctionne aussi pour un dépôt privé**), puis lance `install.sh`.

Personnalisation via variables d'environnement :

```bash
CTID=910 HOSTNAME=osteosoft \
STORAGE=local-lvm DISK_GB=8 CORES=2 RAM_MB=2048 \
BRIDGE=vmbr0 IP=192.168.1.50/24 GATEWAY=192.168.1.1 DNS=192.168.1.1 \
DOMAIN=osteosoft.example.com \
./proxmox-create-lxc.sh
```

Défauts : `HOSTNAME=osteosoft`, `STORAGE=local-lvm`, `DISK_GB=8`, `CORES=2`,
`RAM_MB=2048`, `BRIDGE=vmbr0`, `IP=dhcp`, template
`debian-12-standard_12.7-1_amd64.tar.zst`. Le `CTID` est auto-attribué si absent.

## Option B — dans un conteneur LXC déjà existant

Depuis un LXC Debian 12 (Node non requis au préalable), en root :

```bash
# soit le code est déjà présent dans /opt/osteosoft, soit install.sh le clonera
DOMAIN=osteosoft.example.com \
REPO_URL=https://github.com/PrudhommeWTF/OsteoSoft.git BRANCH=main \
bash install.sh
```

Pour un **dépôt privé**, passez un `REPO_URL` authentifié
(`https://<token>@github.com/PrudhommeWTF/OsteoSoft.git`) ou copiez le code
dans `/opt/osteosoft` avant de lancer `install.sh` (le clone est alors ignoré).

## Après l'installation

1. **TLS (obligatoire hors LAN de confiance)** — dans le conteneur :
   ```bash
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d osteosoft.example.com
   ```
   Puis mettre à jour l'origine et redémarrer l'API :
   ```bash
   sed -i 's#^CLIENT_ORIGIN=.*#CLIENT_ORIGIN=https://osteosoft.example.com#' /opt/osteosoft/.env
   systemctl restart osteosoft-api
   ```
2. **Premier démarrage** : ouvrir `https://osteosoft.example.com/` et suivre
   l'assistant. Si l'accès n'est pas local, mettre temporairement
   `ALLOW_REMOTE_SETUP=true` dans `.env` (puis le repasser à `false`).
3. **Pare-feu** : n'exposer que 80/443. L'API écoute sur `:4199` ; gardez ce
   port **interne** au conteneur (Proxmox Firewall ou ne pas le publier).

## Exploitation

| Action | Commande (dans le conteneur) |
|---|---|
| État de l'API | `systemctl status osteosoft-api` |
| Logs API | `journalctl -u osteosoft-api -f` |
| Redémarrer l'API | `systemctl restart osteosoft-api` |
| Recharger nginx | `nginx -t && systemctl reload nginx` |
| Données SQLite | `/opt/osteosoft/server/data/` |
| Secrets | `/opt/osteosoft/.env` |

## Mise à jour

Relancer `install.sh` est idempotent : il met à jour le code (si cloné),
recompile le frontend, élague les dépendances et redémarre les services. Le
`.env` existant (donc les secrets) est **conservé**.

```bash
cd /opt/osteosoft && git pull   # si installé via clone
bash deploy/lxc/install.sh
```

## Sauvegarde / restauration

- **À sauvegarder** : `/opt/osteosoft/server/data/` (base SQLite) **et**
  la clé `OSTEOSOFT_DATA_KEY` de `.env`, conservée **séparément** — sans elle,
  les données chiffrées sont irrécupérables.
- Snapshots/backups Proxmox du conteneur : pratiques, mais ils contiennent la
  clé de chiffrement à côté des données. Pour respecter la séparation exigée
  par le guide RGPD, préférez une sauvegarde applicative de `server/data` et un
  stockage distinct de la clé.

## Prérequis dans le conteneur (installés automatiquement)

Node.js 20 (NodeSource), nginx, `build-essential` + `python3` (compilation du
module natif `better-sqlite3`), git.
