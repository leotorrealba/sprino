/**
 * MUST be the first vitest setupFile. Pure env mutation, no imports — that
 * way ES-module hoisting can't reorder it after a transitive import of
 * db/client.ts (which reads DATABASE_URL at module-load time).
 */

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error(
    'TEST_DATABASE_URL must be set for tests (it must point at a DB you are willing to TRUNCATE). See test/setup.ts header.',
  );
}
process.env.DATABASE_URL = testUrl;

process.env.SPRINO_ACTORS_JSON = JSON.stringify([
  {
    id: '018c3e7a-0001-7000-8000-000000000001',
    kind: 'human',
    display_name: 'Leonardo',
    token: 'test-leo-token',
    agent_runtime: null,
  },
  {
    id: '018c3e7a-0001-7000-8000-0000000000a1',
    kind: 'agent',
    display_name: 'Test Agent',
    token: 'test-agent-token',
    agent_runtime: 'claude-code',
    parent_actor_id: '018c3e7a-0001-7000-8000-000000000001',
  },
]);
