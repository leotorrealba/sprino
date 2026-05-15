// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react';

type WorkspacePlan = {
  workspace_id: string;
  plan: 'free' | 'pro' | 'enterprise';
  max_projects: number;
  max_members: number;
  audit_export_enabled: boolean;
  updated_at: string;
};

export type BillingUsageProps = {
  workspaceId: string;
  token: string;
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function planLabel(plan: WorkspacePlan['plan']): string {
  switch (plan) {
    case 'free':
      return 'Free';
    case 'pro':
      return 'Pro';
    case 'enterprise':
      return 'Enterprise';
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}

export function BillingUsage({ workspaceId, token }: BillingUsageProps) {
  const [state, setState] = useState<LoadState>('idle');
  const [plan, setPlan] = useState<WorkspacePlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAuth = useCallback(
    (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
          ...(init.headers ?? {}),
        },
      }),
    [token, workspaceId],
  );

  useEffect(() => {
    if (!workspaceId.trim()) {
      setState('error');
      setError('Workspace is not selected.');
      setPlan(null);
      return;
    }

    let cancelled = false;
    setState('loading');
    setError(null);

    void (async () => {
      try {
        const r = await fetchAuth(`/api/workspaces/${encodeURIComponent(workspaceId)}/plan`);
        if (!r.ok) {
          const text = await r.text();
          throw new Error(text || `Request failed: ${r.status}`);
        }
        const j = (await r.json()) as WorkspacePlan;
        if (!cancelled) {
          setPlan(j);
          setState('ready');
        }
      } catch (e) {
        if (!cancelled) {
          setPlan(null);
          setState('error');
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, fetchAuth]);

  if (state === 'loading' || state === 'idle') {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-500">Loading plan…</p>
      </div>
    );
  }

  if (state === 'error' || !plan) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-rose-900">Billing & usage</h2>
        <p className="mt-2 text-sm text-rose-800">{error ?? 'Unable to load plan.'}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-800">Billing & usage</h2>
      <p className="mt-1 text-xs text-slate-500">
        Workspace plan and limits for this workspace.
      </p>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Plan
          </dt>
          <dd className="mt-1 font-medium text-slate-900">{planLabel(plan.plan)}</dd>
        </div>
        <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Max projects
          </dt>
          <dd className="mt-1 font-medium text-slate-900">{plan.max_projects}</dd>
        </div>
        <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Max members
          </dt>
          <dd className="mt-1 font-medium text-slate-900">{plan.max_members}</dd>
        </div>
        <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Audit export
          </dt>
          <dd className="mt-1 font-medium text-slate-900">
            {plan.audit_export_enabled ? 'Enabled' : 'Disabled'}
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-[11px] text-slate-400">
        Last updated: {new Date(plan.updated_at).toLocaleString()}
      </p>
    </div>
  );
}
