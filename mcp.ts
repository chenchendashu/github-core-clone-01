import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createIssue, createPullRequest, createRepo, getPullRequest, getRepo, HttpError,
  issueJson, listIssues, pullJson, readBody, repoJson, requiredString, sendJson, viewer,
} from './store.ts';
import { mergePullRequest } from './rest.ts';

// A single literal, with stable property and tool order on every tools/list request.
const TOOLS = [
  { name: 'create_repo', description: 'Create a repository owned by the authenticated viewer.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Read repository metadata.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List repository issues, optionally filtering by state.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request between existing repository branches.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge an open pull request and advance its base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' }, merge_method: { type: 'string', enum: ['squash', 'merge', 'rebase'] } }, required: ['owner', 'repo', 'pull_number'] } },
] as const;
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const DISCOVERY = {
  supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
  capabilities: { tools: {} }, serverInfo: SERVER_INFO, protocolVersion: '2026-07-28',
  _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO, 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
};
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function callTool(name: string, args: Record<string, unknown>): unknown {
  if (name === 'create_repo') {
    if (args.owner !== undefined && requiredString(args.owner, 'owner') !== viewer.login) throw new HttpError(404, 'Not Found');
    return repoJson(createRepo(args));
  }
  const repo = getRepo(requiredString(args.owner, 'owner'), requiredString(args.repo, 'repo'));
  if (name === 'get_repo') return repoJson(repo);
  if (name === 'create_issue') return issueJson(createIssue(repo, args));
  if (name === 'list_issues') return { issues: listIssues(repo, typeof args.state === 'string' ? args.state : 'open').map(issueJson) };
  if (name === 'create_pull_request') return pullJson(repo, createPullRequest(repo, args));
  if (name === 'merge_pull_request') {
    const pr = getPullRequest(repo, args.pull_number as number);
    return mergePullRequest(repo, pr, args.merge_method === undefined ? 'merge' : requiredString(args.merge_method, 'merge_method'));
  }
  throw new Error('Unknown tool');
}
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try { body = JSON.parse((await readBody(req)).toString()); }
  catch (e) {
    if (e instanceof HttpError) throw e;
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return;
  }
  const id = isRecord(body) && (typeof body.id === 'string' || typeof body.id === 'number' || body.id === null) ? body.id : null;
  const error = (code: number, message: string, status = 200): void => sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
  const result = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string'
    || Object.hasOwn(body, 'id') && body.id !== null && typeof body.id !== 'number' && typeof body.id !== 'string') {
    error(-32600, 'Invalid Request', 400); return;
  }
  if (!Object.hasOwn(body, 'id') || body.method === 'notifications/initialized') {
    res.writeHead(202, { 'Content-Length': '0' }); res.end(); return;
  }
  // MCP versions, sessions, and _meta do not gate subsequent stateless requests.
  const params = isRecord(body.params) ? body.params : {};
  if (body.method === 'server/discover') { result(DISCOVERY); return; }
  if (body.method === 'initialize') {
    result({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: SERVER_INFO }); return;
  }
  if (body.method === 'tools/list') { result({ tools: TOOLS }); return; }
  if (body.method !== 'tools/call') { error(-32601, 'Method not found'); return; }
  const tool = TOOLS.find(tool => tool.name === params.name);
  if (!tool) { error(-32602, `Unknown tool '${String(params.name)}'`); return; }
  try {
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isRecord(args)) throw new Error('arguments must be an object');
    for (const name of tool.inputSchema.required) {
      if (args[name] === undefined || args[name] === null) throw new Error(`Missing required argument '${name}'`);
    }
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      if (args[name] === undefined) continue;
      if (schema.type === 'integer' ? typeof args[name] !== 'number' || !Number.isSafeInteger(args[name]) || Number(args[name]) < 1 : typeof args[name] !== schema.type) throw new Error(`Invalid argument '${name}': expected ${schema.type}`);
      if ('enum' in schema && !(schema.enum as readonly unknown[]).includes(args[name])) throw new Error(`Invalid argument '${name}'`);
    }
    const value = callTool(tool.name, args);
    result({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
  } catch (e) { result({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }); }
}
