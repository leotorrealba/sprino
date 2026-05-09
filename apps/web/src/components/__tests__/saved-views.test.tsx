// apps/web/src/components/__tests__/saved-views.test.tsx
// Frontend tests deferred per CLAUDE.md: "No frontend tests in v1."
// Server-side query_language.test.ts covers the business logic end-to-end.
import { describe, it } from 'vitest';

describe('TaskSearchBar (stub — see query_language.test.ts for coverage)', () => {
  it.todo('renders title input and status pills');
  it.todo('calls onFiltersChange when title input changes');
  it.todo('renders saved view names from API response');
  it.todo('calls POST endpoint when saving current filters');
  it.todo('calls DELETE endpoint when removing a saved view');
});
