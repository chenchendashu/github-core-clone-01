import { createServer, type Server } from 'node:http';
import { getRepo, HttpError, sendJson } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** One server and one shared in-memory forge; listening is the entry point's responsibility. */
export function createApp(): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://forge'), path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      const rest = path === '/api/v3' || path.startsWith('/api/v3/');
      const git = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      const protectedRoute = rest || path === '/api/graphql' || path === '/mcp' || git !== null;
      const publicRoute = req.method === 'GET' && ['/api/v3', '/api/v3/', '/api/v3/meta'].includes(path);
      const token = process.env.MAKEFUN_SHOP_TOKEN;
      if (protectedRoute && !publicRoute && token !== undefined && req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, 'Bad credentials');
      if (rest) { await handleRest(req, res, url); return; }
      if (req.method === 'POST' && path === '/api/graphql') { await handleGraphQL(req, res); return; }
      if (req.method === 'POST' && path === '/mcp') { await handleMcp(req, res); return; }
      if (git) { await handleGit(req, res, getRepo(decodeURIComponent(git[1]), decodeURIComponent(git[2])), git[3], url); return; }
      sendJson(res, 404, { message: 'Not Found' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, e instanceof HttpError ? e.status : 400, { message: e instanceof HttpError ? e.message : 'Bad Request' });
      else res.end();
    }
  });
}
