// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera

export interface TelemetrySnapshot {
  requests_total: number;
  requests_by_status: Record<string, number>; // "2xx", "4xx", "5xx"
  errors_total: number;
  mcp_calls_total: number;
  mcp_errors_total: number;
}

// Module-level counters — reset only via resetMetrics().
let requestsTotal = 0;
const requestsByStatus: Record<string, number> = {};
let errorsTotal = 0;
let mcpCallsTotal = 0;
let mcpErrorsTotal = 0;

export function recordRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
): void {
  requestsTotal += 1;

  const bucket = statusBucket(status);
  requestsByStatus[bucket] = (requestsByStatus[bucket] ?? 0) + 1;

  if (status >= 500) {
    errorsTotal += 1;
  }

  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      method,
      path,
      status,
      duration_ms: durationMs,
    }) + '\n',
  );
}

export function recordMcpTool(_toolName: string, ok: boolean): void {
  mcpCallsTotal += 1;
  if (!ok) {
    mcpErrorsTotal += 1;
  }
}

export function getMetrics(): TelemetrySnapshot {
  return {
    requests_total: requestsTotal,
    requests_by_status: { ...requestsByStatus },
    errors_total: errorsTotal,
    mcp_calls_total: mcpCallsTotal,
    mcp_errors_total: mcpErrorsTotal,
  };
}

export function resetMetrics(): void {
  requestsTotal = 0;
  for (const key of Object.keys(requestsByStatus)) {
    delete requestsByStatus[key];
  }
  errorsTotal = 0;
  mcpCallsTotal = 0;
  mcpErrorsTotal = 0;
}

function statusBucket(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 200) return '2xx';
  return `${Math.floor(status / 100)}xx`;
}
