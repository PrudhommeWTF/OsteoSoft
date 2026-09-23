// Script root de mise a jour (deploy/lxc/self-update.sh), eprouve DE BOUT EN BOUT
// dans un bac a sable : systemctl, curl et npm sont remplaces par des faux
// (dans le PATH), tout le reste est reel (tar, find, flock, node...). Aucun
// reseau, aucun systemd, aucun droit root requis (compatible CI).
//
// Scenarios : succes (code remplace, .env et base preserves, sauvegarde,
// script root actualise), retour arriere automatique si la nouvelle version ne
// repond pas (code ET base restaures, migration annulee), tag piege refuse,
// retour en arriere de version refuse, archive incoherente, .env malveillant
// jamais execute.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'deploy', 'lxc', 'self-update.sh');
const USER = os.userInfo().username;

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_STATE/systemctl.log"
case "$1" in
  stop) rm -f "$FAKE_STATE/running-version" ;;
  start)
    v="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$APP_DIR/package.json")"
    echo "$v" > "$FAKE_STATE/running-version"
    # Simule une migration de schema appliquee au demarrage de la nouvelle version.
    if [ -n "\${FAKE_MIGRATE_VERSION:-}" ] && [ "$v" = "$FAKE_MIGRATE_VERSION" ]; then
      echo "migree-par-$v" > "$APP_DIR/server/data/osteo.db"
    fi ;;
esac
exit 0
`;

const FAKE_CURL = `#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  */api/health)
    [ -f "$FAKE_STATE/running-version" ] || exit 7
    v="$(cat "$FAKE_STATE/running-version")"
    [ "$v" = "\${FAKE_HEALTH_FAIL_VERSION:-}" ] && exit 7
    printf '{"status":"ok","version":"%s"}' "$v" ;;
  *)
    echo "$url" >> "$FAKE_STATE/curl-urls.log"
    cat "$FAKE_TARBALL" ;;
esac
`;

const FAKE_NPM = `#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_STATE/npm.log"
case "$1 \${2:-}" in
  "ci "*) mkdir -p node_modules && touch node_modules/.installe ;;
  "run build") mkdir -p dist/OsteoSoft/browser && echo index > dist/OsteoSoft/browser/index.html ;;
esac
exit 0
`;

/**
 * Prepare une installation 0.3.0 et une release (archive) a installer.
 * @param {{ releaseVersion?: string, envExtra?: string }} [opts]
 */
function sandbox(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osteosoft-selfupdate-sh-'));
  roots.push(root);
  const appDir = path.join(root, 'app');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(state, { recursive: true });

  // Installation en place : version 0.3.0.
  write(path.join(appDir, 'package.json'), JSON.stringify({ name: 'osteo-soft', version: '0.3.0' }));
  write(path.join(appDir, 'server', 'index.mjs'), 'ancien code');
  write(path.join(appDir, 'fichier-retire.txt'), 'present seulement dans 0.3.0');
  write(path.join(appDir, '.env'), `API_PORT=4199\nJWT_SECRET=secret\n${opts.envExtra ?? ''}`);
  write(path.join(appDir, 'server', 'data', 'osteo.db'), 'donnees-avant');

  // Release a installer (archive avec un dossier racine, comme codeload).
  const version = opts.releaseVersion ?? '0.4.0';
  const pkg = path.join(root, 'pkg', `OsteoSoft-${version}`);
  write(path.join(pkg, 'package.json'), JSON.stringify({ name: 'osteo-soft', version }));
  write(path.join(pkg, 'server', 'index.mjs'), 'nouveau code');
  write(path.join(pkg, 'deploy', 'lxc', 'self-update.sh'), '#!/bin/sh\n# nouveau script root\n');
  const tarball = path.join(root, 'release.tgz');
  spawnSync('tar', ['-czf', tarball, '-C', path.join(root, 'pkg'), `OsteoSoft-${version}`]);

  write(path.join(bin, 'systemctl'), FAKE_SYSTEMCTL, 0o755);
  write(path.join(bin, 'curl'), FAKE_CURL, 0o755);
  write(path.join(bin, 'npm'), FAKE_NPM, 0o755);

  const helper = path.join(root, 'sbin', 'osteosoft-self-update.sh');
  write(helper, '#!/bin/sh\n# ancien script root\n', 0o755);

  // Service « en marche » en 0.3.0 au depart.
  fs.writeFileSync(path.join(state, 'running-version'), '0.3.0');

  return { root, appDir, state, bin, helper, tarball, backups: path.join(root, 'backups'), logDir: path.join(root, 'log') };
}

/** @param {ReturnType<typeof sandbox>} sb @param {string} trigger @param {Record<string,string>} [env] */
function run(sb, trigger, env = {}) {
  write(path.join(sb.appDir, 'server', 'data', '.update-trigger'), trigger);
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${sb.bin}:${process.env.PATH}`,
      APP_DIR: sb.appDir,
      APP_USER: USER,
      LOG_DIR: sb.logDir,
      BACKUP_ROOT: sb.backups,
      WORK_ROOT: sb.root,
      LOCK_FILE: path.join(sb.root, 'update.lock'),
      HELPER_PATH: sb.helper,
      HEALTH_TIMEOUT: '6',
      MIN_FREE_MB: '1',
      FAKE_STATE: sb.state,
      FAKE_TARBALL: sb.tarball,
      ...env
    }
  });
  const statusPath = path.join(sb.appDir, 'server', 'data', 'update-status.json');
  const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : null;
  const log = fs.existsSync(path.join(sb.logDir, 'update.log')) ? fs.readFileSync(path.join(sb.logDir, 'update.log'), 'utf8') : '';
  const systemctl = fs.existsSync(path.join(sb.state, 'systemctl.log')) ? fs.readFileSync(path.join(sb.state, 'systemctl.log'), 'utf8') : '';
  const version = JSON.parse(fs.readFileSync(path.join(sb.appDir, 'package.json'), 'utf8')).version;
  const db = fs.readFileSync(path.join(sb.appDir, 'server', 'data', 'osteo.db'), 'utf8').trim();
  return { code: res.status, status, log, systemctl, version, db };
}

