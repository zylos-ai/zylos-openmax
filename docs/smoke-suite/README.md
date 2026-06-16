# Smoke Suite

Quick sanity check after each deployment. Covers the critical happy path only.

## Selected Cases (5)

| # | Name | What it validates |
|---|------|-------------------|
| 0 | project-create | Auth, login, project CRUD, archive |
| 1 | light-single-agent | Light Issue full lifecycle (NL instruction -> completion -> acceptance) |
| 4 | simple-task-conversation | Task creation and 5-card UI flow in Agent DM |
| 5 | kb-tree-and-files | KB folder/page create, search, rename, move |
| 14 | comm-sync-search | Offline message sync, conversation list, KB search |

## When to Run

- After every deployment
- After every PR merge to main
- Expected duration: a few minutes

## How to Run

```bash
# Run all smoke tests
node --test docs/smoke-suite/smoke-*.test.js

# Run a single test
node --test docs/smoke-suite/smoke-0-project-create.test.js
```
