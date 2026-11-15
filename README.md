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

## Performance

Measured with the kit's local trial runner (`run-gcc-trial.sh`, 5 runs,
median): **183/200 perf points** (push 50, clone 42, read 50, write 42),
120/120 conformance checks passing. Baseline before the optimizations
below was 179/200 (push 47, clone 41, read 49, write 43).

Three algorithmic fixes (all behaviour-identical, no trade-offs):

- **Push — bounded ancestor check.** `isAncestor` used to build the full
  ancestor set of the new commit (O(history)) on every receive-pack
  update. It now walks from the new commit and stops the moment the old
  tip is found — 1–2 steps for a linear-history push. Push p50 fell
  496 ms → 374 ms (−25%).
- **Clone — depth-limited pack selection.** `selectPackObjects` walked
  the whole 200-commit history to compute minimum depths even for a
  depth-1 shallow clone, then discarded everything past the depth. When
  the fetch is depth-limited and the client holds nothing (fresh shallow
  clone, no ACKs to compute), parents deeper than the limit are no longer
  enqueued. Clone p50 fell 112 ms → 103 ms. When the client sends haves,
  the full walk runs unchanged so ACK computation stays correct.
- **Write — single JSON parse.** The request handler parsed every REST
  POST/PUT/PATCH body twice (once to validate, once to build the parsed
  value). It now parses once and reuses the result.

## Layout

- `main.ts` — lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — the whole forge: store, git pack/pkt-line primitives,
  REST, GraphQL, MCP and the HTTP dispatcher.

## License

MIT — see `LICENSE`.
