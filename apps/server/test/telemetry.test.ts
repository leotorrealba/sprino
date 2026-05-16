// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Tests for service/telemetry.ts and the /api/metrics endpoint.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRequest,
  recordMcpTool,
  getMetrics,
  resetMetrics,
} from '../src/service/telemetry.ts';
import { buildTestApp } from './setup.ts';
import { FIXTURE_TOKEN } from './setup.ts';

// Reset counters before every test so runs are fully isolated.
// (setup.ts also runs resetDb, but telemetry counters are in-memory module
// state — they don't participate in DB resets.)
beforeEach(() => {
  resetMetrics();
});

describe('recordRequest', () => {
  it('increments requests_total on each call', () => {
    recordRequest('GET', '/api/tasks', 200, 5);
    recordRequest('POST', '/api/tasks', 201, 10);
    expect(getMetrics().requests_total).toBe(2);
  });

  it('buckets status codes correctly into requests_by_status', () => {
    recordRequest('GET', '/api/tasks', 200, 1);
    recordRequest('GET', '/api/tasks/missing', 404, 2);
    recordRequest('POST', '/api/tasks', 500, 3);

    const snap = getMetrics();
    expect(snap.requests_by_status['2xx']).toBe(1);
    expect(snap.requests_by_status['4xx']).toBe(1);
    expect(snap.requests_by_status['5xx']).toBe(1);
  });

  it('increments errors_total only for 5xx responses', () => {
    recordRequest('GET', '/api/ok', 200, 1);
    recordRequest('GET', '/api/missing', 404, 2);
    recordRequest('POST', '/api/broken', 500, 3);
    recordRequest('POST', '/api/broken2', 503, 4);
    expect(getMetrics().errors_total).toBe(2);
  });
});

describe('recordMcpTool', () => {
  it('increments mcp_calls_total for every call', () => {
    recordMcpTool('sprino.task.get', true);
    recordMcpTool('sprino.task.create', true);
    expect(getMetrics().mcp_calls_total).toBe(2);
  });

  it('increments mcp_errors_total only when ok=false', () => {
    recordMcpTool('sprino.task.get', true);
    recordMcpTool('sprino.task.create', false);
    recordMcpTool('sprino.project.get', false);

    const snap = getMetrics();
    expect(snap.mcp_calls_total).toBe(3);
    expect(snap.mcp_errors_total).toBe(2);
  });
});

describe('getMetrics', () => {
  it('returns an accurate snapshot after mixed calls', () => {
    recordRequest('GET', '/api/tasks', 200, 10);
    recordRequest('DELETE', '/api/tasks/x', 404, 5);
    recordRequest('POST', '/api/tasks', 500, 20);
    recordMcpTool('sprino.task.get', true);
    recordMcpTool('sprino.task.get', false);

    const snap = getMetrics();
    expect(snap.requests_total).toBe(3);
    expect(snap.requests_by_status).toEqual({ '2xx': 1, '4xx': 1, '5xx': 1 });
    expect(snap.errors_total).toBe(1);
    expect(snap.mcp_calls_total).toBe(2);
    expect(snap.mcp_errors_total).toBe(1);
  });

  it('returns a copy — mutating the returned object does not affect counters', () => {
    recordRequest('GET', '/api/tasks', 200, 1);
    const snap = getMetrics();
    (snap as unknown as Record<string, unknown>).requests_total = 999;
    expect(getMetrics().requests_total).toBe(1);
  });
});

describe('GET /api/metrics', () => {
  it('returns 200 with the correct TelemetrySnapshot shape', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request('http://localhost/api/metrics', {
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.requests_total).toBe('number');
    expect(typeof body.requests_by_status).toBe('object');
    expect(typeof body.errors_total).toBe('number');
    expect(typeof body.mcp_calls_total).toBe('number');
    expect(typeof body.mcp_errors_total).toBe('number');
  });

  it('is protected — 401 without a Bearer token', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request('http://localhost/api/metrics'),
    );
    expect(res.status).toBe(401);
  });
});
