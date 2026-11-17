import type { IncomingMessage, ServerResponse } from 'node:http';

const SEED = 0x6a09e667f3bcc909n;
const MASK = 0xffffffffffffffffn;
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) hash = ((hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & MASK;
  return hash;
}
export const hashString = fnv1a64;
export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}
export class Rng {
  state: bigint;
  constructor(seed: bigint) { this.state = (seed & MASK) || SEED; }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }
  nextInt(max: number): number {
    if (!Number.isSafeInteger(max) || max <= 0 || max > 4294967296) throw new Error('Invalid random range');
    if (max === 1) return 0;
    const limit = 4294967296 - (4294967296 % max);
    for (;;) { const n = Number(this.nextU64() >> 32n); if (n < limit) return n % max; }
  }
  pick<T>(values: readonly T[]): T { return values[this.nextInt(values.length)]; }
}
export function scenarioRng(label: string): Rng { return new Rng(mix64(SEED ^ fnv1a64(label))); }
const FIRST_NAMES = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'];
const LAST_NAMES = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'];
const ADJECTIVES = ['amber','brisk','calm','crisp','eager','faint','gentle','happy','idle','jolly','keen','lively','mellow','nimble','open','plain','quick','quiet','rapid','soft','steady','tidy','upbeat','vivid','warm','witty','young','zesty'];
const NOUNS = ['acorn','badger','canyon','cedar','comet','coral','delta','ember','falcon','glade','harbor','indigo','juniper','kettle','lantern','meadow','nebula','orchid','pebble','quartz','raven','saffron','thistle','umber','violet','willow','yarrow','zephyr'];
export interface User { id: number; login: string; name: string; email: string }
export function generateUsers(rng: Rng, count: number): User[] {
  const used = new Set<string>();
  return Array.from({ length: count }, (_, i) => {
    const first = rng.pick(FIRST_NAMES), last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base, suffix = 2;
    while (used.has(login)) login = `${base}-${suffix++}`;
    used.add(login);
    return Object.freeze({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  });
}
const users = generateUsers(scenarioRng('users'), 12);
const orgRng = scenarioRng('org');
export const scenario = Object.freeze({ users, viewer: users[0], teammate: users[1], stranger: users[2], org: `${orgRng.pick(ADJECTIVES)}-${orgRng.pick(NOUNS)}-org` });
export const viewer = scenario.viewer;
if (viewer.login !== 'adaiversen' || users[1].login !== 'quinnkeller' || users[2].login !== 'olgabauer' || scenario.org !== 'faint-meadow-org') throw new Error('Scenario identity mismatch');

const configuredTime = process.env.MAKEFUN_TRIAL_NOW;
const baseTime = configuredTime === undefined ? Date.now() : Number(configuredTime);
const epoch = Number.isFinite(baseTime) ? baseTime : 1735689600000;
let clock = 0;
export function nowMs(): number { return epoch + ++clock; }
export function now(): string { return new Date(nowMs()).toISOString(); }
const counters = new Map<string, number>();
export function nextId(type: string): number { const id = (counters.get(type) ?? 0) + 1; counters.set(type, id); return id; }
export function encodeGlobalId(type: string, dbId: number, number?: number): string {
  return Buffer.from(number === undefined ? `${type}:${dbId}` : `${type}:${dbId}:${number}`).toString('base64');
}
export function decodeGlobalId(id: string): { type: string; dbId: number; number?: number } | null {
  if (typeof id !== 'string') return null;
  const m = /^([A-Za-z]+):(\d+)(?::(\d+))?$/.exec(Buffer.from(id, 'base64').toString());
  if (!m) return null;
  return { type: m[1], dbId: Number(m[2]), ...(m[3] === undefined ? {} : { number: Number(m[3]) }) };
}
export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjectType; data: Buffer }
export interface Label { id: number; name: string; color: string; description: string }
export interface Comment { id: number; body: string; user: User; created_at: string; updated_at: string }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; user: User; created_at: string; updated_at: string; comments: Comment[];
}
export interface PullRequest {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  user: User; created_at: string; updated_at: string;
}
export interface Repo {
  dbId: number; name: string; description: string; private: boolean; defaultBranch: string;
  created_at: string; updated_at: string; refs: Map<string, string>; objects: Map<string, GitObject>;
  issues: Map<number, Issue>; pullRequests: Map<number, PullRequest>; labels: Map<string, Label>;
  nextNumber: number; packCache: Map<string, Buffer>;
}
export const store = { repos: new Map<string, Repo>(), reposById: new Map<number, Repo>(), viewer, scenario };
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(422, `${field} is required`);
  return value;
}
export function createRepo(input: { name?: unknown; description?: unknown; private?: unknown }): Repo {
  const name = requiredString(input.name, 'name');
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new HttpError(422, 'Invalid repository name');
  if (store.repos.has(name.toLowerCase())) throw new HttpError(422, 'Repository already exists');
  const time = now();
  const repo: Repo = { dbId: nextId('Repository'), name, description: typeof input.description === 'string' ? input.description : '', private: input.private === true, defaultBranch: 'main', created_at: time, updated_at: time, refs: new Map(), objects: new Map(), issues: new Map(), pullRequests: new Map(), labels: new Map(), nextNumber: 1, packCache: new Map() };
  store.repos.set(name.toLowerCase(), repo); store.reposById.set(repo.dbId, repo);
  return repo;
}
export function getRepo(owner: string, name: string): Repo {
  const repo = owner === viewer.login ? store.repos.get(name.toLowerCase()) : undefined;
  if (!repo) throw new HttpError(404, 'Not Found');
  return repo;
}
export function repoJson(repo: Repo) {
  return { id: repo.dbId, databaseId: repo.dbId, name: repo.name, full_name: `${viewer.login}/${repo.name}`, description: repo.description, private: repo.private, default_branch: repo.defaultBranch, owner: viewer, created_at: repo.created_at, updated_at: repo.updated_at };
}
export function touchRepo(repo: Repo): void { repo.updated_at = now(); repo.packCache.clear(); }
export function createLabel(repo: Repo, input: Record<string, unknown>): Label {
  const name = requiredString(input.name, 'name');
  if (repo.labels.has(name)) throw new HttpError(422, 'Label already exists');
  const label = { id: nextId('Label'), name, color: typeof input.color === 'string' ? input.color : 'ededed', description: typeof input.description === 'string' ? input.description : '' };
  repo.labels.set(name, label); return label;
}
export function createIssue(repo: Repo, input: Record<string, unknown>): Issue {
  const title = requiredString(input.title, 'title');
  if (input.labels !== undefined && (!Array.isArray(input.labels) || input.labels.some(v => typeof v !== 'string'))) throw new HttpError(422, 'Invalid labels');
  const labels = ((input.labels ?? []) as string[]).map(name => { const label = repo.labels.get(name); if (!label) throw new HttpError(422, `Label ${name} does not exist`); return label; });
  const time = now();
  const issue: Issue = { id: nextId('Issue'), number: repo.nextNumber++, title, body: typeof input.body === 'string' ? input.body : '', labels, state: 'open', user: viewer, created_at: time, updated_at: time, comments: [] };
  repo.issues.set(issue.number, issue); return issue;
}
export function issueJson(issue: Issue) { const { comments, ...json } = issue; return json; }
export function listIssues(repo: Repo, state = 'open', direction = 'desc'): Issue[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...repo.issues.values()].filter(i => state === 'all' || i.state === state).sort((a, b) => sign * (a.created_at.localeCompare(b.created_at) || a.number - b.number));
}
export function getIssue(repo: Repo, number: number): Issue { const issue = repo.issues.get(number); if (!issue) throw new HttpError(404, 'Not Found'); return issue; }
export function patchIssue(issue: Issue, input: Record<string, unknown>): Issue {
  if (input.state !== undefined) { if (input.state !== 'open' && input.state !== 'closed') throw new HttpError(422, 'Invalid state'); issue.state = input.state; }
  if (input.title !== undefined) issue.title = requiredString(input.title, 'title');
  if (input.body !== undefined) { if (typeof input.body !== 'string') throw new HttpError(422, 'Invalid body'); issue.body = input.body; }
  issue.updated_at = now(); return issue;
}
export function addComment(issue: Issue, body: unknown): Comment {
  const text = requiredString(body, 'body'), time = now();
  const comment = { id: nextId('IssueComment'), body: text, user: viewer, created_at: time, updated_at: time };
  issue.comments.push(comment); issue.updated_at = time; return comment;
}
export function createPullRequest(repo: Repo, input: Record<string, unknown>): PullRequest {
  const title = requiredString(input.title, 'title'), head = requiredString(input.head, 'head'), base = requiredString(input.base, 'base');
  const headSha = repo.refs.get(`refs/heads/${head}`), baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) throw new HttpError(422, 'Head or base branch does not exist');
  if ([...repo.pullRequests.values()].some(p => p.state === 'open' && p.head.ref === head && p.base.ref === base)) throw new HttpError(422, 'Pull request already exists');
  const time = now();
  const pr: PullRequest = { id: nextId('PullRequest'), number: repo.nextNumber++, title, body: typeof input.body === 'string' ? input.body : '', state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha }, merged: false, merged_at: null, merge_commit_sha: null, user: viewer, created_at: time, updated_at: time };
  repo.pullRequests.set(pr.number, pr); return pr;
}
export function getPullRequest(repo: Repo, number: number): PullRequest { const pr = repo.pullRequests.get(number); if (!pr) throw new HttpError(404, 'Not Found'); return pr; }
export function pullJson(repo: Repo, pr: PullRequest) {
  return { ...pr, head: { ...pr.head, sha: repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha }, base: { ...pr.base, sha: repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha } };
}
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 128 * 1024 * 1024) throw new HttpError(413, 'Request too large'); chunks.push(b); }
  return Buffer.concat(chunks);
}
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try { const value = JSON.parse((await readBody(req)).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Malformed JSON body'); }
}
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = status === 204 ? '' : JSON.stringify(body) + '\n';
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': nextId('Request').toString(16), 'Content-Length': Buffer.byteLength(data), ...headers }); res.end(data);
}
