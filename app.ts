// app.ts — the forge's HTTP server.
//
// Routes:
//   GET  /healthz                         liveness probe
//   /api/v3/*                             GitHub REST API v3 (auth required)
//   POST /api/graphql                     GitHub GraphQL API v4 (auth required)
//   POST /mcp                             Model Context Protocol (auth required)
//   /:owner/:repo.git/info/refs           smart-HTTP advertisements (v0 + v2)
//   POST /:owner/:repo.git/git-upload-pack
//   POST /:owner/:repo.git/git-receive-pack
//
// Every response from /api/v3 carries X-GitHub-Request-Id. All state lives in
// the Forge in memory; timestamps come from a logical clock, so two runs with
// the same request order export identical state.

import http from 'node:http';
import { Forge, IssueStore, issueToJson, pullToJson, repoToJson } from './store.ts';
import type { Repo } from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLinesText,
  readPack,
  selectFetchObjects,
  writePack,
  isAncestor,
  hashObject,
} from './git.ts';
import type { GitObject } from './git.ts';

const MAX_BODY = 256 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(res: http.ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, ...extraHeaders });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The token the checks use is the environment's shop token. */
function tokenIsValid(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  const token = (match[1] as string).trim();
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return token === expected;
  return token.startsWith('shpat_');
}