describe('self-update.sh (bac a sable)', () => {
  test('succes : code remplace, .env et base preserves, sauvegarde, script actualise', () => {
    const marker = path.join(os.tmpdir(), `osteosoft-pwned-${process.pid}-${Date.now()}`);
    const sb = sandbox({ envExtra: `OSTEOSOFT_GITHUB_REPO=$(touch ${marker})Evil/Repo\n` });
    const r = run(sb, 'tag=v0.4.0\n', { FAKE_MIGRATE_VERSION: '0.4.0' });

    assert.equal(r.code, 0, r.log);
    assert.equal(r.status?.state, 'done', r.log);
    assert.equal(r.version, '0.4.0');
    assert.equal(fs.readFileSync(path.join(sb.appDir, 'server', 'index.mjs'), 'utf8'), 'nouveau code');
    assert.equal(fs.existsSync(path.join(sb.appDir, 'fichier-retire.txt')), false, 'fichier supprime en amont retire');
    assert.match(fs.readFileSync(path.join(sb.appDir, '.env'), 'utf8'), /JWT_SECRET=secret/, '.env preserve');
    assert.equal(r.db, 'migree-par-0.4.0', 'la base migree par la nouvelle version est conservee');
    assert.equal(fs.existsSync(path.join(sb.appDir, 'server', 'data', '.update-trigger')), false, 'declencheur consomme');
    assert.ok(fs.existsSync(path.join(sb.appDir, 'dist', 'OsteoSoft', 'browser', 'index.html')), 'build installe');

    // Sauvegarde : base d'avant + code d'avant.
    const [bk] = fs.readdirSync(sb.backups);
    assert.match(bk, /-v0\.3\.0$/);
    assert.equal(fs.readFileSync(path.join(sb.backups, bk, 'data', 'osteo.db'), 'utf8').trim(), 'donnees-avant');
    assert.ok(fs.existsSync(path.join(sb.backups, bk, 'code.tar')));

    // Script root actualise depuis la release.
    assert.match(fs.readFileSync(sb.helper, 'utf8'), /nouveau script root/);

    // Service arrete puis redemarre ; .env jamais execute ; depot par defaut.
    assert.match(r.systemctl, /stop osteosoft-api[\s\S]*start osteosoft-api/);
    assert.equal(fs.existsSync(marker), false, 'le .env n est jamais execute');
    const urls = fs.readFileSync(path.join(sb.state, 'curl-urls.log'), 'utf8');
    assert.match(urls, /PrudhommeWTF\/OsteoSoft\/tar\.gz\/refs\/tags\/v0\.4\.0/);
  });

  test('retour arriere : nouvelle version muette -> ancien code ET ancienne base restaures', () => {
    const sb = sandbox();
    const r = run(sb, 'tag=v0.4.0\n', { FAKE_MIGRATE_VERSION: '0.4.0', FAKE_HEALTH_FAIL_VERSION: '0.4.0' });

    assert.equal(r.code, 1);
    assert.equal(r.status?.state, 'error');
    assert.match(r.status?.message ?? '', /0\.3\.0 restaurée/);
    assert.equal(r.version, '0.3.0', 'ancien code restaure');
    assert.equal(fs.readFileSync(path.join(sb.appDir, 'server', 'index.mjs'), 'utf8'), 'ancien code');
    assert.ok(fs.existsSync(path.join(sb.appDir, 'fichier-retire.txt')), 'arbre d origine restaure');
    assert.equal(r.db, 'donnees-avant', 'la migration est annulee : base d avant restauree');
    assert.equal(fs.readFileSync(path.join(sb.state, 'running-version'), 'utf8').trim(), '0.3.0', 'service relance en 0.3.0');
  });

  test('tag piege : refuse, rien n est touche', () => {
    const sb = sandbox();
    const r = run(sb, 'tag=v1.2.3;touch /tmp/pwned\n');
    assert.equal(r.code, 1);
    assert.equal(r.status?.state, 'error');
    assert.match(r.status?.message ?? '', /Déclencheur invalide/);
    assert.equal(r.systemctl, '', 'aucune action sur le service');
    assert.equal(r.version, '0.3.0');
  });

  test('retour en arriere de version refuse (defense en profondeur)', () => {
    const sb = sandbox({ releaseVersion: '0.2.0' });
    const r = run(sb, 'tag=v0.2.0\n');
    assert.equal(r.code, 1);
    assert.match(r.status?.message ?? '', /pas plus récente/);
    assert.equal(r.systemctl, '');
    assert.equal(fs.existsSync(path.join(sb.state, 'curl-urls.log')), false, 'rien telecharge');
  });

  test('archive incoherente (version differente du tag) : refus avant tout arret', () => {
    const sb = sandbox({ releaseVersion: '0.5.0' });
    const r = run(sb, 'tag=v0.4.0\n');
    assert.equal(r.code, 1);
    assert.match(r.status?.message ?? '', /incohérente/);
    assert.equal(r.systemctl, '', 'le service n a jamais ete arrete');
    assert.equal(r.version, '0.3.0');
    assert.equal(r.db, 'donnees-avant');
  });
});
