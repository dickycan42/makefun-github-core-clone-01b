// mcp.ts — the Model Context Protocol endpoint (Streamable HTTP, JSON).
//
// Speaks the 2026-07-28 revision: server/discover (no handshake), tools/list
// and tools/call, with the legacy initialize handshake kept for older
// clients. Every tool acts on the same store as REST, so a repository or an
// issue created here reads back over /api/v3 unchanged.

import { Forge, IssueStore, issueToJson, pullToJson, repoToJson } from './store.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
];

function toolJson(def: ToolDef): Record<string, unknown> {
  return {
    name: def.name,
    description: def.description,
    inputSchema: {
      type: 'object',
      properties: def.properties,
      required: def.required,
    },
  };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError,
  };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface McpAnswer {
  status: number;
  body: unknown;
}

/** Handle one decoded JSON-RPC request (or notification) at /mcp. */
export function handleMcp(forge: Forge, issues: IssueStore, request: unknown): McpAnswer {
  if (!isRecord(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id === undefined ? null : request.id;
  const params = isRecord(request.params) ? request.params : {};

  // A notification (no id) is answered with 202 and no body.
  if (request.id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: null };
    }
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS.map(toolJson) }) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (TOOLS.find((tool) => tool.name === name) === undefined) {
      return { status: 200, body: rpcError(id, -32601, `Unknown tool: ${name}`) };
    }
    return { status: 200, body: rpcResult(id, callTool(forge, issues, name, args)) };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

function callTool(forge: Forge, issues: IssueStore, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) {
    return toolResult(`Unknown tool: ${name}`, true);
  }
  const missing = def.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return toolResult(`Missing required argument(s): ${missing.join(', ')}`, true);
  }

  const owner = typeof args.owner === 'string' ? args.owner : forge.viewerLogin;
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';

  if (name === 'create_repo') {
    const repo = forge.createRepo(forge.viewerLogin, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    if (repo === null) return toolResult(`Repository "${repoName}" already exists`, true);
    return toolResult(repoToJson(repo));
  }

  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    if (name === 'get_repo' || name === 'create_issue' || name === 'list_issues' || name === 'create_pull_request' || name === 'merge_pull_request' || name === 'get_issue') {
      return toolResult(`Repository "${owner}/${repoName}" not found`, true);
    }
  }

  if (name === 'get_repo') {
    return toolResult(repoToJson(repo as import('./store.ts').Repo));
  }

  if (name === 'create_issue') {
    const created = issues.createIssue(
      repo as import('./store.ts').Repo,
      String(args.title ?? ''),
      typeof args.body === 'string' ? args.body : '',
      [],
    );
    if ('error' in created) return toolResult(created.error, true);
    return toolResult(issueToJson(created.issue, repo as import('./store.ts').Repo));
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list = [...(repo as import('./store.ts').Repo).issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => b.number - a.number)
      .map((issue) => issueToJson(issue, repo as import('./store.ts').Repo));
    return toolResult(list);
  }

  if (name === 'get_issue') {
    const issue = (repo as import('./store.ts').Repo).issues.get(Number(args.issue_number));
    if (issue === undefined) return toolResult(`Issue #${String(args.issue_number)} not found`, true);
    return toolResult(issueToJson(issue, repo as import('./store.ts').Repo));
  }

  if (name === 'create_pull_request') {
    const created = issues.createPull(
      repo as import('./store.ts').Repo,
      String(args.title ?? ''),
      typeof args.body === 'string' ? args.body : '',
      String(args.head ?? ''),
      String(args.base ?? ''),
    );
    if ('error' in created) return toolResult(created.error, true);
    const json = pullToJson(created.pull, repo as import('./store.ts').Repo);
    return toolResult({ ...json, pull_number: created.pull.number });
  }

  if (name === 'merge_pull_request') {
    const pull = (repo as import('./store.ts').Repo).pulls.get(Number(args.pull_number));
    if (pull === undefined) return toolResult(`Pull request #${String(args.pull_number)} not found`, true);
    const merged = issues.mergePull(repo as import('./store.ts').Repo, pull);
    if ('error' in merged) return toolResult(merged.error, true);
    const json = pullToJson(pull, repo as import('./store.ts').Repo);
    return toolResult({ ...json, sha: merged.sha, merged: true });
  }

  return toolResult(`Unknown tool: ${name}`, true);
}
