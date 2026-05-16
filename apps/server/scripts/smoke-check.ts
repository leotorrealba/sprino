// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * SLO smoke-check script.
 *
 * Runs a set of HTTP checks against a live Sprino server and asserts
 * latency + correctness SLOs. Designed to be run in CI (post-deploy),
 * locally against a running docker-compose stack, or inside the Docker
 * smoke test harness.
 *
 * Usage:
 *   SERVER_URL=http://localhost:3001 BEARER_TOKEN=<token> \
 *     bun run apps/server/scripts/smoke-check.ts
 *
 * Defaults:
 *   SERVER_URL   — http://localhost:3001 (if unset)
 *   BEARER_TOKEN — (if unset, authenticated checks are skipped with a warning)
 *
 * Exit codes:
 *   0  all checks passed
 *   1  one or more checks failed
 */

// Top-level await requires this file to be a module.
export {};

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3001';
const BEARER_TOKEN = process.env.BEARER_TOKEN ?? '';

let allPassed = true;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  passed: boolean;
  statusCode: number | null;
  durationMs: number;
  reason?: string;
}

async function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; durationMs: number }> {
  const start = Date.now();
  const res = await fetch(url, { headers });
  const durationMs = Date.now() - start;
  let body: unknown;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }
  return { status: res.status, body, durationMs };
}

function pass(name: string, statusCode: number, durationMs: number): CheckResult {
  return { name, passed: true, statusCode, durationMs };
}

function fail(
  name: string,
  statusCode: number | null,
  durationMs: number,
  reason: string,
): CheckResult {
  return { name, passed: false, statusCode, durationMs, reason };
}

function printResult(r: CheckResult): void {
  if (r.passed) {
    console.log(`  ✓ ${r.name} ${r.statusCode} (${r.durationMs}ms)`);
  } else {
    const code = r.statusCode !== null ? String(r.statusCode) : 'ERR';
    console.log(`  ✗ ${r.name} ${code} — ${r.reason}`);
  }
}

function record(r: CheckResult): void {
  printResult(r);
  if (!r.passed) allPassed = false;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkHealthz(): Promise<void> {
  console.log('\nHealthz checks:');
  const SLO_MS = 500;
  let status: number | null = null;
  let durationMs = 0;

  try {
    const result = await httpGet(`${SERVER_URL}/healthz`);
    status = result.status;
    durationMs = result.durationMs;
    const body = result.body as Record<string, unknown>;

    // 1. Status 200
    if (status !== 200) {
      record(fail('healthz 200', status, durationMs, `expected 200, got ${status}`));
      return;
    }
    record(pass('healthz 200', status, durationMs));

    // 2. ok: true
    if (body.ok !== true) {
      record(fail('healthz ok:true', status, durationMs, `body.ok is ${String(body.ok)}, expected true`));
    } else {
      record(pass('healthz ok:true', status, durationMs));
    }

    // 3. version field
    if (typeof body.version !== 'string' || body.version.length === 0) {
      record(fail('healthz version field', status, durationMs, `missing or empty version field`));
    } else {
      record(pass(`healthz version:${body.version}`, status, durationMs));
    }

    // 4. protocol field
    if (typeof body.protocol !== 'string' || body.protocol.length === 0) {
      record(fail('healthz protocol field', status, durationMs, `missing or empty protocol field`));
    } else {
      record(pass(`healthz protocol:${body.protocol}`, status, durationMs));
    }

    // 5. SLO latency
    if (durationMs >= SLO_MS) {
      record(
        fail(
          `healthz latency <${SLO_MS}ms`,
          status,
          durationMs,
          `${durationMs}ms exceeds SLO of ${SLO_MS}ms`,
        ),
      );
    } else {
      record(pass(`healthz latency <${SLO_MS}ms`, status, durationMs));
    }
  } catch (err) {
    record(
      fail(
        'healthz reachable',
        null,
        durationMs,
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

async function checkProjectsList(): Promise<void> {
  console.log('\nAuthenticated checks:');

  if (!BEARER_TOKEN) {
    console.log('  ⚠ BEARER_TOKEN not set — skipping authenticated checks');
    return;
  }

  const SLO_MS = 1000;
  let status: number | null = null;
  let durationMs = 0;

  try {
    const result = await httpGet(`${SERVER_URL}/api/projects`, {
      Authorization: `Bearer ${BEARER_TOKEN}`,
    });
    status = result.status;
    durationMs = result.durationMs;

    // 1. Status 200
    if (status !== 200) {
      record(
        fail(
          'GET /api/projects 200',
          status,
          durationMs,
          `expected 200, got ${status}`,
        ),
      );
    } else {
      record(pass('GET /api/projects 200', status, durationMs));
    }

    // 2. SLO latency
    if (durationMs >= SLO_MS) {
      record(
        fail(
          `GET /api/projects latency <${SLO_MS}ms`,
          status,
          durationMs,
          `${durationMs}ms exceeds SLO of ${SLO_MS}ms`,
        ),
      );
    } else {
      record(pass(`GET /api/projects latency <${SLO_MS}ms`, status, durationMs));
    }
  } catch (err) {
    record(
      fail(
        'GET /api/projects reachable',
        null,
        durationMs,
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`Sprino smoke-check — target: ${SERVER_URL}`);

await checkHealthz();
await checkProjectsList();

console.log('');
if (allPassed) {
  console.log('All checks passed.');
  process.exit(0);
} else {
  console.log('One or more checks FAILED.');
  process.exit(1);
}
