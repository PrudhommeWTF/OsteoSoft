// Mise a jour en un clic : frontiere de privilege (tag valide uniquement),
// capacite constatee (script root present), statut perime, declencheur.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isValidReleaseTag,
  selfUpdateCapability,
  freshUpdateStatus,
  readUpdateStatus,
  writeUpdateTrigger,
  UPDATE_STALE_MS,
  UPDATE_TRIGGER_FILE,
  UPDATE_STATUS_FILE,
  UPDATE_LOG_PATH
} from '../lib/self-update.mjs';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osteosoft-selfupdate-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('isValidReleaseTag (frontiere de privilege)', () => {
  test('accepte les tags de version', () => {
    for (const tag of ['v0.3.0', '0.3.0', 'v1.2.3-rc.1', 'v10.20.30-beta']) {
      assert.equal(isValidReleaseTag(tag), true, tag);
    }
  });

  test('refuse tout ce qui pourrait etre interprete par le shell', () => {
    for (const tag of ['', 'v1.2', 'v1.2.3;rm -rf /', 'v1.2.3 $(id)', '../../etc', 'v1.2.3\nx', 'v1.2.3/x', 'latest', null, 42]) {
      assert.equal(isValidReleaseTag(tag), false, String(tag));
    }
  });
});

describe('selfUpdateCapability', () => {
  test('script absent : impossible (missing)', () => {
    const cap = selfUpdateCapability({ helper: path.join(tmpDir(), 'absent.sh') });
    assert.equal(cap.possible, false);
    assert.equal(cap.reason, 'missing');
  });

  test('script present : possible', () => {
    const helper = path.join(tmpDir(), 'helper.sh');
    fs.writeFileSync(helper, '#!/bin/sh\n');
    assert.equal(selfUpdateCapability({ helper }).possible, true);
  });

  test('interrupteur d arret : coupe meme si le script est present', () => {
    const helper = path.join(tmpDir(), 'helper.sh');
    fs.writeFileSync(helper, '#!/bin/sh\n');
    const cap = selfUpdateCapability({ helper, refusal: 'false' });
    assert.equal(cap.possible, false);
    assert.equal(cap.reason, 'disabled');
  });
});

describe('freshUpdateStatus', () => {
  const now = 1_000_000_000_000;

  test('un etat non running passe tel quel', () => {
    const s = { state: 'done', message: 'ok', ts: 1 };
    assert.deepEqual(freshUpdateStatus(s, now, '/log'), s);
  });

  test('running recent : conserve', () => {
    const s = { state: 'running', ts: now - 60_000 };
    assert.equal(freshUpdateStatus(s, now, '/log').state, 'running');
  });

  test('running sans progression au-dela du delai : declare interrompu', () => {
    const s = { state: 'running', ts: now - UPDATE_STALE_MS - 1 };
    const out = freshUpdateStatus(s, now, '/data/update.log');
    assert.equal(out.state, 'error');
    assert.match(String(out.message), /interrompue/);
    assert.match(String(out.message), /\/data\/update\.log/);
  });
});

describe('declencheur et lecture du statut', () => {
  test('writeUpdateTrigger pose tag et statut running', () => {
    const dir = tmpDir();
    writeUpdateTrigger(dir, 'v0.4.0', 123);
    assert.equal(fs.readFileSync(path.join(dir, UPDATE_TRIGGER_FILE), 'utf-8'), 'tag=v0.4.0\n');
    const status = JSON.parse(fs.readFileSync(path.join(dir, UPDATE_STATUS_FILE), 'utf-8'));
    assert.equal(status.state, 'running');
    assert.equal(status.ts, 123);
  });

  test('writeUpdateTrigger refuse un tag invalide et n ecrit rien', () => {
    const dir = tmpDir();
    assert.throws(() => writeUpdateTrigger(dir, 'v1.2.3;id'), /invalide/);
    assert.equal(fs.existsSync(path.join(dir, UPDATE_TRIGGER_FILE)), false);
  });

  test('readUpdateStatus : idle si absent ou illisible', () => {
    const dir = tmpDir();
    assert.equal(readUpdateStatus(dir).state, 'idle');
    fs.writeFileSync(path.join(dir, UPDATE_STATUS_FILE), '{pas du json');
    assert.equal(readUpdateStatus(dir).state, 'idle');
  });

  test('readUpdateStatus : un statut perime renvoie vers le journal du script root', () => {
    const dir = tmpDir();
    const now = 1_000_000_000_000;
    fs.writeFileSync(path.join(dir, UPDATE_STATUS_FILE),
      JSON.stringify({ state: 'running', ts: now - UPDATE_STALE_MS - 1 }));
    const out = readUpdateStatus(dir, now);
    assert.equal(out.state, 'error');
    assert.equal(UPDATE_LOG_PATH, '/var/log/osteosoft/update.log');
    assert.ok(String(out.message).includes(UPDATE_LOG_PATH), out.message);
  });
});
