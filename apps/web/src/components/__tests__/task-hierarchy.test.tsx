// Frontend tests are deferred per CLAUDE.md: "No frontend tests in v1.
// Frontend is a thin viewer; correctness is enforced at the protocol layer."
// The server-side task_hierarchy.test.ts covers the business logic end-to-end.
import { describe, it } from 'vitest';

describe('TaskHierarchy (stub — see task_hierarchy.test.ts for coverage)', () => {
  it.todo('renders nothing when task has no children and no blockers');
  it.todo('renders collapsed subtask badge when children exist');
  it.todo('expands to show progress bar and subtask list on click');
  it.todo('renders blocker badge when blocked_by is non-empty');
});
