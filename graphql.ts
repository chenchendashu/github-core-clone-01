import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  addComment, createIssue, createPullRequest, decodeGlobalId, encodeGlobalId, getRepo,
  HttpError, patchIssue, readBody, requiredString, sendJson, store, viewer,
  type Comment, type Issue, type PullRequest, type Repo,
} from './store.ts';
import { threeWayMerge } from './git.ts';
import { mergePullRequest, pullFiles } from './rest.ts';

type Value = { kind: 'literal'; value: unknown } | { kind: 'variable'; name: string }
  | { kind: 'list'; values: Value[] } | { kind: 'object'; fields: Record<string, Value> };
type Selection = { kind: 'field'; name: string; alias: string; args: Record<string, Value>; selections: Selection[] }
  | { kind: 'fragment'; type: string; selections: Selection[] };
interface TypeRef { name?: string; element?: TypeRef; nonNull: boolean }
interface Variable { name: string; type: TypeRef; defaultValue?: Value }
interface Operation { kind: 'query' | 'mutation'; name?: string; variables: Variable[]; selections: Selection[] }
interface Token { kind: 'name' | 'string' | 'int' | 'punct' | 'end'; text: string }

/** Only the documented GraphQL subset, with bounded nesting and no external parser. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let pos = 0; pos < source.length;) {
    const ch = source[pos];
    if (/[\s,\uFEFF]/u.test(ch)) { pos++; continue; }
    if (ch === '#') { while (pos < source.length && source[pos] !== '\n') pos++; continue; }
    if (source.startsWith('...', pos)) { tokens.push({ kind: 'punct', text: '...' }); pos += 3; }
    else if ('!$():={}[]'.includes(ch)) { tokens.push({ kind: 'punct', text: ch }); pos++; }
    else if (ch === '"') {
      const start = pos++;
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\\') pos++;
        pos++;
      }
      if (pos >= source.length) throw new Error('Unterminated GraphQL string');
      const raw = source.slice(start, ++pos);
      tokens.push({ kind: 'string', text: JSON.parse(raw) as string });
    } else {
      const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(pos));
      const integer = /^-?(?:0|[1-9][0-9]*)/.exec(source.slice(pos));
      if (name) { tokens.push({ kind: 'name', text: name[0] }); pos += name[0].length; }
      else if (integer) {
        const number = Number(integer[0]);
        if (!Number.isSafeInteger(number)) throw new Error('GraphQL integer is out of range');
        tokens.push({ kind: 'int', text: integer[0] }); pos += integer[0].length;
      } else throw new Error(`Unexpected GraphQL character '${ch}'`);
    }
    if (tokens.length > 100_000) throw new Error('GraphQL document is too large');
  }
  tokens.push({ kind: 'end', text: '' });
  return tokens;
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(source: string) { this.tokens = tokenize(source); }
  peek(): Token { return this.tokens[this.pos]; }
  take(text: string): boolean { if (this.peek().text !== text || this.peek().kind !== (text === 'on' ? 'name' : 'punct')) return false; this.pos++; return true; }
  expect(text: string): void { if (!this.take(text)) throw new Error(`Expected '${text}', found '${this.peek().text || 'end of document'}'`); }
  name(): string { if (this.peek().kind !== 'name') throw new Error(`Expected a name, found '${this.peek().text || 'end of document'}'`); return this.tokens[this.pos++].text; }
  depth(depth: number): void { if (depth > 100) throw new Error('GraphQL nesting is too deep'); }
  value(depth = 0): Value {
    this.depth(depth);
    if (this.take('$')) return { kind: 'variable', name: this.name() };
    if (this.take('[')) {
      const values: Value[] = [];
      while (!this.take(']')) values.push(this.value(depth + 1));
      return { kind: 'list', values };
    }
    if (this.take('{')) {
      const fields: Record<string, Value> = Object.create(null);
      while (!this.take('}')) { const name = this.name(); this.expect(':'); fields[name] = this.value(depth + 1); }
      return { kind: 'object', fields };
    }
    const token = this.peek();
    if (!['string', 'int', 'name'].includes(token.kind)) throw new Error(`Expected a value, found '${token.text || 'end of document'}'`);
    this.pos++;
    const value = token.kind === 'int' ? Number(token.text) : token.kind === 'name' && token.text === 'null' ? null
      : token.kind === 'name' && token.text === 'true' ? true : token.kind === 'name' && token.text === 'false' ? false : token.text;
    return { kind: 'literal', value };
  }
  type(depth = 0): TypeRef {
    this.depth(depth);
    let result: TypeRef;
    if (this.take('[')) { result = { element: this.type(depth + 1), nonNull: false }; this.expect(']'); }
    else result = { name: this.name(), nonNull: false };
    result.nonNull = this.take('!'); return result;
  }
  selections(depth = 0): Selection[] {
    this.depth(depth); this.expect('{');
    const selections: Selection[] = [];
    while (!this.take('}')) {
      if (this.take('...')) {
        this.expect('on'); const type = this.name();
        selections.push({ kind: 'fragment', type, selections: this.selections(depth + 1) });
        continue;
      }
      const alias = this.name(), name = this.take(':') ? this.name() : alias;
      const args: Record<string, Value> = Object.create(null);
      if (this.take('(')) {
        while (!this.take(')')) { const key = this.name(); this.expect(':'); args[key] = this.value(); }
      }
      selections.push({ kind: 'field', name, alias, args, selections: this.peek().text === '{' ? this.selections(depth + 1) : [] });
    }
    if (!selections.length) throw new Error('A selection set must contain a field');
    return selections;
  }
  document(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'end') {
      if (this.peek().text === '{') { operations.push({ kind: 'query', variables: [], selections: this.selections() }); continue; }
      const kind = this.name();
      if (kind !== 'query' && kind !== 'mutation') throw new Error(`Unsupported operation '${kind}'`);
      const name = this.peek().kind === 'name' ? this.name() : undefined, variables: Variable[] = [];
      if (this.take('(')) {
        while (!this.take(')')) {
          this.expect('$'); const variableName = this.name(); this.expect(':'); const type = this.type();
          const defaultValue = this.take('=') ? this.value() : undefined;
          if (variables.some(v => v.name === variableName)) throw new Error(`Duplicate variable '$${variableName}'`);
          variables.push({ name: variableName, type, defaultValue });
        }
      }
      operations.push({ kind, name, variables, selections: this.selections() });
    }
    if (!operations.length) throw new Error('GraphQL query is empty');
    return operations;
  }
}

/** Output types also supply the introspection field lists and pre-execution validation. */
const FIELDS: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Node: { id: 'ID' },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String' },
  PullRequest: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState', merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', files: 'PullRequestChangedFileConnection' },
  IssueComment: { id: 'ID', body: 'String' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  PullRequestChangedFile: { path: 'String' },
  PageInfo: { hasNextPage: 'Boolean', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue' }, CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' }, MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' }, IssueCommentEdge: { node: 'IssueComment' },
  __Type: { name: 'String', kind: '__TypeKind', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String' }, __EnumValue: { name: 'String' },
};
const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'], IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};
const INPUTS: Record<string, readonly string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body'], CloseIssueInput: ['issueId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod'], AddCommentInput: ['subjectId', 'body'],
  IssueOrder: ['field', 'direction'],
};
const SCALARS = new Set(['ID', 'String', 'Int', 'Boolean']);
const own = (record: object, key: string): boolean => Object.hasOwn(record, key);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function evaluate(value: Value, variables: Record<string, unknown>): unknown {
  if (value.kind === 'literal') return value.value;
  if (value.kind === 'variable') {
    if (!own(variables, value.name)) throw new Error(`Variable '$${value.name}' is not defined`);
    return variables[value.name];
  }
  if (value.kind === 'list') return value.values.map(v => evaluate(v, variables));
  return Object.fromEntries(Object.entries(value.fields).map(([key, v]) => [key, evaluate(v, variables)]));
}
function coerceVariable(value: unknown, type: TypeRef, name: string): unknown {
  if (value === null || value === undefined) {
    if (type.nonNull) throw new Error(`Variable '$${name}' is required`);
    return null;
  }
  if (type.element) return (Array.isArray(value) ? value : [value]).map(v => coerceVariable(v, type.element!, name));
  const typeName = type.name!;
  const valid = typeName === 'String' ? typeof value === 'string' : typeName === 'ID' ? typeof value === 'string' || Number.isSafeInteger(value)
    : typeName === 'Int' ? Number.isInteger(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647
    : typeName === 'Boolean' ? typeof value === 'boolean' : own(ENUMS, typeName) ? ENUMS[typeName].includes(String(value))
    : own(INPUTS, typeName) ? isRecord(value) && Object.keys(value).every(key => INPUTS[typeName].includes(key)) : false;
  if (!valid) throw new Error(`Variable '$${name}' has an invalid value for type '${typeName}'`);
  return typeName === 'ID' ? String(value) : value;
}
function validate(selections: Selection[], type: string, errors: { message: string }[], variables: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (!own(FIELDS, selection.type)) errors.push({ message: `Unknown type '${selection.type}'` });
      else validate(selection.selections, selection.type, errors, variables);
      continue;
    }
    const fieldType = selection.name === '__typename' ? 'String' : own(FIELDS[type], selection.name) ? FIELDS[type][selection.name] : undefined;
    if (!fieldType) { errors.push({ message: `Field '${selection.name}' doesn't exist on type '${type}'` }); continue; }
    try { for (const value of Object.values(selection.args)) evaluate(value, variables); }
    catch (e) { errors.push({ message: e instanceof Error ? e.message : String(e) }); }
    if (own(FIELDS, fieldType)) {
      if (!selection.selections.length) errors.push({ message: `Field '${selection.name}' requires a selection set` });
      else validate(selection.selections, fieldType, errors, variables);
    } else if (selection.selections.length) errors.push({ message: `Field '${selection.name}' cannot have a selection set` });
  }
}

