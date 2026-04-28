// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ProjectContext {
  project_id?: string;
  repo_path?: string;
}

interface DetectOptions {
  cwd?: string;
  repoProjectMap?: Record<string, string>;
  gitRootResolver?: (cwd: string) => string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeRepoPath(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

export function parseRepoProjectMap(
  raw = process.env.SPRINO_REPO_PROJECT_MAP_JSON,
): Record<string, string> {
  if (!raw) return {};

  const parsed = JSON.parse(raw) as unknown;
  const map: Record<string, string> = {};

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.repo_path === 'string' && typeof e.project_id === 'string') {
        map[normalizeRepoPath(e.repo_path)] = e.project_id;
      }
    }
    return map;
  }

  if (parsed && typeof parsed === 'object') {
    for (const [repoPath, projectId] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof projectId === 'string') {
        map[normalizeRepoPath(repoPath)] = projectId;
      }
    }
  }

  return map;
}

function findProjectIdFile(cwd: string): { projectId: string; root: string } | null {
  let current = normalizeRepoPath(cwd);

  for (;;) {
    const candidate = path.join(current, '.sprino', 'project.id');
    if (existsSync(candidate)) {
      const projectId = readFileSync(candidate, 'utf8').trim();
      if (!UUID_RE.test(projectId)) {
        throw new Error(`${candidate} must contain a UUID project id`);
      }
      return { projectId, root: current };
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function defaultGitRootResolver(cwd: string): string | null {
  try {
    const output = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output ? output : null;
  } catch {
    return null;
  }
}

export function detectProjectContext(options: DetectOptions = {}): ProjectContext {
  const cwd = normalizeRepoPath(
    options.cwd ?? process.env.SPRINO_MCP_CWD ?? process.cwd(),
  );

  const fromFile = findProjectIdFile(cwd);
  if (fromFile) {
    return {
      project_id: fromFile.projectId,
      repo_path: fromFile.root,
    };
  }

  const gitRootResolver = options.gitRootResolver ?? defaultGitRootResolver;
  const gitRoot = gitRootResolver(cwd);
  if (!gitRoot) return {};

  const repoPath = normalizeRepoPath(gitRoot);
  const repoProjectMap = options.repoProjectMap ?? parseRepoProjectMap();
  const projectId = repoProjectMap[repoPath];

  return projectId
    ? { project_id: projectId, repo_path: repoPath }
    : { repo_path: repoPath };
}
