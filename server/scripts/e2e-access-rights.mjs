import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

const BASE_URL = 'http://localhost:3000';
const READY_TEXT = 'Secure SQLite API ready on http://localhost:3000';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Stop any running server before running e2e tests.`));
      } else {
        reject(err);
      }
    });
    probe.once('listening', () => {
      probe.close(() => resolve());
    });
    probe.listen(port, '127.0.0.1');
  });
}

function normalizeSetCookie(raw) {
  if (!raw) return '';
  return String(raw).split(',')[0].split(';')[0].trim();
}

async function ensureSetupIfNeeded() {
  const res = await fetch(`${BASE_URL}/api/setup/status`);
  if (!res.ok) throw new Error(`setup/status failed (${res.status})`);
  const payload = await res.json();
  if (!payload?.requiresSetup) return;
  const demoRes = await fetch(`${BASE_URL}/api/setup/demo`, { method: 'POST' });
  if (!demoRes.ok) {
    const body = await demoRes.text();
    throw new Error(`setup/demo failed (${demoRes.status}) ${body}`);
  }
}

async function login(username, password) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`login failed for "${username}" (${res.status}) ${body}`);
  }
  const cookie = normalizeSetCookie(res.headers.get('set-cookie'));
  if (!cookie.startsWith('os_session=')) {
    throw new Error(`no os_session cookie returned for "${username}"`);
  }
  return cookie;
}

async function apiRequest(method, path, cookie, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.text() };
}

async function req(method, path, cookie, body) {
  const r = await apiRequest(method, path, cookie, body);
  return r.status;
}

async function createTestUser(adminCookie, { username, password, profileId }) {
  const res = await fetch(`${BASE_URL}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      username,
      password,
      profileId,
      role: 'practitioner',
      isActive: true,
      lastName: 'Test',
      firstName: username
    })
  });
  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`createTestUser "${username}" failed (${res.status}) ${body}`);
  }
  const data = await res.json();
  return data.user.id;
}

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual.status) : actual.status === expected;
  if (ok) {
    passed++;
    console.log(`  ✓ ${label} → ${actual.status}`);
  } else {
    failed++;
    const expectedStr = Array.isArray(expected) ? `one of [${expected.join(', ')}]` : String(expected);
    failures.push(`  ✗ ${label} → got ${actual.status}, expected ${expectedStr} | body: ${actual.body?.slice(0, 120)}`);
    console.log(`  ✗ ${label} → got ${actual.status}, expected ${expectedStr} | body: ${actual.body?.slice(0, 120)}`);
  }
}

// ─── Test suites ─────────────────────────────────────────────────────────────

async function testUnauthenticated() {
  console.log('\n[Suite] Unauthenticated requests');
  assert('GET /api/patients (no session)',         await apiRequest('GET',    '/api/patients'),                    401);
  assert('GET /api/offices (no session)',          await apiRequest('GET',    '/api/offices'),                     401);
  assert('GET /api/directory/contacts (no session)', await apiRequest('GET', '/api/directory/contacts'),          401);
  assert('POST /api/billing/invoices (no session)', await apiRequest('POST',  '/api/billing/invoices', null, {}), 401);
}

async function testAdminFullAccess(cookie) {
  console.log('\n[Suite] Admin user — full access expected');
  assert('GET /api/patients',              await apiRequest('GET',    '/api/patients', cookie),              200);
  assert('GET /api/offices',               await apiRequest('GET',    '/api/offices',  cookie),              200);
  assert('GET /api/directory/contacts',    await apiRequest('GET',    '/api/directory/contacts', cookie),    200);
  assert('GET /api/consultation-context',  await apiRequest('GET',    '/api/consultation-context', cookie),  200);
  // Body missing → 400 (not 403 = permission check passed)
  assert('POST /api/billing/invoices (bad body)', await apiRequest('POST', '/api/billing/invoices', cookie, {}), 400);
  // Non-existent id → 404 (not 403 = permission check passed)
  assert('DELETE /api/billing/invoices/99999999', await apiRequest('DELETE', '/api/billing/invoices/99999999', cookie), 404);
  assert('DELETE /api/offices/99999999',           await apiRequest('DELETE', '/api/offices/99999999', cookie),          404);
}

async function testCabinetMemberNoRights(cookie) {
  console.log('\n[Suite] cabinet-member user — no global rights, no delegation');
  assert('GET /api/patients',              await apiRequest('GET',    '/api/patients', cookie),              403);
  assert('GET /api/offices',               await apiRequest('GET',    '/api/offices',  cookie),              403);
  assert('GET /api/directory/contacts',    await apiRequest('GET',    '/api/directory/contacts', cookie),    403);
  assert('GET /api/consultation-context',  await apiRequest('GET',    '/api/consultation-context', cookie),  403);
  assert('POST /api/billing/invoices',     await apiRequest('POST',   '/api/billing/invoices', cookie, {}), 403);
  assert('DELETE /api/billing/invoices/1', await apiRequest('DELETE', '/api/billing/invoices/1', cookie),   403);
  assert('DELETE /api/offices/1',          await apiRequest('DELETE', '/api/offices/1', cookie),             403);
}