interface GraphObject { type: string; value: unknown; repo?: Repo }
const object = (type: string, value: unknown, repo?: Repo): GraphObject => ({ type, value, repo });
function node(id: unknown): GraphObject | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id); if (!decoded) return null;
  if (decoded.type === 'User' && decoded.number === undefined) {
    const user = store.scenario.users.find(u => u.id === decoded.dbId); return user ? object('User', user) : null;
  }
  const repo = store.reposById.get(decoded.dbId); if (!repo) return null;
  if (decoded.type === 'Repository' && decoded.number === undefined) return object('Repository', repo, repo);
  if (decoded.number === undefined) return null;
  if (decoded.type === 'Issue') { const issue = repo.issues.get(decoded.number); return issue ? object('Issue', issue, repo) : null; }
  if (decoded.type === 'PullRequest') { const pr = repo.pullRequests.get(decoded.number); return pr ? object('PullRequest', pr, repo) : null; }
  if (decoded.type === 'IssueComment') {
    for (const issue of repo.issues.values()) { const comment = issue.comments.find(c => c.id === decoded.number); if (comment) return object('IssueComment', comment, repo); }
  }
  return null;
}
function inputNode(id: unknown, type: string, field: string): GraphObject {
  const found = node(id);
  if (!found || found.type !== type) throw new Error(`Invalid ${field}: ${type} does not exist`);
  return found;
}
function introspect(name: string): GraphObject | null {
  const kind = own(FIELDS, name) ? name === 'Node' ? 'INTERFACE' : 'OBJECT' : own(ENUMS, name) ? 'ENUM'
    : SCALARS.has(name) ? 'SCALAR' : own(INPUTS, name) ? 'INPUT_OBJECT' : null;
  if (!kind) return null;
  return object('__Type', { name, kind,
    fields: kind === 'OBJECT' || kind === 'INTERFACE' ? Object.keys(FIELDS[name]).map(name => object('__Field', { name })) : null,
    enumValues: kind === 'ENUM' ? ENUMS[name].map(name => object('__EnumValue', { name })) : null,
  });
}
function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}
function connection(type: string, nodes: GraphObject[], args: Record<string, unknown>, numberOf: (node: GraphObject) => number): GraphObject {
  let start = 0;
  if (args.after !== undefined && args.after !== null) {
    if (typeof args.after !== 'string') throw new Error('Invalid after cursor');
    const match = /^cursor:(\d+)$/.exec(Buffer.from(args.after, 'base64').toString());
    if (!match) throw new Error('Invalid after cursor');
    const index = nodes.findIndex(n => numberOf(n) === Number(match[1]));
    if (index < 0) throw new Error('Invalid after cursor');
    start = index + 1;
  }
  const first = args.first === undefined || args.first === null ? 30 : args.first;
  if (typeof first !== 'number' || !Number.isSafeInteger(first) || first < 0) throw new Error('first must be a non-negative integer');
  const page = nodes.slice(start, start + first), last = page.at(-1);
  return object(type, { nodes: page, pageInfo: object('PageInfo', {
    hasNextPage: start + page.length < nodes.length,
    endCursor: last ? Buffer.from(`cursor:${numberOf(last)}`).toString('base64') : null,
  }) });
}
function resolve(parent: GraphObject, field: string, args: Record<string, unknown>): unknown {
  if (field === '__typename') return parent.type;
  if (parent.type === 'Query') {
    if (field === 'viewer') return object('User', viewer);
    if (field === 'node') return node(requiredString(args.id, 'id'));
    if (field === '__type') return introspect(requiredString(args.name, 'name'));
    if (field === 'repository') {
      const owner = requiredString(args.owner, 'owner'), name = requiredString(args.name, 'name');
      try { const repo = getRepo(owner, name); return object('Repository', repo, repo); }
      catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e; }
    }
  }
  if (parent.type === 'Mutation') {
    if (!isRecord(args.input)) throw new Error(`Field '${field}' requires an input object`);
    const input = args.input;
    if (field === 'createIssue' || field === 'createPullRequest') {
      const target = inputNode(input.repositoryId, 'Repository', 'repositoryId'), repo = target.repo!;
      if (field === 'createIssue') return object('CreateIssuePayload', { issue: object('Issue', createIssue(repo, input), repo) });
      const pr = createPullRequest(repo, { ...input, head: input.headRefName, base: input.baseRefName });
      return object('CreatePullRequestPayload', { pullRequest: object('PullRequest', pr, repo) });
    }
    if (field === 'closeIssue') {
      const target = inputNode(input.issueId, 'Issue', 'issueId');
      return object('CloseIssuePayload', { issue: object('Issue', patchIssue(target.value as Issue, { state: 'closed' }), target.repo) });
    }
    if (field === 'mergePullRequest') {
      const target = inputNode(input.pullRequestId, 'PullRequest', 'pullRequestId');
      mergePullRequest(target.repo!, target.value as PullRequest, input.mergeMethod === undefined ? 'merge' : requiredString(input.mergeMethod, 'mergeMethod').toLowerCase());
      return object('MergePullRequestPayload', { pullRequest: target });
    }
    if (field === 'addComment') {
      const target = inputNode(input.subjectId, 'Issue', 'subjectId'), comment = addComment(target.value as Issue, input.body);
      return object('AddCommentPayload', { commentEdge: object('IssueCommentEdge', { node: object('IssueComment', comment, target.repo) }) });
    }
  }
  if (parent.type === 'Repository') {
    const repo = parent.repo!;
    if (field === 'id') return encodeGlobalId('Repository', repo.dbId);
    if (field === 'databaseId') return repo.dbId;
    if (field === 'nameWithOwner') return `${viewer.login}/${repo.name}`;
    if (field === 'owner') return object('User', viewer);
    if (field === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip && repo.objects.get(tip)?.type === 'commit' ? object('Ref', { name: repo.defaultBranch }) : null;
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issue') { const issue = repo.issues.get(positiveNumber(args.number, 'number')); return issue ? object('Issue', issue, repo) : null; }
    if (field === 'pullRequest') { const pr = repo.pullRequests.get(positiveNumber(args.number, 'number')); return pr ? object('PullRequest', pr, repo) : null; }
    if (field === 'issues') {
      let issues = [...repo.issues.values()];
      if (args.states !== undefined && args.states !== null) {
        const states = Array.isArray(args.states) ? args.states : [args.states];
        if (states.some(state => state !== 'OPEN' && state !== 'CLOSED')) throw new Error('Invalid issues states');
        issues = issues.filter(i => states.includes(i.state.toUpperCase()));
      }
      if (args.orderBy !== undefined && args.orderBy !== null) {
        if (!isRecord(args.orderBy) || args.orderBy.field !== 'CREATED_AT' || !['ASC', 'DESC'].includes(String(args.orderBy.direction))) throw new Error('Invalid issues orderBy');
        const sign = args.orderBy.direction === 'DESC' ? -1 : 1;
        issues.sort((a, b) => sign * (a.created_at.localeCompare(b.created_at) || a.number - b.number));
      } else issues.sort((a, b) => a.number - b.number);
      return connection('IssueConnection', issues.map(i => object('Issue', i, repo)), args, n => (n.value as Issue).number);
    }
    if (field === 'pullRequests') return connection('PullRequestConnection', [...repo.pullRequests.values()].sort((a, b) => a.number - b.number).map(p => object('PullRequest', p, repo)), args, n => (n.value as PullRequest).number);
  }
  if (parent.type === 'Issue') {
    const issue = parent.value as Issue;
    if (field === 'id') return encodeGlobalId('Issue', parent.repo!.dbId, issue.number);
    if (field === 'state') return issue.state.toUpperCase();
  }
  if (parent.type === 'PullRequest') {
    const pr = parent.value as PullRequest, repo = parent.repo!;
    if (field === 'id') return encodeGlobalId('PullRequest', repo.dbId, pr.number);
    if (field === 'state') return pr.merged ? 'MERGED' : pr.state.toUpperCase();
    if (field === 'headRefName') return pr.head.ref;
    if (field === 'baseRefName') return pr.base.ref;
    if (field === 'mergeable') {
      const head = repo.refs.get(`refs/heads/${pr.head.ref}`), base = repo.refs.get(`refs/heads/${pr.base.ref}`);
      return head && base && !threeWayMerge(repo, head, base).conflicts.length ? 'MERGEABLE' : 'CONFLICTING';
    }
    if (field === 'files') return connection('PullRequestChangedFileConnection', pullFiles(repo, pr).map((file, i) => object('PullRequestChangedFile', { path: file.filename, index: i + 1 })), args, n => (n.value as { index: number }).index);
  }
  if (parent.type === 'IssueComment' && field === 'id') return encodeGlobalId('IssueComment', parent.repo!.dbId, (parent.value as Comment).id);
  if (parent.type === 'User' && field === 'id') return encodeGlobalId('User', (parent.value as { id: number }).id);
  return (parent.value as Record<string, unknown>)[field] ?? null;
}

