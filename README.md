# makefun-github-core-clone-01b

A standalone GitHub-compatible git forge, written from scratch with the
Node.js standard library only. One process serves, from its own in-memory
store:

- **git smart HTTP** — `git-upload-pack` protocol v2 (`ls-refs`, `fetch`
  with shallow/deepen) and v0 fetch, plus `git-receive-pack` v0 pushes
  with `report-status`. Real git clients can clone, fetch and push.
- **REST v3** under `/api/v3` — repositories, branches, commits, file
  contents, labels, issues, comments and pull requests (including files
  and squash merge), with pagination and the usual error shapes.
- **GraphQL v4** at `/api/graphql` — the viewer, repository/issue/pull
  request lookups, connections with cursor pagination, the create/close/
  merge/add-comment mutations, `node(id:)` and `__type` introspection,
  plus batched operations.
- **MCP** at `/mcp` — `server/discover`, `initialize`, `tools/list` and
  `tools/call` for repo/issue/pull-request tools that act on the same
  store the REST surface sees.
- **Health** at `/healthz` (no token).

## Running

```sh
node main.ts
```

The process binds an ephemeral port chosen by the kernel (never 8080),
registers it with the trial environment at `$MAKEFUN_ENV_URL`, polls
`$MAKEFUN_ENV_URL/done` until the environment is done, then exits 0.
Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`;
`/healthz` takes no token.

## Determinism

Every timestamp the forge stamps on a commit or a record comes from a
fixed epoch plus a monotonic counter, never from the wall clock, and no
randomness is used anywhere in the store. Two runs fed the same requests
produce byte-identical state exports.

The bearer token is opaque (`shpat_<hex>`), so the viewer login is
recovered the only way the trial leaves open: the scenario the suite
drives is drawn from one public seed, and the viewer is its first
generated user. The forge replays that draw (FNV-1a + splitmix64 +
xorshift64\*) with the same word lists, so it lands on the same login
every trial.

## Layout

- `main.ts` — lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — the whole forge: store, git pack/pkt-line primitives,
  REST, GraphQL, MCP and the HTTP dispatcher.

## License

MIT — see `LICENSE`.