async function testAssistantPartialAccess(cookie) {
  console.log('\n[Suite] assistant user — partial access');
  // Allowed
  assert('GET /api/patients (read-patient-list)',             await apiRequest('GET', '/api/patients', cookie),             200);
  assert('GET /api/consultation-context (create-consultation)', await apiRequest('GET', '/api/consultation-context', cookie), 200);
  // Denied
  assert('GET /api/offices (no read-office-settings)',        await apiRequest('GET',    '/api/offices', cookie),            403);
  assert('GET /api/directory/contacts (no read-directory)',   await apiRequest('GET',    '/api/directory/contacts', cookie), 403);
  assert('POST /api/billing/invoices (no invoice-consultation)', await apiRequest('POST', '/api/billing/invoices', cookie, {}), 403);
  assert('DELETE /api/billing/invoices/1 (no cancel-invoice)', await apiRequest('DELETE', '/api/billing/invoices/1', cookie), 403);
  assert('DELETE /api/offices/1 (no delete-office)',          await apiRequest('DELETE', '/api/offices/1', cookie),          403);
}

async function testComptabiliteAccess(cookie) {
  console.log('\n[Suite] comptabilite user — billing rights, no office/patient-write/consultation');
  // Allowed
  assert('GET /api/patients (read-patient-list)',                  await apiRequest('GET',    '/api/patients', cookie),                  200);
  assert('POST /api/billing/invoices (no body → 400)',             await apiRequest('POST',   '/api/billing/invoices', cookie, {}),      400);
  assert('DELETE /api/billing/invoices/99999999 (cancel-invoice)', await apiRequest('DELETE', '/api/billing/invoices/99999999', cookie), 404);
  // Denied
  assert('GET /api/offices (no read-office-settings)',             await apiRequest('GET',    '/api/offices', cookie),                   403);
  assert('GET /api/consultation-context (no create-consultation)', await apiRequest('GET',    '/api/consultation-context', cookie),      403);
  assert('DELETE /api/offices/1 (no delete-office)',               await apiRequest('DELETE', '/api/offices/1', cookie),                 403);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  await assertPortFree(3000);

  const server = spawn('node', ['server/index.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd()
  });

  let ready = false;
  let readyResolve, readyReject;
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
    if (!ready) readyReject(new Error(`api exited before ready (code=${code ?? 'null'})`));
  });

  const timeout = setTimeout(() => {
    if (!ready) readyReject(new Error('api startup timeout'));
  }, 30000);

  try {
    await readyPromise;
    clearTimeout(timeout);

    await ensureSetupIfNeeded();

    const adminCookie = await login('admin', 'admin');

    // Create test users (idempotent: may already exist from a previous run)
    const testUsers = [
      { username: 'e2e-cabinet-member', password: 'test-e2e-1', profileId: 'cabinet-member' },
      { username: 'e2e-assistant',      password: 'test-e2e-2', profileId: 'assistant' },
      { username: 'e2e-comptabilite',   password: 'test-e2e-3', profileId: 'comptabilite' }
    ];

    for (const u of testUsers) {
      try {
        await createTestUser(adminCookie, u);
        console.log(`[Setup] Created test user "${u.username}"`);
      } catch (err) {
        if (String(err.message).includes('409') || String(err.message).includes('existe deja')) {
          console.log(`[Setup] Test user "${u.username}" already exists — skipping`);
        } else {
          throw err;
        }
      }
    }

    const cabinetMemberCookie  = await login('e2e-cabinet-member', 'test-e2e-1');
    const assistantCookie      = await login('e2e-assistant',      'test-e2e-2');
    const comptabiliteCookie   = await login('e2e-comptabilite',   'test-e2e-3');


    await testUnauthenticated();
    await testAdminFullAccess(adminCookie);
    await testCabinetMemberNoRights(cabinetMemberCookie);
    await testAssistantPartialAccess(assistantCookie);
    await testComptabiliteAccess(comptabiliteCookie);

    console.log('\n─────────────────────────────────────────');
    console.log(`[E2E] Access rights — ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
      console.log('\nFailures:');
      failures.forEach((f) => console.log(f));
    }
    console.log('─────────────────────────────────────────');

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    server.kill();
  }
}

run().catch((err) => {
  console.error('[E2E] Fatal error:', err.message);
  process.exit(1);
});
