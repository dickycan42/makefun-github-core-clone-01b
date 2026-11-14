# github-core-clone-forge

A GitHub-compatible git forge, written from scratch with the Node 22
standard library only. No dependencies, no git binary, no network access.

## Run

```sh
node main.ts
```

The server listens on an ephemeral port the kernel picks, registers that
port with the environment at `$MAKEFUN_ENV_URL/register`, polls
`$MAKEFUN_ENV_URL/done` until the trial ends, and exits 0. Without
`MAKEFUN_ENV_URL` it just listens and logs its port (handy for manual
testing).

## Surface

- `GET /healthz` — liveness probe.
- `GET /api/v3/` and `/api/v3/meta`, `/api/v3/user`, `/api/v3/users/{login}`.
- REST v3: repositories, branches, commits, git refs, file contents,
  labels, issues, comments, pull requests (with files and squash merge).
  Every response carries `X-GitHub-Request-Id`; authentication is a
  `shpat_` bearer token (`MAKEFUN_SHOP_TOKEN` when set).
- `POST /api/graphql` — GraphQL v4: viewer, repository, issues and pull
  requests with cursor pagination, mutations, `node(id:)` and `__type`
  introspection. Batches (an array of operations) are answered in order.
- `POST /mcp` — Model Context Protocol (Streamable HTTP, JSON-RPC 2.0):
  `server/discover` for the 2026-07-28 revision, plus the legacy
  `initialize` handshake, `tools/list` and `tools/call`.
- Smart HTTP git under `/{owner}/{repo}.git`: `info/refs` advertisements
  for `git-upload-pack` (protocol v0 and v2) and `git-receive-pack`,
  `ls-refs` (peel, symrefs, unborn, ref-prefix), `fetch` (haves, shallow,
  deepen, unshallow) and `receive-pack` (report-status, per-ref
  non-fast-forward rejection). Clone, fetch and push work with a real
  `git` client.

## Files

| File | What it holds |
| --- | --- |
| `main.ts` | Entrypoint and the environment lifecycle. |
| `app.ts` | The HTTP server: REST, GraphQL and MCP endpoints, git smart HTTP. |
| `store.ts` | The in-memory forge: repositories, objects, issues, pull requests. |
| `git.ts` | The git object model, pkt-line codec, packfile read/write, fetch selection. |
| `graphql.ts` | A small GraphQL parser and executor. |
| `mcp.ts` | The MCP tools. |
| `scenario.ts` | The scenario's deterministic users (viewer `adaiversen`). |

## Determinism

All data lives in memory and every timestamp comes from a logical clock
(the scenario epoch plus a counter), so two runs that see the same request
order export byte-identical state.
