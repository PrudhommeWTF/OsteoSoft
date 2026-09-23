// deploy/lxc/install.sh, section « Service systemd », eprouvee dans un bac a
// sable : on execute le VRAI texte de la section avec un faux systemctl qui
// reproduit la semantique de systemd (en particulier : `enable --now` sur un
// service DEJA actif ne le redemarre pas). Aucun systemd ni droit root requis.
//
// Regression : relancer install.sh pour mettre a jour deposait le nouveau code
// mais laissait tourner l'ancien processus Node (frontend neuf servi depuis le
// disque, API ancienne : routes absentes, ancienne version annoncee).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LXC_DIR = path.resolve(HERE, '..', '..', 'deploy', 'lxc');
const INSTALL = path.join(LXC_DIR, 'install.sh');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// Faux systemctl : l'etat « code charge par le processus » est la valeur de
// CODE_MARKER au moment du (re)demarrage.
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_STATE/systemctl.log"
start_service() { printf '%s' "$CODE_MARKER" > "$FAKE_STATE/loaded"; touch "$FAKE_STATE/active"; }
case "$1" in
  daemon-reload) ;;
  enable)
    touch "$FAKE_STATE/enabled"
    if [ "$2" = "--now" ] && [ ! -e "$FAKE_STATE/active" ]; then start_service; fi ;;
  start) [ -e "$FAKE_STATE/active" ] || start_service ;;
  restart) start_service ;;
  is-active) [ -e "$FAKE_STATE/active" ] ;;
esac
exit 0
`;

/** Texte de la section 7 d'install.sh, /etc/systemd/system redirige vers le bac a sable. */
function serviceSection(unitDir) {
  const text = fs.readFileSync(INSTALL, 'utf8');
  const start = text.indexOf('# ── 7. Service systemd');
  const end = text.indexOf('# ── 8.');
  assert.ok(start > 0 && end > start, 'section 7 introuvable dans install.sh');
  return text.slice(start, end).replaceAll('/etc/systemd/system', unitDir);
}

function sandbox({ active }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osteosoft-install-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  const units = path.join(root, 'units');
  for (const dir of [bin, state, units]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
  if (active) {
    fs.writeFileSync(path.join(state, 'loaded'), 'ancien-code');
    fs.writeFileSync(path.join(state, 'active'), '');
    fs.writeFileSync(path.join(state, 'enabled'), '');
  }
  const script = [
    'set -euo pipefail',
    'log() { :; }',
    `SCRIPT_DIR=${JSON.stringify(LXC_DIR)}`,
    'APP_DIR=/opt/osteosoft',
    'APP_USER=osteosoft',
    serviceSection(units)
  ].join('\n');
  return { root, bin, state, units, script };
}

function run(sb) {
  const result = spawnSync('bash', ['-c', sb.script], {
    env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, FAKE_STATE: sb.state, CODE_MARKER: 'nouveau-code' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    loaded: fs.readFileSync(path.join(sb.state, 'loaded'), 'utf8'),
    enabled: fs.existsSync(path.join(sb.state, 'enabled')),
    unit: fs.readFileSync(path.join(sb.units, 'osteosoft-api.service'), 'utf8')
  };
}

describe('install.sh : service systemd', () => {
  test('mise a jour : le service deja actif est REDEMARRE sur le nouveau code', () => {
    const out = run(sandbox({ active: true }));
    assert.equal(out.loaded, 'nouveau-code', 'l ancien processus ne doit pas continuer a tourner');
    assert.equal(out.enabled, true);
  });

  test('premiere installation : le service est active et demarre', () => {
    const out = run(sandbox({ active: false }));
    assert.equal(out.loaded, 'nouveau-code');
    assert.equal(out.enabled, true);
    assert.match(out.unit, /\/opt\/osteosoft/, 'unite generee avec le dossier de l application');
  });
});
