// graphql.ts — a small GraphQL executor for the documents gh and
// github-mcp-server send. It parses one operation document (or a batch of
// them) and resolves it against the forge's store. No library, no schema
// file: the field tables below are the schema the suite probes.

import { Forge, IssueStore } from './store.ts';

// -------------------------------------------------------------------------------------------
// tokenizer + parser (just enough GraphQL for the suite's documents)
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc as string;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    }
    const variables: OperationNode['variables'] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.expectPunct('(');
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const varType = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, type: varType, defaultValue });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseType(): string {
    const token = this.next();
    let base = '';
    if (token.kind === 'punct' && token.value === '[') {
      base = `[${this.parseType()}]`;
    } else if (token.kind === 'name') {
      base = token.value;
    } else {
      throw new Error('expected a type in GraphQL document');
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') {
      this.next();
      base += '!';
    }
    return base;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        this.next(); // a named fragment spread; the suite never defines fragments
        return { kind: 'fragment', typeCondition: null, selections: [] };
      }
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.expectPunct('(');
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

export function parseGraphQL(source: string): OperationNode[] {
  return new Parser(tokenize(source)).parseDocument();
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

export function encodeGlobalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'mergedAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
  SearchType: [],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'];

interface Ctx {
  forge: Forge;
  issues: IssueStore;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
      return node.value;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function responseKey(field: FieldNode): string {
  return field.alias ?? field.name;
}

function stateEnum(state: string, merged: boolean): string {
  if (merged) return 'MERGED';
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(ctx: Ctx, repoDbId: number, issue: { id: number; number: number; title: string; body: string; state: string }): Record<string, unknown> {
  return {
    __typename: 'Issue',
    __id: encodeGlobalId('Issue', `${repoDbId}:${issue.number}`),
    __number: issue.number,
    __title: issue.title,
    __body: issue.body,
    __state: issue.state,
  };
}

function pullNode(ctx: Ctx, repoDbId: number, pull: { id: number; number: number; title: string; body: string; state: string; merged: boolean; headRef: string; baseRef: string }): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    __id: encodeGlobalId('PullRequest', `${repoDbId}:${pull.number}`),
    __number: pull.number,
    __title: pull.title,
    __body: pull.body,
    __state: pull.state,
    __merged: pull.merged,
    __headRef: pull.headRef,
    __baseRef: pull.baseRef,
  };
}

type AnyRecord = Record<string, unknown>;

/** Resolve one object's selection set. `value` carries __typename and __-prefixed fields. */
function executeSelections(ctx: Ctx, value: AnyRecord | null, typeName: string, selections: SelectionNode[], variables: Record<string, unknown>): AnyRecord | null {
  if (value === null) return null;
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const merged = executeSelections(ctx, value, typeName, selection.selections, variables);
      if (merged !== null) Object.assign(out, merged);
      continue;
    }
    const field = selection as FieldNode;
    const key = responseKey(field);
    const resolved = resolveField(ctx, value, typeName, field, variables);
    out[key] = resolved;
  }
  return out;
}

