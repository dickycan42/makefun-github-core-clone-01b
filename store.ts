// store.ts — the forge's own store: repositories, git objects, issues,
// pull requests and labels, all in memory.
//
// Determinism: no wall clock anywhere. Every timestamp comes from a logical
// clock (a fixed epoch plus a per-store counter), so two runs fed the same
// requests in the same order hold byte-identical state.

import { VIEWER } from './scenario.ts';
import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  nextCommentId: number;
  commitSeq: number;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

const EPOCH = 1735689600; // 2025-01-01T00:00:00Z, the scenario's day one.

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < content.length; i += 1) if (content[i] === 0x0a) lines += 1;
  if (content[content.length - 1] !== 0x0a) lines += 1;
  return lines;
}

export class Forge {
  readonly viewerLogin = VIEWER.login;
  readonly viewerName = VIEWER.name;
  readonly viewerEmail = VIEWER.email;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextGlobalId = 1;
  private clockSeq = 0;

  /** The next logical timestamp (seconds since the epoch) and its ISO form. */
  private tick(): { ts: number; iso: string } {
    this.clockSeq += 1;
    const ts = EPOCH + this.clockSeq;
    return { ts, iso: new Date(ts * 1000).toISOString() };
  }

  /** The next global numeric id (issues, comments, pull requests). */
  nextId(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }

  /** The current logical time as ISO text. */
  nowIso(): string {
    return this.tick().iso;
  }

  /** The commit identity line for this forge's author. */
  identityLine(): string {
    return this.identity();
  }

