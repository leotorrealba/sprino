# Edge Case Analysis & Hardening Plan

After conducting a deep architectural review of the Sprino service layer (focusing on `tasks.ts`, `sprints.ts`, and schema invariants), I've identified four critical edge cases where business constraints can be bypassed or result in unexpected states. 

Here is the proposed plan to make the system rock-solid.

## User Review Required
Please review the identified edge cases below and let me know if you would like me to fix all of them, or if any of the current behaviors are actually intended by design.

## Edge Cases Identified

### 1. Task Status Guard Bypass via Workflow Transitions
**The Flaw**: `updateTaskStatus` correctly prevents tasks from being marked `doing` or `done` if they have unresolved dependencies (`DependencyNotResolvedError`) or unfinished children (`ChildrenNotDoneError`). However, `transitionTaskWorkflow` (used when dragging tasks on a board) implicitly updates the task status to `targetCol.mapsToStatus` but **completely omits these checks**. A user can drag a task to the "Done" column and bypass the dependency and hierarchy constraints entirely.
**Proposed Fix**:
- Extract the dependency and child-state validation logic from `updateTaskStatus` into a shared validation function.
- Invoke this shared validation inside `transitionTaskWorkflow` whenever the target column changes the task's mapped status.

### 2. Hierarchy Depth Constraint Can Be Circumvented
**The Flaw**: Sprino enforces a maximum task hierarchy depth of 3 levels via `HierarchyDepthExceededError` in `setParent`. It does this by counting the ancestors of the new parent. However, it completely ignores the **descendants** of the task being moved. If Task A has children (depth 2) and Task B has children (depth 2), making A a child of B results in a depth of 4, successfully bypassing the constraint.
**Proposed Fix**:
- Implement a `walkDescendants` helper to calculate the max depth of the sub-tree rooted at the task being moved.
- In `setParent`, ensure `ancestors.length + maxDescendantDepth < max_allowed_depth`.

### 3. Stale 'Blocked' Status on Dependency Removal
**The Flaw**: When a dependency is added via `addDependency`, the system automatically changes a `todo` or `doing` task's status to `blocked`. However, when a dependency is removed via `removeDependency`, there is no symmetric logic to unblock the task. It remains permanently `blocked` even if it has 0 remaining dependencies, requiring manual user intervention to fix.
**Proposed Fix**:
- Update `removeDependency` so that if the `fromTask` is currently `blocked`, it queries for any remaining unresolved dependencies. If none exist, automatically revert the task's status back to `todo` and emit a `status_changed` event.

### 4. Phantom Multi-Sprint Assignment
**The Flaw**: The invariant states a task can only belong to one active sprint. `assignToSprint` correctly prevents assignment if the task is in an *active* sprint. However, because `sprint_tasks` has no unique constraint on `task_id`, and the active check ignores *planning* sprints, a user can simultaneously assign a single task to Sprint A (planning) and Sprint B (planning). 
**Proposed Fix**:
- Update `assignToSprint` to block assignment if the task is already associated with *any* non-completed sprint (whether active or planning), rather than just checking for active sprints.

---

## Proposed Changes

### [tasks.ts]
#### [MODIFY] [tasks.ts](file:///Users/leotorrealba/Development/Sprino/apps/server/src/service/tasks.ts)
- Abstract status guards (`DependencyNotResolvedError`, `ChildrenNotDoneError`) into a `validateStatusTransition` helper.
- Update `transitionTaskWorkflow` to use `validateStatusTransition`.
- Add `walkDescendants` depth calculation to `setParent`.
- Add auto-unblock logic to `removeDependency` to revert `blocked` tasks to `todo` when their last dependency is removed.

### [sprints.ts]
#### [MODIFY] [sprints.ts](file:///Users/leotorrealba/Development/Sprino/apps/server/src/service/sprints.ts)
- Update `assignToSprint` to check for associations with any sprint where `status != 'completed'`.

## Verification Plan
1. Add unit tests in the vitest suite for all 4 edge cases.
2. Run the `bun run test` suite to ensure no existing behaviors are broken and the new tests pass.