/** Same-origin absolute URL for pagination Link headers. */
function absoluteUrl(req: http.IncomingMessage, path: string): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}${path}`;
}

function paginate<T>(req: http.IncomingMessage, items: T[], url: URL): { page: T[]; link: string | null } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const pageNumber = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(pageNumber + 1));
    next.searchParams.set('per_page', String(perPage));
    const lastPage = Math.max(1, Math.ceil(items.length / perPage));
    const last = new URL(url.toString());
    last.searchParams.set('page', String(lastPage));
    last.searchParams.set('per_page', String(perPage));
    link = `<${absoluteUrl(req, next.pathname + next.search)}>; rel="next", <${absoluteUrl(req, last.pathname + last.search)}>; rel="last"`;
  }
  return { page, link };
}

interface Ctx {
  forge: Forge;
  issues: IssueStore;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  segments: string[];
}

function notFound(res: http.ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

/** A repo is only visible when the owner is the viewer and the repo exists. */
function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== ctx.forge.viewerLogin) return null;
  return ctx.forge.getRepo(owner, name) ?? null;
}

function userJson(forge: Forge, login: string): Record<string, unknown> {
  if (login === forge.viewerLogin) {
    return { login: forge.viewerLogin, id: 1000, name: forge.viewerName, email: forge.viewerEmail, type: 'User' };
  }
  return { login, id: 1001, name: login, type: 'User' };
}

export function createApp(forge: Forge, issues: IssueStore): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(forge, issues, req, res).catch((err: unknown) => {
      // A malformed request must never kill the server.
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      } else {
        try {
          res.end();
        } catch {
          // Ignore.
        }
      }
    });
  });
  return server;
}

async function handleRequest(forge: Forge, issues: IssueStore, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const ctx: Ctx = { forge, issues, req, res, url, segments };

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!tokenIsValid(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    await handleRest(ctx);
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'graphql') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!tokenIsValid(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    await handleGraphql(ctx);
    return;
  }

  if (segments[0] === 'mcp') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!tokenIsValid(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    await handleMcpEndpoint(ctx);
    return;
  }

  if (segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git')) {
    await handleGit(ctx);
    return;
  }

  notFound(res);
}

// -------------------------------------------------------------------------------------------
// REST API v3
// -------------------------------------------------------------------------------------------

async function handleRest(ctx: Ctx): Promise<void> {
  const { req, res, url, segments } = ctx;
  const rest = segments.slice(2); // after /api/v3
  const method = req.method ?? 'GET';

  // GET /api/v3/
  if (rest.length === 0 && method === 'GET') {
    sendJson(
      res,
      200,
      {
        current_user_url: absoluteUrl(req, '/api/v3/user'),
        repository_url: absoluteUrl(req, '/api/v3/repos/{owner}/{repo}'),
        meta: absoluteUrl(req, '/api/v3/meta'),
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      github_services_sha: '0000000000000000000000000000000000000000',
    });
    return;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, userJson(ctx.forge, ctx.forge.viewerLogin));
    return;
  }

  // GET /api/v3/users/{login}
  if (rest.length === 2 && rest[0] === 'users' && method === 'GET') {
    sendJson(res, 200, userJson(ctx.forge, rest[1] as string));
    return;
  }

  // POST /api/v3/user/repos  |  GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { message: parsed.message });
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'Repository name is required' });
        return;
      }
      const repo = ctx.forge.createRepo(
        ctx.forge.viewerLogin,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      if (repo === null) {
        sendJson(res, 422, { message: `Repository "${name}" already exists`, errors: [{ message: 'name already exists on this account' }] });
        return;
      }
      sendJson(res, 201, repoToJson(repo));
      return;
    }
    if (method === 'GET') {
      const { page, link } = paginate(req, ctx.forge.listViewerRepos().map(repoToJson), url);
      sendJson(res, 200, page, link !== null ? { link } : {});
      return;
    }
  }

  // /api/v3/repos/{owner}/{repo}[/*]
  if (rest.length >= 3 && rest[0] === 'repos') {
    await handleRepoRest(ctx, rest.slice(1));
    return;
  }

  notFound(res);
}

async function handleRepoRest(ctx: Ctx, parts: string[]): Promise<void> {
  const { req, res, url } = ctx;
  const method = req.method ?? 'GET';
  const owner = parts[0] as string;
  const name = parts[1] as string;
  const repo = resolveRepo(ctx, owner, name);
  if (repo === null) {
    notFound(res);
    return;
  }
  const tail = parts.slice(2);

  // /repos/{owner}/{repo}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoToJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { message: parsed.message });
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, 200, repoToJson(repo));
      return;
    }
    if (method === 'DELETE') {
      ctx.forge.deleteRepo(owner, name);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  // /repos/{owner}/{repo}/branches
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '' } }));
      sendJson(res, 200, branches);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const branch = tail[1] as string;
      const sha = ctx.forge.branchTip(repo, branch);
      if (sha === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    notFound(res);
    return;
  }

  // /repos/{owner}/{repo}/commits
  if (tail[0] === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const ref = url.searchParams.get('sha') ?? undefined;
      const commits = ctx.forge.listCommits(repo, ref).map((commit) => ({
        sha: commit.sha,
        commit: {
          // The API presents the message without the commit object's
          // trailing newline.
          message: commit.message.replace(/\n$/, ''),
          author: { name: ctx.forge.viewerName, email: ctx.forge.viewerEmail, date: commit.createdAt },
          committer: { name: ctx.forge.viewerName, email: ctx.forge.viewerEmail, date: commit.createdAt },
        },
        parents: [],
      }));
      const { page, link } = paginate(req, commits, url);
      sendJson(res, 200, page, link !== null ? { link } : {});
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const sha = tail[1] as string;
      const commit = ctx.forge.listCommits(repo).find((candidate) => candidate.sha === sha);
      if (commit === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, {
        sha: commit.sha,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          author: { name: ctx.forge.viewerName, email: ctx.forge.viewerEmail, date: commit.createdAt },
          committer: { name: ctx.forge.viewerName, email: ctx.forge.viewerEmail, date: commit.createdAt },
        },
        parents: [],
      });
      return;
    }
    notFound(res);
    return;
  }

  // /repos/{owner}/{repo}/git/refs[/...]
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { message: parsed.message });
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha)) {
        sendJson(res, 422, { message: 'Invalid ref or sha' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      const commitSha = ctx.forge.resolveCommit(repo, sha);
      if (commitSha === undefined) {
        sendJson(res, 422, { message: 'Object does not exist' });
        return;
      }
      repo.refs.set(ref, commitSha);
      sendJson(res, 201, { ref, object: { sha: commitSha, type: 'commit' } });
      return;
    }
    if (method === 'GET') {
      const refPath = tail.slice(2).join('/');
      if (refPath === '') {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        sendJson(res, 200, refs);
        return;
      }
      const fullRef = `refs/${refPath}`;
      const sha = repo.refs.get(fullRef);
      if (sha === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref: fullRef, object: { sha, type: 'commit' } });
      return;
    }
    notFound(res);
    return;
  }

  if (tail[0] === 'contents') {
    await handleContents(ctx, repo, tail.slice(1));
    return;
  }
  if (tail[0] === 'labels') {
    await handleLabels(ctx, repo, tail.slice(1));
    return;
  }
  if (tail[0] === 'issues') {
    await handleIssues(ctx, repo, tail.slice(1));
    return;
  }
  if (tail[0] === 'pulls') {
    await handlePulls(ctx, repo, tail.slice(1));
    return;
  }

  notFound(res);
}

// -------------------------------------------------------------------------------------------
// contents / labels / issues / pulls
// -------------------------------------------------------------------------------------------

const DEFAULT_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'duplicate', color: 'cfd3d7', description: 'This issue or pull request already exists' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'invalid', color: 'e4e669', description: 'This doesn\'t seem right' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];

function ensureDefaultLabels(repo: Repo): void {
  if (repo.labels.size === 0) {
    for (const label of DEFAULT_LABELS) {
      repo.labels.set(label.name, { ...label, id: repo.dbId * 100 + repo.labels.size + 1 });
    }
  }
}

async function handleContents(ctx: Ctx, repo: Repo, parts: string[]): Promise<void> {
  const { req, res, url } = ctx;
  const method = req.method ?? 'GET';
  const path = parts.join('/');
  const ref = url.searchParams.get('ref') ?? undefined;

  if (method === 'GET') {
    const file = ctx.forge.readFile(repo, path, ref);
    if (file !== null) {
      const name = path.split('/').pop() as string;
      sendJson(res, 200, {
        type: 'file',
        name,
        path,
        sha: file.blobSha,
        size: file.size,
        content: file.content.toString('base64'),
        encoding: 'base64',
      });
      return;
    }
    const dir = ctx.forge.readDir(repo, path, ref);
    if (dir !== null) {
      sendJson(
        res,
        200,
        dir.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha, size: 0 })),
      );
      return;
    }
    notFound(res);
    return;
  }

  if (method === 'PUT') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { message: parsed.message });
      return;
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentBase64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const existing = ctx.forge.readFile(repo, path, branch);
    let content: Buffer;
    try {
      content = Buffer.from(contentBase64, 'base64');
    } catch {
      sendJson(res, 422, { message: 'content is not valid base64' });
      return;
    }
    if (existing === null) {
      if (sha !== undefined) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return;
      }
      const created = ctx.forge.commitFile(repo, branch, path, content, message);
      sendJson(res, 201, {
        content: { type: 'file', name: path.split('/').pop() as string, path, sha: created.blobSha, size: content.length, encoding: 'base64' },
        commit: { sha: created.commitSha, message },
      });
      return;
    }
    const result = ctx.forge.commitFile(repo, branch, path, content, message, { expectedBlobSha: sha });
    if (result.error === 'stale-sha') {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return;
    }
    if (result.error !== undefined) {
      sendJson(res, 422, { message: result.error });
      return;
    }
    sendJson(res, 200, {
      content: { type: 'file', name: path.split('/').pop() as string, path, sha: result.blobSha, size: content.length, encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { message: parsed.message });
      return;
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const existing = ctx.forge.readFile(repo, path, branch);
    if (existing === null) {
      notFound(res);
      return;
    }
    if (sha !== undefined && sha.toLowerCase() !== existing.blobSha.toLowerCase()) {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return;
    }
    const result = ctx.forge.commitFile(repo, branch, path, Buffer.alloc(0), message, { delete: true });
    if (result.error !== undefined) {
      sendJson(res, 422, { message: result.error });
      return;
    }
    sendJson(res, 200, { commit: { sha: result.commitSha, message } });
    return;
  }

  notFound(res);
}

async function handleLabels(ctx: Ctx, repo: Repo, parts: string[]): Promise<void> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  ensureDefaultLabels(repo);

  if (parts.length === 0 && method === 'GET') {
    sendJson(res, 200, [...repo.labels.values()]);
    return;
  }
  if (parts.length === 0 && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { message: parsed.message });
      return;
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      sendJson(res, 422, { message: 'Label name is required' });
      return;
    }
    const existing = repo.labels.get(name);
    if (existing !== undefined) {
      sendJson(res, 201, existing);
      return;
    }
    const label = {
      id: repo.dbId * 100 + repo.labels.size + 1,
      name,
      color: typeof body.color === 'string' ? body.color : 'ededed',
      description: typeof body.description === 'string' ? body.description : '',
    };
    repo.labels.set(name, label);
    sendJson(res, 201, label);
    return;
  }
  if (parts.length === 1 && method === 'GET') {
    const label = repo.labels.get(parts[0] as string);
    if (label === undefined) {
      notFound(res);
      return;
    }
    sendJson(res, 200, label);
    return;
  }
  notFound(res);
}

async function handleIssues(ctx: Ctx, repo: Repo, parts: string[]): Promise<void> {
  const { req, res, url } = ctx;
  const method = req.method ?? 'GET';
  ensureDefaultLabels(repo);

  if (parts.length === 0) {
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { message: parsed.message });
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const title = typeof body.title === 'string' ? body.title : '';
      const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendJson(res, 422, { message: `Label "${label}" does not exist`, errors: [{ message: `Label "${label}" does not exist` }] });
          return;
        }
      }
      const created = ctx.issues.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      if ('error' in created) {
        sendJson(res, 422, { message: created.error });
        return;
      }
      sendJson(res, 201, issueToJson(created.issue, repo));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number))
        .map((issue) => issueToJson(issue, repo));
      const { page, link } = paginate(req, list, url);
      sendJson(res, 200, page, link !== null ? { link } : {});
      return;
    }
  }

  const number = Number(parts[0]);
  if (!Number.isInteger(number) || number <= 0) {
    notFound(res);
    return;
  }
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(res);
    return;
  }

  if (parts.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueToJson(issue, repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { message: parsed.message });
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      issue.updatedAt = ctx.forge.nowIso();
      sendJson(res, 200, issueToJson(issue, repo));
      return;
    }
    notFound(res);
    return;
  }

  if (parts.length === 2 && parts[1] === 'comments') {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: repo.owner },
          created_at: comment.createdAt,
        })),
      );
      return;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { message: parsed.message });
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const commentId = repo.nextCommentId;
      repo.nextCommentId += 1;
      const comment = { id: commentId, body: commentBody, seq: commentId, createdAt: ctx.forge.nowIso() };
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: repo.owner }, created_at: comment.createdAt });
      return;
    }
  }

  notFound(res);
}

async function handlePulls(ctx: Ctx, repo: Repo, parts: string[]): Promise<void> {
  const { req, res, url } = ctx;
  const method = req.method ?? 'GET';

  if (parts.length === 0) {
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { message: parsed.message });
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const created = ctx.issues.createPull(
        repo,
        typeof body.title === 'string' ? body.title : '',
        typeof body.body === 'string' ? body.body : '',
        typeof body.head === 'string' ? body.head : '',
        typeof body.base === 'string' ? body.base : '',
      );
      if ('error' in created) {
        sendJson(res, 422, { message: created.error });
        return;
      }
      sendJson(res, 201, pullToJson(created.pull, repo));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const list = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number))
        .map((pull) => pullToJson(pull, repo));
      const { page, link } = paginate(req, list, url);
      sendJson(res, 200, page, link !== null ? { link } : {});
      return;
    }
  }

  const number = Number(parts[0]);
  if (!Number.isInteger(number) || number <= 0) {
    notFound(res);
    return;
  }
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(res);
    return;
  }

  if (parts.length === 1 && method === 'GET') {
    const json = pullToJson(pull, repo);
    json.mergeable = ctx.issues.mergeable(repo, pull) === 'MERGEABLE';
    sendJson(res, 200, json);
    return;
  }

  if (parts.length === 2 && parts[1] === 'files' && method === 'GET') {
    const files = ctx.forge.diffFiles(repo, pull.baseSha, pull.headSha);
    sendJson(res, 200, files);
    return;
  }

  if (parts.length === 2 && parts[1] === 'merge' && method === 'PUT') {
    const merged = ctx.issues.mergePull(repo, pull);
    if ('error' in merged) {
      sendJson(res, merged.status, { message: merged.error, merged: false });
      return;
    }
    sendJson(res, 200, { sha: merged.sha, merged: true, message: merged.message });
    return;
  }

  notFound(res);
}

// -------------------------------------------------------------------------------------------
// GraphQL + MCP endpoints
// -------------------------------------------------------------------------------------------

async function handleGraphql(ctx: Ctx): Promise<void> {
  const { req, res } = ctx;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    sendJson(res, parsed.status, { errors: [{ message: parsed.message }] });
    return;
  }
  const body = parsed.value;
  if (Array.isArray(body)) {
    const results = body.map((entry) => runGraphqlOperation(ctx, entry));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, runGraphqlOperation(ctx, body));
}

function runGraphqlOperation(ctx: Ctx, entry: unknown): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'A GraphQL query string is required' }] };
  }
  const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  return executeGraphQL(ctx.forge, ctx.issues, entry.query, variables, operationName);
}

async function handleMcpEndpoint(ctx: Ctx): Promise<void> {
  const { req, res } = ctx;
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    // A body that is not JSON is a parse error (-32700) and must carry an id.
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const answer = handleMcp(ctx.forge, ctx.issues, parsed);
  if (answer.body === null) {
    res.writeHead(answer.status, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, answer.status, answer.body);
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

function sidebandFrame(band: number, payload: Buffer): Buffer {
  return encodePktLine(Buffer.concat([Buffer.from([band]), payload]));
}

function sidebandBuffer(band: number, data: Buffer): Buffer {
  const frames: Buffer[] = [];
  const chunkSize = 65515;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    frames.push(sidebandFrame(band, data.subarray(offset, Math.min(offset + chunkSize, data.length))));
  }
  if (data.length === 0) frames.push(sidebandFrame(band, Buffer.alloc(0)));
  return Buffer.concat(frames);
}

function sortedRefs(repo: Repo): Array<{ ref: string; sha: string }> {
  return [...repo.refs.entries()]
    .map(([ref, sha]) => ({ ref, sha }))
    .sort((a, b) => (a.ref < b.ref ? -1 : 1));
}

function headSha(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

async function handleGit(ctx: Ctx): Promise<void> {
  const { req, res, segments } = ctx;
  const owner = segments[0] as string;
  const name = (segments[1] as string).slice(0, -'.git'.length);
  const repo = resolveRepo(ctx, owner, name);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const tail = segments.slice(2);

  if (req.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = ctx.url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      const useV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = useV2 ? advertisementV2(repo) : advertisementV0(repo, 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main', 'git-upload-pack');
      sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      const body = advertisementV0(repo, 'report-status side-band-64k delete-refs', 'git-receive-pack');
      sendBuffer(res, 200, body, 'application/x-git-receive-pack-advertisement');
      return;
    }
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Dumb HTTP is not supported');
    return;
  }

  if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const useV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (useV2) await handleUploadPackV2(ctx, repo);
    else await handleUploadPackV0(ctx, repo);
    return;
  }

  if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    await handleReceivePack(ctx, repo);
    return;
  }

  notFound(res);
}

function advertisementV0(repo: Repo, capabilities: string, service: string): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(encodePktLine(`# service=${service}\n`));
  chunks.push(pktFlush());
  const head = headSha(repo);
  chunks.push(encodePktLine(`${head} HEAD\0${capabilities}\n`));
  for (const { ref, sha } of sortedRefs(repo)) {
    chunks.push(encodePktLine(`${sha} ${ref}\n`));
    const object = repo.objects.get(sha);
    if (object?.type === 'tag') {
      chunks.push(encodePktLine(`${parseTag(object.data).object} ${ref}^{}\n`));
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function advertisementV2(repo: Repo): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(encodePktLine('# service=git-upload-pack\n'));
  chunks.push(pktFlush());
  chunks.push(encodePktLine('version 2\n'));
  chunks.push(encodePktLine('agent=github-core-clone-forge/1.0.0\n'));
  chunks.push(encodePktLine('ls-refs=unborn\n'));
  chunks.push(encodePktLine('fetch=shallow wait-for-done\n'));
  chunks.push(encodePktLine('server-option\n'));
  chunks.push(encodePktLine('object-format=sha1\n'));
  chunks.push(pktFlush());
  void repo;
  return Buffer.concat(chunks);
}

/** Read pkt-lines from the request body as they arrive. */
async function* pktLineStream(req: http.IncomingMessage): AsyncGenerator<{ kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' }> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of req) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    for (;;) {
      if (buffer.length < 4) break;
      const header = buffer.subarray(0, 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) return;
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        yield { kind: 'flush' };
        buffer = buffer.subarray(4);
        continue;
      }
      if (length === 1) {
        yield { kind: 'delim' };
        buffer = buffer.subarray(4);
        continue;
      }
      if (length === 2) {
        yield { kind: 'response-end' };
        buffer = buffer.subarray(4);
        continue;
      }
      if (length < 4 || buffer.length < length) break;
      yield { kind: 'data', payload: buffer.subarray(4, length) };
      buffer = buffer.subarray(length);
    }
  }
}

