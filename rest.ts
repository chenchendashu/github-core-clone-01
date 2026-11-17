import type { IncomingMessage, ServerResponse } from 'node:http';
import { addComment, createIssue, createLabel, createPullRequest, createRepo, getIssue, getPullRequest, getRepo, HttpError, issueJson, listIssues, now, patchIssue, pullJson, readJson, repoJson, requiredString, sendJson, store, touchRepo, type PullRequest, type Repo } from './store.ts';
import { buildTree, commitFiles, createCommit, isDirectory, mergeBase, parseCommit, parseTree, peel, putObject, resolveRef, threeWayMerge, type TreeEntry } from './git.ts';

function pageNumber(raw: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(raw); return raw !== null && Number.isInteger(number) && number > 0 ? Math.min(max, number) : fallback;
}
function pagination<T>(items: T[], url: URL, req: IncomingMessage, res: ServerResponse): T[] {
  const count = pageNumber(url.searchParams.get('per_page'), 30, 100), page = pageNumber(url.searchParams.get('page'), 1), start = (page - 1) * count;
  if (start + count < items.length) {
    const next = new URL(url.pathname, `http://${req.headers.host ?? 'localhost'}`); next.search = url.search; next.searchParams.set('per_page', String(count)); next.searchParams.set('page', String(page + 1));
    res.setHeader('Link', `<${next.href}>; rel="next"`);
  }
  return items.slice(start, start + count);
}
function validPath(path: string): string {
  if (!path || path.split('/').some(p => !p || p === '.' || p === '..' || p.includes('\0'))) throw new HttpError(422, 'Invalid content path'); return path;
}
function branchTip(repo: Repo, input: Record<string, unknown>): { branch: string; tip?: string } {
  const branch = input.branch === undefined ? repo.defaultBranch : requiredString(input.branch, 'branch');
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip && (branch !== repo.defaultBranch || repo.refs.size)) throw new HttpError(422, 'Branch does not exist');
  return { branch, tip };
}
export function putContent(repo: Repo, path: string, input: Record<string, unknown>) {
  validPath(path); const message = requiredString(input.message, 'message');
  if (typeof input.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content.replace(/\s/g, ''))) throw new HttpError(422, 'Invalid base64 content');
  const { branch, tip } = branchTip(repo, input), files = commitFiles(repo, tip), existing = files.get(path);
  if (existing && existing.oid !== input.sha || !existing && input.sha !== undefined) throw new HttpError(409, 'File sha does not match');
  const data = Buffer.from(input.content, 'base64'), sha = putObject(repo, 'blob', data);
  files.set(path, { oid: sha, mode: existing?.mode ?? '100644' });
  const tree = buildTree(repo, files), commit = createCommit(repo, tree, tip ? [tip] : [], message);
  repo.refs.set(`refs/heads/${branch}`, commit); touchRepo(repo);
  return { status: existing ? 200 : 201, body: { content: { name: path.split('/').at(-1), path, sha, size: data.length, encoding: 'base64' }, commit: { sha: commit } } };
}
export function deleteContent(repo: Repo, path: string, input: Record<string, unknown>) {
  validPath(path); const message = requiredString(input.message, 'message'), { branch, tip } = branchTip(repo, input), files = commitFiles(repo, tip), existing = files.get(path);
  if (!existing) throw new HttpError(404, 'Not Found');
  if (existing.oid !== input.sha) throw new HttpError(409, 'File sha does not match');
  files.delete(path);
  const sha = createCommit(repo, buildTree(repo, files), tip ? [tip] : [], message);
  repo.refs.set(`refs/heads/${branch}`, sha); touchRepo(repo); return { content: null, commit: { sha } };
}
export function getContent(repo: Repo, path: string, ref?: string) {
  const tip = resolveRef(repo, ref ?? repo.defaultBranch); if (!tip) throw new HttpError(404, 'Not Found');
  const commit = repo.objects.get(peel(repo, tip)); if (commit?.type !== 'commit') throw new HttpError(404, 'Not Found');
  let entry: TreeEntry = { name: '', mode: '40000', oid: parseCommit(commit.data).tree };
  for (const name of path.split('/').filter(Boolean)) {
    if (!isDirectory(entry.mode)) throw new HttpError(404, 'Not Found');
    const tree = repo.objects.get(entry.oid); if (tree?.type !== 'tree') throw new HttpError(404, 'Not Found');
    const found = parseTree(tree.data).find(e => e.name === name); if (!found) throw new HttpError(404, 'Not Found'); entry = found;
  }
  const object = repo.objects.get(entry.oid); if (!object) throw new HttpError(404, 'Not Found');
  if (isDirectory(entry.mode)) return parseTree(object.data).sort((a, b) => a.name.localeCompare(b.name)).map(e => ({ type: isDirectory(e.mode) ? 'dir' : 'file', name: e.name, path: path ? `${path}/${e.name}` : e.name, sha: e.oid }));
  return { type: 'file', name: entry.name, path, sha: entry.oid, size: object.data.length, encoding: 'base64', content: object.data.toString('base64') };
}
export function listCommits(repo: Repo, ref?: string) {
  const tip = resolveRef(repo, ref ?? repo.defaultBranch), result: { sha: string; commit: { message: string } }[] = [], seen = new Set<string>(), queue = tip ? [peel(repo, tip)] : [];
  for (let i = 0; i < queue.length; i++) { const oid = queue[i]; if (seen.has(oid)) continue; seen.add(oid); const obj = repo.objects.get(oid); if (obj?.type !== 'commit') continue; const commit = parseCommit(obj.data); result.push({ sha: oid, commit: { message: commit.message.replace(/\n$/, '') } }); queue.push(...commit.parents); }
  return result;
}
function lines(data: Buffer): string[] { const text = data.toString(); if (!text) return []; const values = text.split('\n'); if (values.at(-1) === '') values.pop(); return values; }
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number; changes: number } {
  const a = lines(oldData), b = lines(newData); let prev = new Uint32Array(b.length + 1), next = new Uint32Array(b.length + 1);
  for (let i = 0; i < a.length; i++) { for (let j = 0; j < b.length; j++) next[j + 1] = a[i] === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], next[j]); const temp = prev; prev = next; next = temp; next.fill(0); }
  const additions = b.length - prev[b.length], deletions = a.length - prev[b.length]; return { additions, deletions, changes: additions + deletions };
}
export function pullFiles(repo: Repo, pr: PullRequest) {
  const head = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha, base = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
  const before = commitFiles(repo, mergeBase(repo, head, base)), after = commitFiles(repo, head);
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => before.get(path)?.oid !== after.get(path)?.oid || before.get(path)?.mode !== after.get(path)?.mode).map(path => {
    const old = before.get(path), updated = after.get(path);
    return { filename: path, status: !old ? 'added' : !updated ? 'removed' : 'modified', ...lineDiff(old ? repo.objects.get(old.oid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0), updated ? repo.objects.get(updated.oid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0)) };
  });
}
export function mergePullRequest(repo: Repo, pr: PullRequest, method = 'squash') {
  if (!['squash', 'merge', 'rebase'].includes(method)) throw new HttpError(422, 'Invalid merge method');
  if (pr.state !== 'open') throw new HttpError(405, 'Pull request is not open');
  const head = repo.refs.get(`refs/heads/${pr.head.ref}`), base = repo.refs.get(`refs/heads/${pr.base.ref}`);
  if (!head || !base) throw new HttpError(405, 'Branch does not exist');
  const merged = threeWayMerge(repo, head, base); if (merged.conflicts.length) throw new HttpError(405, 'Merge conflict');
  const sha = createCommit(repo, buildTree(repo, merged.files), method === 'merge' ? [base, head] : [base], pr.title);
  repo.refs.set(`refs/heads/${pr.base.ref}`, sha);
  pr.state = 'closed'; pr.merged = true; pr.merged_at = now(); pr.updated_at = pr.merged_at; pr.merge_commit_sha = sha; pr.head.sha = head; pr.base.sha = base; touchRepo(repo);
  return { sha, merged: true, message: 'Pull Request successfully merged' };
}
export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET', segments = url.pathname.slice('/api/v3'.length).split('/').filter(Boolean).map(decodeURIComponent);
  const respond = (status: number, body: unknown): void => sendJson(res, status, body);
  if (method === 'GET' && !segments.length) { sendJson(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}', rate_limit_url: '/api/v3/rate_limit' }, { 'X-OAuth-Scopes': 'repo' }); return; }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') { respond(200, { installed_version: '1.0.0' }); return; }
  if (segments.join('/') === 'user/repos') {
    if (method === 'POST') {
      const body = await readJson(req), repo = createRepo(body);
      if (body.auto_init === true) putContent(repo, 'README.md', { message: 'Initial commit', content: Buffer.from(`# ${repo.name}\n`).toString('base64') });
      respond(201, repoJson(repo)); return;
    }
    if (method === 'GET') { respond(200, pagination([...store.repos.values()].sort((a, b) => a.dbId - b.dbId).map(repoJson), url, req, res)); return; }
  }
  if (segments[0] !== 'repos' || segments.length < 3) throw new HttpError(404, 'Not Found');
  const repo = getRepo(segments[1], segments[2]), route = segments.slice(3), resource = route[0];
  if (!route.length) {
    if (method === 'GET') { respond(200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (body.name !== undefined) { const name = requiredString(body.name, 'name'); if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new HttpError(422, 'Invalid repository name'); const duplicate = store.repos.get(name.toLowerCase()); if (duplicate && duplicate !== repo) throw new HttpError(422, 'Repository already exists'); store.repos.delete(repo.name.toLowerCase()); repo.name = name; store.repos.set(name.toLowerCase(), repo); }
      if (body.description !== undefined) { if (typeof body.description !== 'string' && body.description !== null) throw new HttpError(422, 'Invalid description'); repo.description = body.description ?? ''; }
      if (body.private !== undefined) { if (typeof body.private !== 'boolean') throw new HttpError(422, 'Invalid private'); repo.private = body.private; }
      touchRepo(repo); respond(200, repoJson(repo)); return;
    }
    if (method === 'DELETE') { store.repos.delete(repo.name.toLowerCase()); store.reposById.delete(repo.dbId); respond(204, null); return; }
  }
  if (route.join('/') === 'git/refs' && method === 'POST') {
    const body = await readJson(req), ref = requiredString(body.ref, 'ref'), sha = requiredString(body.sha, 'sha');
    if (!/^refs\/heads\/[^\s\0]+$/.test(ref) || repo.objects.get(sha)?.type !== 'commit') throw new HttpError(422, 'Invalid ref or commit sha');
    if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists'); repo.refs.set(ref, sha); touchRepo(repo); respond(201, { ref, object: { sha, type: 'commit' } }); return;
  }
  if (resource === 'branches' && route.length === 1 && method === 'GET') { respond(200, [...repo.refs].filter(([name]) => name.startsWith('refs/heads/')).map(([name, sha]) => ({ name: name.slice(11), commit: { sha } }))); return; }
  if (resource === 'commits' && route.length === 1 && method === 'GET') { respond(200, pagination(listCommits(repo, url.searchParams.get('sha') ?? undefined), url, req, res)); return; }
  if (resource === 'contents') {
    const path = route.slice(1).join('/');
    if (method === 'GET') { respond(200, getContent(repo, path, url.searchParams.get('ref') ?? undefined)); return; }
    if (method === 'PUT') { const result = putContent(repo, path, await readJson(req)); respond(result.status, result.body); return; }
    if (method === 'DELETE') { respond(200, deleteContent(repo, path, await readJson(req))); return; }
  }
  if (resource === 'labels' && route.length === 1) {
    if (method === 'POST') { respond(201, createLabel(repo, await readJson(req))); return; }
    if (method === 'GET') { respond(200, [...repo.labels.values()]); return; }
  }
  if (resource === 'issues') {
    if (route.length === 1) {
      if (method === 'POST') { respond(201, issueJson(createIssue(repo, await readJson(req)))); return; }
      if (method === 'GET') { respond(200, pagination(listIssues(repo, url.searchParams.get('state') ?? 'open', url.searchParams.get('direction') ?? 'desc').map(issueJson), url, req, res)); return; }
    }
    if (route.length === 2 || route.length === 3 && route[2] === 'comments') {
      const issue = getIssue(repo, Number(route[1]));
      if (route.length === 2) {
        if (method === 'GET') { respond(200, issueJson(issue)); return; }
        if (method === 'PATCH') { respond(200, issueJson(patchIssue(issue, await readJson(req)))); return; }
      } else {
        if (method === 'POST') { respond(201, addComment(issue, (await readJson(req)).body)); return; }
        if (method === 'GET') { respond(200, issue.comments); return; }
      }
    }
  }
  if (resource === 'pulls') {
    if (route.length === 1) {
      if (method === 'POST') { respond(201, pullJson(repo, createPullRequest(repo, await readJson(req)))); return; }
      if (method === 'GET') { const state = url.searchParams.get('state') ?? 'open'; respond(200, pagination([...repo.pullRequests.values()].filter(p => state === 'all' || p.state === state).map(p => pullJson(repo, p)), url, req, res)); return; }
    }
    if (route.length === 2 || route.length === 3 && ['files', 'merge'].includes(route[2])) {
      const pr = getPullRequest(repo, Number(route[1]));
      if (route.length === 2 && method === 'GET') { respond(200, pullJson(repo, pr)); return; }
      if (route[2] === 'files' && method === 'GET') { respond(200, pullFiles(repo, pr)); return; }
      if (route[2] === 'merge' && method === 'PUT') { const body = await readJson(req); respond(200, mergePullRequest(repo, pr, body.merge_method === undefined ? 'merge' : requiredString(body.merge_method, 'merge_method'))); return; }
    }
  }
  throw new HttpError(404, 'Not Found');
}
