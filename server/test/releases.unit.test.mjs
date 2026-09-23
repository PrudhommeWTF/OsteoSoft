// Choix de la release proposee selon le canal (stable / preversions), et
// comparaison de versions semver, preversions comprises. Aucun appel reseau :
// le fetch est injecte.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  semverCmp,
  isPrereleaseTag,
  normalizeUpdateChannel,
  fetchRelease
} from '../lib/releases.mjs';

/**
 * Faux fetch : repond selon l'URL, et note les URL consultees.
 * @param {Record<string, { status?: number, body?: any }>} routes
 */
function fakeFetch(routes) {
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  const doFetch = async (/** @type {string} */ url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    const route = key ? routes[key] : { status: 404 };
    const status = route.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => route.body };
  };
  return { doFetch, calls };
}

describe('semverCmp', () => {
  test('ordre numerique des composantes', () => {
    assert.ok(semverCmp('0.3.0', '0.2.9') > 0);
    assert.ok(semverCmp('1.10.0', '1.9.0') > 0);
    assert.equal(semverCmp('v1.2.3', '1.2.3'), 0);
  });

  test('une preversion precede la version qu elle prepare', () => {
    assert.ok(semverCmp('1.3.0-rc.1', '1.3.0') < 0);
    assert.ok(semverCmp('1.3.0', '1.3.0-rc.1') > 0);
  });

  test('preversions entre elles : numerique puis alphanumerique', () => {
    assert.ok(semverCmp('1.3.0-rc.2', '1.3.0-rc.1') > 0);
    assert.ok(semverCmp('1.3.0-rc.1', '1.3.0-rc.beta') < 0);
    assert.ok(semverCmp('1.3.0-rc', '1.3.0-rc.1') < 0);
  });

  test('les metadonnees de build sont ignorees', () => {
    assert.equal(semverCmp('1.2.3+build.5', '1.2.3'), 0);
  });
});

describe('isPrereleaseTag / normalizeUpdateChannel', () => {
  test('detection d une preversion', () => {
    assert.equal(isPrereleaseTag('v1.3.0-rc.1'), true);
    assert.equal(isPrereleaseTag('v1.3.0'), false);
  });

  test('canal inconnu : stable par defaut', () => {
    assert.equal(normalizeUpdateChannel('prerelease'), 'prerelease');
    assert.equal(normalizeUpdateChannel('latest'), 'latest');
    assert.equal(normalizeUpdateChannel('nimporte'), 'latest');
    assert.equal(normalizeUpdateChannel(undefined), 'latest');
  });
});

describe('fetchRelease', () => {
  const repo = 'Owner/Repo';

  test('canal stable : /releases/latest', async () => {
    const { doFetch, calls } = fakeFetch({
      '/releases/latest': { body: { tag_name: 'v0.4.0', name: 'v0.4.0', body: 'notes', html_url: 'u', prerelease: false } }
    });
    const rel = await fetchRelease({ repo, channel: 'latest', doFetch, apiBase: 'http://gh' });
    assert.equal(rel.tag, 'v0.4.0');
    assert.equal(rel.prerelease, false);
    assert.equal(calls[0], 'http://gh/repos/Owner/Repo/releases/latest');
  });

  test('canal preversions : plus haute release publiee, brouillons exclus', async () => {
    const { doFetch } = fakeFetch({
      '/releases?per_page=30': {
        body: [
          { tag_name: 'v0.4.0', prerelease: false },
          { tag_name: 'v0.5.0-rc.1', prerelease: true },
          { tag_name: 'v0.6.0-rc.1', prerelease: true, draft: true }
        ]
      }
    });
    const rel = await fetchRelease({ repo, channel: 'prerelease', doFetch, apiBase: 'http://gh' });
    assert.equal(rel.tag, 'v0.5.0-rc.1', 'la preversion la plus haute, hors brouillon');
    assert.equal(rel.prerelease, true);
  });

  test('sans release : repli sur les tags, canal stable sans preversion', async () => {
    const { doFetch } = fakeFetch({
      '/releases/latest': { status: 404 },
      '/tags?per_page=100': { body: [{ name: 'v0.2.0' }, { name: 'v0.3.0' }, { name: 'v0.4.0-rc.1' }] }
    });
    const rel = await fetchRelease({ repo, channel: 'latest', doFetch, apiBase: 'http://gh' });
    assert.equal(rel.tag, 'v0.3.0', 'le tag -rc est ignore sur le canal stable');
  });

  test('sans release : repli sur les tags, canal preversions inclut les -rc', async () => {
    const { doFetch } = fakeFetch({
      '/releases?per_page=30': { body: [] },
      '/tags?per_page=100': { body: [{ name: 'v0.3.0' }, { name: 'v0.4.0-rc.1' }] }
    });
    const rel = await fetchRelease({ repo, channel: 'prerelease', doFetch, apiBase: 'http://gh' });
    assert.equal(rel.tag, 'v0.4.0-rc.1');
  });

  test('erreur GitHub autre que 404 : remontee', async () => {
    const { doFetch } = fakeFetch({ '/releases/latest': { status: 500 } });
    await assert.rejects(
      fetchRelease({ repo, channel: 'latest', doFetch, apiBase: 'http://gh' }),
      /GitHub HTTP 500/
    );
  });

  test('aucune version stable publiee : erreur explicite', async () => {
    const { doFetch } = fakeFetch({
      '/releases/latest': { status: 404 },
      '/tags?per_page=100': { body: [{ name: 'v0.4.0-rc.1' }] }
    });
    await assert.rejects(
      fetchRelease({ repo, channel: 'latest', doFetch, apiBase: 'http://gh' }),
      /aucune version stable/
    );
  });
});