function packSideband(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(sidebandFrame(2, Buffer.from('Counting objects: 100%, done.\n', 'utf8')));
  chunks.push(sidebandBuffer(1, pack));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

async function handleUploadPackV0(ctx: Ctx, repo: Repo): Promise<void> {
  const { req, res } = ctx;
  const lookup = ctx.forge.lookup(repo);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let negotiated = false;

  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  for await (const packet of pktLineStream(req)) {
    if (packet.kind !== 'data') {
      if (packet.kind === 'flush' && haves.length > 0 && !negotiated) {
        // Answer one negotiation round: ACK the first common have, else NAK.
        const common = haves.find((have) => wants.some((want) => isAncestor(lookup, have, want)));
        if (common !== undefined) {
          res.write(encodePktLine(`ACK ${common}\n`));
          negotiated = true;
        } else {
          res.write(encodePktLine('NAK\n'));
        }
      }
      continue;
    }
    const line = packet.payload.toString('utf8').trimEnd();
    if (line.startsWith('want ')) {
      wants.push(line.slice(5).split(' ')[0] as string);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      shallowBoundaries.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const parsed = Number(line.slice(7).trim());
      if (Number.isFinite(parsed) && parsed > 0) depth = Math.floor(parsed);
    } else if (line === 'done') {
      break;
    }
  }
  if (wants.length === 0) {
    res.end(pktFlush());
    return;
  }
  const selection = selectFetchObjects(lookup, wants, haves, shallowBoundaries, depth);
  const chunks: Buffer[] = [];
  for (const oid of selection.shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
  const pack = writePack(selection.objects);
  chunks.push(packSideband(pack));
  res.end(Buffer.concat(chunks));
}

async function handleUploadPackV2(ctx: Ctx, repo: Repo): Promise<void> {
  const { req, res } = ctx;
  const lookup = ctx.forge.lookup(repo);
  const body = await readBody(req);
  const packets = decodePktLines(body);
  if (packets === null) {
    res.writeHead(400, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(pktFlush());
    return;
  }
  const lines = pktLinesText(packets).map((line) => line.trimEnd());
  const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length) ?? '';

  if (command === 'ls-refs') {
    const peel = lines.includes('peel');
    const symrefs = lines.includes('symrefs');
    const unborn = lines.includes('unborn');
    const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
    const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
    const chunks: Buffer[] = [];
    const head = headSha(repo);
    const headExists = head !== ZERO_OID;
    if (matches('HEAD')) {
      if (!headExists && unborn) {
        // An unborn HEAD is reported as `unborn HEAD ...`, not as a zero oid.
        let line = 'unborn HEAD';
        if (symrefs) line += ' symref-target:refs/heads/main';
        chunks.push(encodePktLine(`${line}\n`));
      } else {
        let line = `${head} HEAD`;
        if (symrefs) line += ' symref-target:refs/heads/main';
        chunks.push(encodePktLine(`${line}\n`));
      }
    }
    for (const { ref, sha } of sortedRefs(repo)) {
      if (!matches(ref)) continue;
      let line = `${sha} ${ref}`;
      const object = repo.objects.get(sha);
      if (peel && object?.type === 'tag') {
        const target = parseTag(object.data).object;
        line += ` peeled:${target}`;
      }
      chunks.push(encodePktLine(`${line}\n`));
    }
    // An unborn default branch is reported through HEAD only: listing
    // refs/heads/main itself would make the branch look like it exists.
    chunks.push(pktFlush());
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(Buffer.concat(chunks));
    return;
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowBoundaries: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const parsed = Number(line.slice(7).trim());
        if (Number.isFinite(parsed) && parsed > 0) depth = Math.floor(parsed);
      }
    }
    // In stateless (HTTP) mode the server never sends an acknowledgments
    // section: the response is the shallow-info section, when there is one,
    // followed directly by the packfile section. (A real git upload-pack
    // answers a fetch the same way, with or without haves.)
    const chunks: Buffer[] = [];
    const selection = selectFetchObjects(lookup, wants, haves, shallowBoundaries, depth);
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      chunks.push(encodePktLine('shallow-info\n'));
      for (const oid of selection.shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
      chunks.push(pktDelim());
    }
    chunks.push(encodePktLine('packfile\n'));
    const pack = writePack(selection.objects);
    chunks.push(packSideband(pack));
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(Buffer.concat(chunks));
    return;
  }

  res.writeHead(400, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(pktFlush());
}

async function handleReceivePack(ctx: Ctx, repo: Repo): Promise<void> {
  const { req, res } = ctx;
  const body = await readBody(req);

  // The report-status stream is itself pkt-lined inside band 1, including
  // its terminating flush packet; the outer flush ends the response. A
  // client reading the report waits for that inner flush, not EOF.
  const report = (lines: string[]): void => {
    const payload = Buffer.concat([...lines.map((line) => encodePktLine(line)), pktFlush()]);
    const body = Buffer.concat([sidebandBuffer(1, payload), pktFlush()]);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': String(body.length) });
    res.end(body);
  };

  // Split the ref-update commands (pkt-lines) from the raw pack that follows.
  // The pack bytes are not pkt-lines, so the body is walked by hand: commands
  // until the flush packet, then the pack to the end of the body.
  const commands: Array<{ oldSha: string; newSha: string; ref: string }> = [];
  let offset = 0;
  let packStart = body.length;
  while (offset < body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    // The first command line carries the capabilities after a NUL; cut there.
    const clean = (payload.split('\0')[0] as string).trimEnd();
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(clean);
    if (match) {
      commands.push({ oldSha: match[1] as string, newSha: match[2] as string, ref: match[3] as string });
    }
    offset += length;
  }
  const packBytes = body.subarray(packStart);
  let unpacked: Map<string, GitObject>;
  if (packBytes.length === 0 || !packBytes.subarray(0, 4).equals(Buffer.from('PACK'))) {
    // A delete-only push carries no pack at all; nothing to unpack.
    unpacked = new Map();
  } else {
    try {
      unpacked = readPack(packBytes, ctx.forge.lookup(repo));
    } catch (err) {
      report(['unpack failed\n', ...commands.map((command) => `ng ${command.ref} unpack failed\n`)]);
      void err;
      return;
    }
  }
  for (const [oid, object] of unpacked) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }

  const lines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newSha === ZERO_OID) {
      // Delete a ref.
      if (current === undefined) {
        lines.push(`ng ${command.ref} ref does not exist\n`);
      } else if (command.oldSha !== ZERO_OID && command.oldSha !== current) {
        lines.push(`ng ${command.ref} old value mismatch\n`);
      } else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    const target = repo.objects.get(command.newSha);
    if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
      lines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    // A ref stores the object it names, tag object included; only the
    // fast-forward check works on the peeled commit. Peeling here used to
    // store the commit instead, which broke ls-refs peel, tag clones and
    // tag deletes (the stored value never matched the tag oid).
    const peel = (oid: string): string => {
      const object = repo.objects.get(oid);
      return object?.type === 'tag' ? parseTag(object.data).object : oid;
    };
    const newCommit = peel(command.newSha);
    if (current === undefined) {
      if (command.oldSha !== ZERO_OID) {
        lines.push(`ng ${command.ref} old value mismatch\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newSha);
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldSha !== current) {
      lines.push(`ng ${command.ref} old value mismatch\n`);
      continue;
    }
    if (command.newSha === current) {
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    const lookup = ctx.forge.lookup(repo);
    const currentCommit = peel(current);
    if (newCommit !== currentCommit && !isAncestor(lookup, currentCommit, newCommit)) {
      lines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newSha);
    lines.push(`ok ${command.ref}\n`);
  }
  report(lines);
}
