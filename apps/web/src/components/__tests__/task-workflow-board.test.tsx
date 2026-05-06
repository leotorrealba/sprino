// Frontend tests are deferred per CLAUDE.md: "No frontend tests in v1.
// Frontend is a thin viewer; correctness is enforced at the protocol layer."
// The server-side task_workflow.test.ts covers the business logic end-to-end.
import { describe, it } from 'vitest';

describe('TaskWorkflowBoard (stub — see task_workflow.test.ts for coverage)', () => {
  it.todo('columns render in position order');
  it.todo('move dropdown shows only allowed targets');
  it.todo('successful transition moves card to new column');
  it.todo('409 triggers onTaskUpdated refresh');
});