function project(parent: GraphObject, selections: Selection[], variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  // Collect repeated fields once so a repeated mutation field cannot run twice.
  const fields = new Map<string, Extract<Selection, { kind: 'field' }>>();
  const collect = (selections: Selection[]): void => {
    for (const selection of selections) {
      if (selection.kind === 'fragment') { if (selection.type === parent.type || selection.type === 'Node') collect(selection.selections); continue; }
      const previous = fields.get(selection.alias);
      fields.set(selection.alias, previous ? { ...previous, selections: [...previous.selections, ...selection.selections] } : selection);
    }
  };
  collect(selections);
  for (const field of fields.values()) {
    try {
      const args = Object.fromEntries(Object.entries(field.args).map(([key, value]) => [key, evaluate(value, variables)]));
      const value = resolve(parent, field.name, args);
      const select = (value: unknown): unknown => value === null || value === undefined ? null
        : field.selections.length ? project(value as GraphObject, field.selections, variables, errors) : value;
      result[field.alias] = Array.isArray(value) ? value.map(select) : select(value);
    } catch (e) {
      errors.push({ message: `Field '${field.name}': ${e instanceof Error ? e.message : String(e)}` }); result[field.alias] = null;
    }
  }
  return result;
}

/** One operation result; batched documents share store state and execute in body order. */
export function executeGraphQL(body: unknown): { data: unknown; errors?: { message: string }[] } {
  try {
    if (!isRecord(body) || typeof body.query !== 'string') throw new Error('query must be a GraphQL document string');
    if (body.variables !== undefined && body.variables !== null && !isRecord(body.variables)) throw new Error('variables must be an object');
    if (body.operationName !== undefined && body.operationName !== null && typeof body.operationName !== 'string') throw new Error('operationName must be a string');
    const operations = new Parser(body.query).document();
    const operation = body.operationName != null ? operations.find(op => op.name === body.operationName) : operations.length === 1 ? operations[0] : undefined;
    if (!operation) throw new Error(body.operationName != null ? `Unknown operation '${String(body.operationName)}'` : 'operationName is required for multiple operations');
    const given = isRecord(body.variables) ? body.variables : {}, variables: Record<string, unknown> = Object.create(null);
    for (const variable of operation.variables) {
      const value = own(given, variable.name) ? given[variable.name] : variable.defaultValue ? evaluate(variable.defaultValue, {}) : undefined;
      variables[variable.name] = coerceVariable(value, variable.type, variable.name);
    }
    const errors: { message: string }[] = [], type = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    validate(operation.selections, type, errors, variables);
    if (errors.length) return { data: null, errors };
    const data = project(object(type, {}), operation.selections, variables, errors);
    return errors.length ? { data, errors } : { data };
  } catch (e) { return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] }; }
}
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try { body = JSON.parse((await readBody(req)).toString()); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Malformed JSON body'); }
  sendJson(res, 200, Array.isArray(body) ? body.map(executeGraphQL) : executeGraphQL(body));
}
