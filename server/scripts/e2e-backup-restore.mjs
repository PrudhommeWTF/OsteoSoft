import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';

const BASE_URL = 'http://localhost:3000';
const READY_TEXT = 'Secure SQLite API ready on http://localhost:3000';

function sha256Json(value) {
  const normalizeForStableHash = (nested) => {
    if (Array.isArray(nested)) {
      return nested.map((item) => normalizeForStableHash(item));
    }

    if (nested && typeof nested === 'object') {
      const sortedEntries = Object.entries(nested)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeForStableHash(child)]);
      return Object.fromEntries(sortedEntries);
    }

    return nested;
  };

  return createHash('sha256')
    .update(JSON.stringify(normalizeForStableHash(value)))
    .digest('hex');
}

function summarizeDataCollections(data) {
  const summary = {};
  for (const [key, value] of Object.entries(data || {})) {
    summary[key] = Array.isArray(value) ? value.length : -1;
  }
  return summary;
}

function normalizeSetCookie(raw) {
  if (!raw) {
    return '';
  }
  return String(raw).split(',')[0].split(';')[0].trim();
}

async function ensureSetupIfNeeded() {
  const setupRes = await fetch(`${BASE_URL}/api/setup/status`);
  if (!setupRes.ok) {
    throw new Error(`setup/status failed (${setupRes.status})`);
  }

  const setupPayload = await setupRes.json();
  if (!setupPayload?.requiresSetup) {
    return;
  }

  const demoRes = await fetch(`${BASE_URL}/api/setup/demo`, { method: 'POST' });
  if (!demoRes.ok) {
    const errorBody = await demoRes.text();
    throw new Error(`setup/demo failed (${demoRes.status}) ${errorBody}`);
  }
}

async function loginAdmin() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`login failed (${res.status}) ${body}`);
  }

  const cookie = normalizeSetCookie(res.headers.get('set-cookie'));
  if (!cookie.startsWith('os_session=')) {
    throw new Error('no os_session cookie returned by login');
  }

  return cookie;
}

async function downloadBackup(cookie) {
  const res = await fetch(`${BASE_URL}/api/data-management/backup`, {
    headers: { Cookie: cookie }
  });
  if (!res.ok) {
    throw new Error(`backup failed (${res.status})`);
  }

  const zipBuffer = Buffer.from(await res.arrayBuffer());
  const zip = await JSZip.loadAsync(zipBuffer);

  const manifestRaw = await zip.file('manifest.json').async('string');
  const dataRaw = await zip.file('data.json').async('string');

  return {
    manifest: JSON.parse(manifestRaw),
    data: JSON.parse(dataRaw)
  };
}

async function restoreBackup(cookie, payload) {
  const res = await fetch(`${BASE_URL}/api/data-management/restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify(payload)
  });

  if (res.status !== 204) {
    const body = await res.text();
    throw new Error(`restore failed (${res.status}) ${body}`);
  }
}

function printSummary(label, summary, keys) {
  console.log(label);
  for (const key of keys) {
    console.log(`- ${key}: ${summary[key] ?? 0}`);
  }
}

async function run() {
  const server = spawn('node', ['server/index.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd()
  });

  let ready = false;
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const onData = (chunk) => {
    const text = String(chunk);
    if (!ready && text.includes(READY_TEXT)) {
      ready = true;
      readyResolve();
    }
  };

  server.stdout.on('data', onData);
  server.stderr.on('data', onData);

  server.on('exit', (code) => {
    if (!ready) {
      readyReject(new Error(`api exited before ready (code=${code ?? 'null'})`));
    }
  });

  const timeout = setTimeout(() => {
    if (!ready) {
      readyReject(new Error('api startup timeout'));
    }
  }, 30000);

  try {
    await readyPromise;
    await ensureSetupIfNeeded();

    const cookie = await loginAdmin();

    const first = await downloadBackup(cookie);
    await restoreBackup(cookie, first);
    const second = await downloadBackup(cookie);

    const firstHash = sha256Json(first.data);
    const secondHash = sha256Json(second.data);
    const firstManifestOk = String(first.manifest?.dataSha256 ?? '').toLowerCase() === firstHash;
    const secondManifestOk = String(second.manifest?.dataSha256 ?? '').toLowerCase() === secondHash;

    const firstSummary = summarizeDataCollections(first.data);
    const secondSummary = summarizeDataCollections(second.data);

    const equalData = firstHash === secondHash;
    const equalSummary = JSON.stringify(firstSummary) === JSON.stringify(secondSummary);

    console.log('[E2E] Backup/Restore result');
    console.log(`- Manifest #1 checksum valid: ${firstManifestOk}`);
    console.log(`- Manifest #2 checksum valid: ${secondManifestOk}`);
    console.log(`- Data hash before restore: ${firstHash}`);
    console.log(`- Data hash after restore : ${secondHash}`);
    console.log(`- Exact data equality: ${equalData}`);
    console.log(`- Collection count equality: ${equalSummary}`);

    const criticalKeys = [
      'patients',
      'appointments',
      'consultations',
      'invoices',
      'invoiceLineItems',
      'invoicePayments',
      'accountingExpenses',
      'accountingDeposits',
      'accountingDepositItems',
      'accountingOperationMeta',
      'paymentMethods',
      'directoryContacts'
    ];

    printSummary('[E2E] Before restore counts', firstSummary, criticalKeys);
    printSummary('[E2E] After restore counts', secondSummary, criticalKeys);

    if (!firstManifestOk || !secondManifestOk || !equalData || !equalSummary) {
      process.exitCode = 1;
      return;
    }

    console.log('[E2E] SUCCESS');
  } finally {
    clearTimeout(timeout);
    server.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error('[E2E] FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
