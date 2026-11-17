[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/chenchendashu/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/chenchendashu/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# GitHub Core Clone

A one-process GitHub-compatible git forge in dependency-free TypeScript for Node ≥ 22 (package engine: ≥ 22.18). It uses erasable syntax and the Node standard library only, with one shared in-memory store across all four surfaces:

- **Git smart HTTP** at `/:owner/:repo.git`: protocols v0 and v2, including `ls-refs`, fetch with shallow/deepen support, and `receive-pack` with `report-status`.
- **REST v3** at `/api/v3`: repositories, contents backed by the real Git object store, labels, issues, and pull requests with real 3-way squash merges that create commits and advance the base branch.
- **GraphQL v4 subset** at `/api/graphql`: `viewer`, `repository`, `issues` and `pullRequests` connections with cursor pagination, `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, and `addComment` mutations, and introspection.
- **MCP** at `/mcp`: `server/discover` and legacy `initialize`, plus six tools over the same store: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, and `merge_pull_request`.

## Run it

In a trial, the harness sets `MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN`, and `MAKEFUN_TRIAL_NOW`, then runs:

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with `MAKEFUN_ENV_URL` via `POST /register`, and serves until the environment returns `done: true` from `GET /done`. `MAKEFUN_SHOP_TOKEN` supplies the bearer token for protected routes; `MAKEFUN_TRIAL_NOW` supplies the starting time for store timestamps. No dependency installation or compilation step is needed.

## Architecture

- `main.ts`: process lifecycle, ephemeral port binding, registration retries, and waiting for the environment to finish.
- `app.ts`: HTTP server, routing, bearer authentication, and error responses.
- `store.ts`: shared in-memory repositories, refs, Git objects, labels, issues, pull requests, identities, and timestamps.
- `git.ts`: Git objects, trees, commits, packfiles, merge-base and 3-way merge logic, and smart HTTP protocols.
- `rest.ts`: REST v3 routes, object-backed contents, and pull request merge operations.
- `graphql.ts`: GraphQL parsing, validation, execution, cursor connections, mutations, and introspection.
- `mcp.ts`: MCP discovery, initialization, tool schemas, and tool calls into the shared store.