  private identity(): string {
    return `${this.viewerName} <${this.viewerEmail}>`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const { ts } = this.tick();
    void ts;
    const repo: Repo = {
      dbId: this.nextRepoId,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.clockSeq,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      commitSeq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewerLogin) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The commit a ref resolves to (tags peel to their commit). */
  resolveCommit(repo: Repo, refOrOid: string): string | undefined {
    let oid = repo.refs.get(refOrOid) ?? repo.refs.get(`refs/heads/${refOrOid}`) ?? repo.refs.get(`refs/tags/${refOrOid}`);
    if (oid === undefined && isObjectId(refOrOid)) oid = refOrOid;
    if (oid === undefined) return undefined;
    const object = repo.objects.get(oid);
    if (!object) return undefined;
    if (object.type === 'tag') return parseTag(object.data).object;
    if (object.type === 'commit') return oid;
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // trees
  // -------------------------------------------------------------------------------------------

  /** Flatten a tree into path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, base: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (and store) a root tree from a flat path map. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  // -------------------------------------------------------------------------------------------
  // commits through the contents API
  // -------------------------------------------------------------------------------------------

  /**
   * Commit one file on `branch` (creating the branch from the default tip
   * when it does not exist yet). Returns the new commit and blob ids.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    options: { delete?: boolean; expectedBlobSha?: string } = {},
  ): { commitSha: string; blobSha: string | null; error?: string } {
    let tip = this.branchTip(repo, branch);
    if (tip === undefined && branch !== repo.defaultBranch) {
      tip = this.branchTip(repo, repo.defaultBranch);
    }
    const blobSha = options.delete === true ? null : this.putObject(repo, 'blob', content);
    let files = new Map<string, { oid: string; mode: string }>();
    if (tip !== undefined) {
      const commit = parseCommit((repo.objects.get(tip) as GitObject).data);
      files = this.flattenTree(repo, commit.tree);
    }
    if (options.delete === true) {
      if (!files.has(path)) return { commitSha: '', blobSha: null, error: 'not-found' };
      files.delete(path);
    } else {
      if (options.expectedBlobSha !== undefined) {
        const current = files.get(path);
        if (current === undefined) return { commitSha: '', blobSha: null, error: 'not-found' };
        if (current.oid.toLowerCase() !== options.expectedBlobSha.toLowerCase()) {
          return { commitSha: '', blobSha: null, error: 'stale-sha' };
        }
      }
      files.set(path, { oid: blobSha as string, mode: '100644' });
    }
    const treeOid = this.buildTreeFromFiles(repo, files);
    repo.commitSeq += 1;
    const { ts } = this.tick();
    const parents = tip === undefined ? [] : [tip];
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.identity(),
      committer: this.identity(),
      timestamp: EPOCH + repo.commitSeq,
    });
    void ts;
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Read one file's blob at a ref (or the default branch tip). */
  readFile(repo: Repo, path: string, ref?: string): { blobSha: string; content: Buffer; size: number } | null {
    const tip = ref !== undefined ? this.resolveCommit(repo, ref) : this.branchTip(repo, repo.defaultBranch);
    if (tip === undefined) return null;
    const commit = parseCommit((repo.objects.get(tip) as GitObject).data);
    const files = this.flattenTree(repo, commit.tree);
    const entry = files.get(path);
    if (entry === undefined) return null;
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { blobSha: entry.oid, content: blob.data, size: blob.data.length };
  }

  /** List a directory's immediate entries at a ref (or the default branch tip). */
  readDir(repo: Repo, path: string, ref?: string): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> | null {
    const tip = ref !== undefined ? this.resolveCommit(repo, ref) : this.branchTip(repo, repo.defaultBranch);
    if (tip === undefined) return null;
    const commit = parseCommit((repo.objects.get(tip) as GitObject).data);
    const files = this.flattenTree(repo, commit.tree);
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir' }>();
    for (const [filePath, value] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        seen.set(rest, { name: rest, path: filePath, sha: value.oid, type: 'file' });
      } else {
        const dirName = rest.slice(0, slash);
        if (!seen.has(dirName)) {
          seen.set(dirName, { name: dirName, path: `${prefix}${dirName}`, sha: '', type: 'dir' });
        }
      }
    }
    if (seen.size === 0) return null;
    const out = [...seen.values()];
    // Directory entries need a tree sha: resolve from the tree itself.
    for (const entry of out) {
      if (entry.type !== 'dir') continue;
      entry.sha = this.dirTreeSha(repo, commit.tree, entry.path) ?? '';
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private dirTreeSha(repo: Repo, treeOid: string, path: string): string | null {
    let current = treeOid;
    for (const segment of path.split('/')) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  /** The commits reachable from a ref, newest first (by creation order). */
  listCommits(repo: Repo, ref?: string): Array<{ sha: string; message: string; createdAt: string }> {
    const tip = ref !== undefined ? this.resolveCommit(repo, ref) : this.branchTip(repo, repo.defaultBranch);
    if (tip === undefined) return [];
    const out: Array<{ sha: string; message: string; createdAt: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, createdAt: '' });
      queue.push(...commit.parents);
    }
    // Creation order: commits were created in sequence; order by commit object
    // timestamp is unreliable across pushes, so keep discovery order (BFS from
    // the tip follows first-parent chains newest-first for linear history).
    return out;
  }

  /** The files changed between two commits' trees. */
  diffFiles(repo: Repo, baseSha: string, headSha: string): ChangedFile[] {
    const baseTree = this.treeOf(repo, baseSha);
    const headTree = this.treeOf(repo, headSha);
    const baseFiles = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const headFiles = headTree === null ? new Map() : this.flattenTree(repo, headTree);
    const out: ChangedFile[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      if (base === undefined && head !== undefined) {
        const content = (repo.objects.get(head.oid) as GitObject).data;
        const additions = countLines(content);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (base !== undefined && head === undefined) {
        const content = (repo.objects.get(base.oid) as GitObject).data;
        const deletions = countLines(content);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (base !== undefined && head !== undefined) {
        const oldContent = (repo.objects.get(base.oid) as GitObject).data;
        const newContent = (repo.objects.get(head.oid) as GitObject).data;
        const additions = countLines(newContent);
        const deletions = countLines(oldContent);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  treeOf(repo: Repo, commitSha: string): string | null {
    const object = repo.objects.get(commitSha);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }
}

// -------------------------------------------------------------------------------------------
// issues, labels, pull requests
// -------------------------------------------------------------------------------------------

export function issueToJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: repo.owner },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

export function pullToJson(pull: PullRequest, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function repoToJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    created_at: new Date((1735689600 + repo.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1735689600 + repo.createdSeq) * 1000).toISOString(),
  };
}

export class IssueStore {
  private forge: Forge;

  constructor(forge: Forge) {
    this.forge = forge;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): { issue: Issue } | { error: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.forge.nextId();
    const now = this.forge.nowIso();
    const issue: Issue = {
      id,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: number,
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(number, issue);
    return { issue };
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): { pull: PullRequest } | { error: string } {
    const headSha = this.forge.resolveCommit(repo, head);
    const baseSha = this.forge.resolveCommit(repo, base);
    if (headSha === undefined) return { error: `Head branch "${head}" does not exist` };
    if (baseSha === undefined) return { error: `Base branch "${base}" does not exist` };
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.forge.nextId();
    const now = this.forge.nowIso();
    const pull: PullRequest = {
      id,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      seq: number,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(number, pull);
    return { pull };
  }

  /** MERGEABLE / CONFLICTING for a pull request (same rule the merge uses). */
  mergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    return this.conflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * The conflicting path of a pull request, or null when it merges cleanly.
   * A conflict is a file both sides changed from the merge-base to different
   * contents.
   */
  conflict(repo: Repo, pull: PullRequest): string | null {
    const base = mergeBase(this.forge.lookup(repo), pull.headSha, pull.baseSha);
    if (base === null) return null;
    const headFiles = this.forge.diffFiles(repo, base, pull.headSha);
    // The base side is the branch's CURRENT tip, not the sha captured when
    // the pull request was opened: another pull request may have merged
    // onto it since, and that is what conflicts with this head.
    const currentBaseSha = this.forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const baseFiles = this.forge.diffFiles(repo, base, currentBaseSha);
    const headChanged = new Map(headFiles.map((file) => [file.filename, file]));
    for (const file of baseFiles) {
      const other = headChanged.get(file.filename);
      if (other === undefined) continue;
      const headTree = this.forge.treeOf(repo, pull.headSha) as string;
      const baseTree = this.forge.treeOf(repo, currentBaseSha) as string;
      const headContent = this.forge.flattenTree(repo, headTree).get(file.filename);
      const baseContent = this.forge.flattenTree(repo, baseTree).get(file.filename);
      if (headContent?.oid !== baseContent?.oid) return file.filename;
    }
    return null;
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, pull: PullRequest): { sha: string; message: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    const conflict = this.conflict(repo, pull);
    if (conflict !== null) return { error: `Merge conflict in ${conflict}`, status: 405 };
    const headTree = this.forge.treeOf(repo, pull.headSha);
    if (headTree === null) return { error: 'Head commit not found', status: 422 };
    const baseTip = this.forge.branchTip(repo, pull.baseRef);
    const parents = baseTip === undefined ? [] : [baseTip];
    const message = `${pull.title} (#${pull.number})\n`;
    const now = this.forge.nowIso();
    repo.commitSeq += 1;
    const commitData = buildCommit({
      tree: headTree,
      parents,
      message,
      author: this.forge.identityLine(),
      committer: this.forge.identityLine(),
      timestamp: 1735689600 + repo.commitSeq,
    });
    const sha = this.forge.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.mergeCommitSha = sha;
    pull.updatedAt = now;
    return { sha, message: `Merged pull request #${pull.number}` };
  }
}
