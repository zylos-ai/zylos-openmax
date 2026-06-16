# Integration Suite

Comprehensive integration tests covering cross-module interactions including project, issue, and task creation.

## Selected Cases (10)

| # | Name | What it validates |
|---|------|-------------------|
| 0 | project-create | Auth, login, project CRUD, archive |
| 1 | light-single-agent | Light Issue full lifecycle via IM |
| 2 | heavy-blueprint-worker | Heavy Issue + Blueprint orchestration (3-step dependency chain) + Worker claim |
| 3 | rejection-rework | Rejection workflow, illegal state transitions, rework cycle |
| 4 | simple-task-conversation | Task creation and conversation flow in Agent DM |
| 5 | kb-tree-and-files | KB folder/page create, search, rename, move |
| 9 | blueprint-edges | Blueprint dynamic modification (set_steps) + Worker claim execution |
| 12 | page-trash-restore | Page lifecycle: revisions, soft delete, restore, permanent delete |
| 15 | identity-and-roles | Identity queries, member/role lookup, org switch |
| 16 | invitations | Invitation create, list, accept, revoke |

## Coverage

- **Project**: create, get, archive (smoke-0)
- **Issue**: light lifecycle (smoke-1), heavy lifecycle (smoke-2), rejection/rework (smoke-3)
- **Task**: simple task (smoke-4), blueprint tasks (smoke-2, smoke-9), worker claim (smoke-2, smoke-9)
- **Knowledge Base**: tree operations (smoke-5), page lifecycle (smoke-12)
- **Identity/Org**: roles (smoke-15), invitations (smoke-16)
- **State Machine**: happy path + rejection + illegal transitions (smoke-3, smoke-9)

## When to Run

- Before version releases
- After major refactors
- Periodic regression (weekly)
- Expected duration: 15-30 minutes

## How to Run

```bash
# Run all integration tests
node --test docs/integration-suite/smoke-*.test.js

# Run a single test
node --test docs/integration-suite/smoke-0-project-create.test.js
```
