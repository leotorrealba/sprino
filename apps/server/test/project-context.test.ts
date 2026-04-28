// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProjectContext } from '../scripts/project-context.ts';

const PROJECT_ID = '018c3e7a-0002-7000-8000-000000000099';

describe('MCP stdio project context detection', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'sprino-project-context-'));
    tmpRoots.push(root);
    return root;
  }

  it('reads .sprino/project.id from the nearest repository root', () => {
    const root = makeRoot();
    const sprinoDir = path.join(root, '.sprino');
    const nested = path.join(root, 'apps', 'server');
    mkdirSync(sprinoDir);
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(sprinoDir, 'project.id'), `${PROJECT_ID}\n`);

    expect(detectProjectContext({ cwd: nested })).toEqual({
      project_id: PROJECT_ID,
      repo_path: root,
    });
  });

  it('maps git top-level paths through the configured repo map', () => {
    const root = makeRoot();
    const nested = path.join(root, 'packages', 'protocol-types');
    mkdirSync(nested, { recursive: true });

    expect(
      detectProjectContext({
        cwd: nested,
        repoProjectMap: { [root]: PROJECT_ID },
        gitRootResolver: () => root,
      }),
    ).toEqual({ project_id: PROJECT_ID, repo_path: root });
  });

  it('passes repo_path through when no project id can be inferred locally', () => {
    const root = makeRoot();

    expect(
      detectProjectContext({
        cwd: root,
        repoProjectMap: {},
        gitRootResolver: () => root,
      }),
    ).toEqual({ repo_path: root });
  });
});