function unknownField(ctx: Ctx, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveField(ctx: Ctx, value: AnyRecord, typeName: string, field: FieldNode, variables: Record<string, unknown>): unknown {
  const name = field.name;
  const args = argsOf(field, variables);
  const forge = ctx.forge;

  if (typeName === 'Query') {
    if (name === 'viewer') {
      return executeSelections(ctx, { __typename: 'User', __login: forge.viewerLogin }, 'User', field.selections, variables);
    }
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      if (owner !== forge.viewerLogin) return null;
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return null;
      return executeSelections(ctx, { __typename: 'Repository', __repo: repo }, 'Repository', field.selections, variables);
    }
    if (name === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.type === 'Repository') {
        const dbId = Number(decoded.key);
        for (const repo of forge.repos.values()) {
          if (repo.dbId === dbId) {
            return executeSelections(ctx, { __typename: 'Repository', __repo: repo }, 'Repository', field.selections, variables);
          }
        }
        return null;
      }
      if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
        const [dbIdText, numberText] = decoded.key.split(':');
        const dbId = Number(dbIdText);
        const number = Number(numberText);
        for (const repo of forge.repos.values()) {
          if (repo.dbId !== dbId) continue;
          if (decoded.type === 'Issue') {
            const issue = repo.issues.get(number);
            if (!issue) return null;
            return executeSelections(ctx, issueNode(ctx, dbId, issue), 'Issue', field.selections, variables);
          }
          const pull = repo.pulls.get(number);
          if (!pull) return null;
          return executeSelections(ctx, pullNode(ctx, dbId, pull), 'PullRequest', field.selections, variables);
        }
        return null;
      }
      return null;
    }
    if (name === '__type') {
      const typeNameArg = String(args.name ?? '');
      const fields = TYPE_FIELDS[typeNameArg];
      const result: AnyRecord = { __typename: '__Type', __name: typeNameArg };
      if (field.selections.length > 0) {
        return executeSelections(ctx, result, '__Type', field.selections, variables);
      }
      return result;
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === '__Type') {
    if (name === 'fields') {
      const list = TYPE_FIELDS[String(value.__name ?? '')] ?? [];
      return list.map((fieldName) => ({ name: fieldName }));
    }
    if (name === 'enumValues') {
      if (value.__name === 'SearchType') return SEARCH_TYPE_VALUES.map((entry) => ({ name: entry }));
      return [];
    }
    if (name === 'name') return value.__name ?? null;
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'User') {
    if (name === 'login') return value.__login ?? forge.viewerLogin;
    if (name === 'id') return encodeGlobalId('User', String(value.__login ?? forge.viewerLogin));
    if (name === 'name') return forge.viewerName;
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'Repository') {
    const repo = value.__repo as import('./store.ts').Repo;
    if (name === 'id') return encodeGlobalId('Repository', String(repo.dbId));
    if (name === 'databaseId') return repo.dbId;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') {
      return executeSelections(ctx, { __typename: 'User', __login: repo.owner }, 'User', field.selections, variables);
    }
    if (name === 'defaultBranchRef') {
      return executeSelections(ctx, { __typename: 'Ref', __name: repo.defaultBranch }, 'Ref', field.selections, variables);
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate') return repo.isPrivate;
    if (name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      if (issue === undefined) return null;
      return executeSelections(ctx, issueNode(ctx, repo.dbId, issue), 'Issue', field.selections, variables);
    }
    if (name === 'issues') {
      return issuesConnection(ctx, repo, args, field, variables);
    }
    if (name === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      if (pull === undefined) return null;
      return executeSelections(ctx, pullNode(ctx, repo.dbId, pull), 'PullRequest', field.selections, variables);
    }
    if (name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : 100;
      const nodes = [...repo.pulls.values()]
        .filter((pull) => pull.state === 'open')
        .sort((a, b) => b.number - a.number)
        .slice(0, first)
        .map((pull) => pullNode(ctx, repo.dbId, pull));
      return executeSelections(ctx, { __typename: 'PullRequestConnection', __nodes: nodes }, 'PullRequestConnection', field.selections, variables);
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'Ref') {
    if (name === 'name') return value.__name ?? null;
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'Issue') {
    if (name === 'id') return value.__id ?? null;
    if (name === 'number') return value.__number ?? null;
    if (name === 'title') return value.__title ?? null;
    if (name === 'body') return value.__body ?? null;
    if (name === 'state') return stateEnum(String(value.__state ?? 'open'), false);
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'PullRequest') {
    if (name === 'id') return value.__id ?? null;
    if (name === 'number') return value.__number ?? null;
    if (name === 'title') return value.__title ?? null;
    if (name === 'body') return value.__body ?? null;
    if (name === 'state') return stateEnum(String(value.__state ?? 'open'), Boolean(value.__merged));
    if (name === 'merged') return Boolean(value.__merged);
    if (name === 'headRefName') return value.__headRef ?? null;
    if (name === 'baseRefName') return value.__baseRef ?? null;
    if (name === 'mergeable') {
      const decoded = decodeGlobalId(String(value.__id ?? ''));
      if (decoded === null) return 'UNKNOWN';
      const [dbIdText, numberText] = decoded.key.split(':');
      for (const repo of forge.repos.values()) {
        if (repo.dbId !== Number(dbIdText)) continue;
        const pull = repo.pulls.get(Number(numberText));
        if (!pull) return 'UNKNOWN';
        return ctx.issues.mergeable(repo, pull);
      }
      return 'UNKNOWN';
    }
    if (name === 'files') {
      const decoded = decodeGlobalId(String(value.__id ?? ''));
      const first = typeof args.first === 'number' ? args.first : 100;
      let paths: string[] = [];
      if (decoded !== null) {
        const [dbIdText, numberText] = decoded.key.split(':');
        for (const repo of forge.repos.values()) {
          if (repo.dbId !== Number(dbIdText)) continue;
          const pull = repo.pulls.get(Number(numberText));
          if (pull) paths = forge.diffFiles(repo, pull.baseSha, pull.headSha).map((file) => file.filename);
        }
      }
      const nodes = paths.slice(0, first).map((path) => ({ path }));
      return executeSelections(ctx, { __typename: 'PullRequestChangedFileConnection', __nodes: nodes }, 'PullRequestChangedFileConnection', field.selections, variables);
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      const nodes = (value.__nodes ?? []) as AnyRecord[];
      const nodeType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((node) => executeSelections(ctx, node, nodeType, field.selections, variables));
    }
    if (name === 'pageInfo') {
      const pageInfo = (value.__pageInfo ?? {}) as AnyRecord;
      return executeSelections(ctx, { __typename: 'PageInfo', ...pageInfo }, 'PageInfo', field.selections, variables);
    }
    if (name === 'totalCount') return ((value.__nodes ?? []) as unknown[]).length;
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'PullRequestChangedFile') {
    if (name === 'path') return value.path ?? null;
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'PageInfo') {
    if (name === 'hasNextPage') return Boolean(value.hasNextPage);
    if (name === 'hasPreviousPage') return Boolean(value.hasPreviousPage);
    if (name === 'endCursor') return (value.endCursor as string | null) ?? null;
    if (name === 'startCursor') return (value.startCursor as string | null) ?? null;
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'Mutation') {
    return resolveMutation(ctx, field, variables);
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (name === 'issue') {
      const node = value.__issue as AnyRecord | null;
      if (node === null || node === undefined) return null;
      return executeSelections(ctx, node, 'Issue', field.selections, variables);
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (name === 'pullRequest') {
      const node = value.__pull as AnyRecord | null;
      if (node === null || node === undefined) return null;
      return executeSelections(ctx, node, 'PullRequest', field.selections, variables);
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'AddCommentPayload') {
    if (name === 'commentEdge') {
      const edge = value.__commentEdge as AnyRecord | null;
      if (edge === null || edge === undefined) return null;
      return executeSelections(ctx, edge, 'IssueCommentEdge', field.selections, variables);
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'IssueCommentEdge') {
    if (name === 'node') {
      const node = value.__node as AnyRecord | null;
      if (node === null || node === undefined) return null;
      return executeSelections(ctx, node, 'IssueComment', field.selections, variables);
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'IssueComment') {
    if (name === 'id') return value.__id ?? null;
    if (name === 'body') return value.__body ?? null;
    return unknownField(ctx, typeName, name);
  }

  return unknownField(ctx, typeName, name);
}

function subSelections(field: FieldNode, childName: string): SelectionNode[] {
  for (const selection of field.selections) {
    if (selection.kind === 'field' && selection.name === childName) return selection.selections;
  }
  return [];
}

function issuesConnection(ctx: Ctx, repo: import('./store.ts').Repo, args: Record<string, unknown>, field: FieldNode, variables: Record<string, unknown>): AnyRecord | null {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? args.after : null;

  let list = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  if (String(orderBy.field ?? 'CREATED_AT').toUpperCase() === 'CREATED_AT') {
    list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  } else {
    list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  }
  let startIndex = 0;
  if (after !== null) {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^i:(\d+)$/.exec(decoded);
      if (match) startIndex = Number(match[1]) + 1;
    } catch {
      startIndex = 0;
    }
  }
  const page = list.slice(startIndex, startIndex + first);
  const nodes = page.map((issue) => issueNode(ctx, repo.dbId, issue));
  const hasNextPage = startIndex + page.length < list.length;
  const endCursor = page.length > 0 ? Buffer.from(`i:${startIndex + page.length - 1}`, 'utf8').toString('base64') : null;
  const connection: AnyRecord = {
    __typename: 'IssueConnection',
    __nodes: nodes,
    __pageInfo: { hasNextPage, endCursor },
  };
  return executeSelections(ctx, connection, 'IssueConnection', field.selections, variables);
}

function resolveMutation(ctx: Ctx, field: FieldNode, variables: Record<string, unknown>): unknown {
  const name = field.name;
  const args = argsOf(field, variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const forge = ctx.forge;

  const repoByGlobalId = (id: unknown): import('./store.ts').Repo | null => {
    const decoded = decodeGlobalId(String(id ?? ''));
    if (decoded === null || decoded.type !== 'Repository') return null;
    for (const repo of forge.repos.values()) if (repo.dbId === Number(decoded.key)) return repo;
    return null;
  };

  if (name === 'createIssue') {
    const repo = repoByGlobalId(input.repositoryId);
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return executeSelections(ctx, { __typename: 'CreateIssuePayload', __issue: null }, 'CreateIssuePayload', field.selections, variables);
    }
    const created = ctx.issues.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return executeSelections(ctx, { __typename: 'CreateIssuePayload', __issue: null }, 'CreateIssuePayload', field.selections, variables);
    }
    const node = issueNode(ctx, repo.dbId, created.issue);
    return executeSelections(ctx, { __typename: 'CreateIssuePayload', __issue: node }, 'CreateIssuePayload', field.selections, variables);
  }

  if (name === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (decoded === null || decoded.type !== 'Issue') {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    const [dbIdText, numberText] = decoded.key.split(':');
    for (const repo of forge.repos.values()) {
      if (repo.dbId !== Number(dbIdText)) continue;
      const issue = repo.issues.get(Number(numberText));
      if (!issue) continue;
      issue.state = 'closed';
      const node = issueNode(ctx, repo.dbId, issue);
      return executeSelections(ctx, { __typename: 'CloseIssuePayload', __issue: node }, 'CloseIssuePayload', field.selections, variables);
    }
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return null;
  }

  if (name === 'createPullRequest') {
    const repo = repoByGlobalId(input.repositoryId);
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const created = ctx.issues.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return null;
    }
    const node = pullNode(ctx, repo.dbId, created.pull);
    return executeSelections(ctx, { __typename: 'CreatePullRequestPayload', __pull: node }, 'CreatePullRequestPayload', field.selections, variables);
  }

  if (name === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (decoded === null || decoded.type !== 'PullRequest') {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return null;
    }
    const [dbIdText, numberText] = decoded.key.split(':');
    for (const repo of forge.repos.values()) {
      if (repo.dbId !== Number(dbIdText)) continue;
      const pull = repo.pulls.get(Number(numberText));
      if (!pull) continue;
      const merged = ctx.issues.mergePull(repo, pull);
      if ('error' in merged) {
        ctx.errors.push({ message: merged.error });
        return null;
      }
      const node = pullNode(ctx, repo.dbId, pull);
      return executeSelections(ctx, { __typename: 'MergePullRequestPayload', __pull: node }, 'MergePullRequestPayload', field.selections, variables);
    }
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
    return null;
  }

  if (name === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (decoded === null || decoded.type !== 'Issue') {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    const [dbIdText, numberText] = decoded.key.split(':');
    for (const repo of forge.repos.values()) {
      if (repo.dbId !== Number(dbIdText)) continue;
      const issue = repo.issues.get(Number(numberText));
      if (!issue) continue;
      const commentId = repo.nextCommentId;
      repo.nextCommentId += 1;
      const comment = { id: commentId, body: String(input.body ?? ''), seq: commentId, createdAt: forge.nowIso() };
      issue.comments.push(comment);
      const node: AnyRecord = {
        __typename: 'IssueComment',
        __id: encodeGlobalId('IssueComment', `${repo.dbId}:${issue.number}:${commentId}`),
        __body: comment.body,
      };
      const edge: AnyRecord = { __typename: 'IssueCommentEdge', __node: node };
      return executeSelections(ctx, { __typename: 'AddCommentPayload', __commentEdge: edge }, 'AddCommentPayload', field.selections, variables);
    }
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return null;
  }

  return unknownField(ctx, 'Mutation', name);
}

// -------------------------------------------------------------------------------------------
// public entry points
// -------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(forge: Forge, issues: IssueStore, query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  const ctx: Ctx = { forge, issues, errors: [] };
  let operations: OperationNode[];
  try {
    operations = parseGraphQL(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'No operation in document' }] };
  let operation = operations[0] as OperationNode;
  if (operationName !== undefined) {
    const named = operations.find((candidate) => candidate.name === operationName);
    if (named !== undefined) operation = named;
  }
  const mergedVariables: Record<string, unknown> = {};
  for (const variable of operation.variables) {
    if (variables[variable.name] !== undefined) mergedVariables[variable.name] = variables[variable.name];
    else if (variable.defaultValue !== null) mergedVariables[variable.name] = resolveValue(variable.defaultValue, variables);
    else mergedVariables[variable.name] = null;
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, { __typename: rootType }, rootType, operation.selections, mergedVariables);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
