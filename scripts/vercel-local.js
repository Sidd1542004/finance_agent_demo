// Run the app the way Vercel does, on one port, without the Vercel CLI:
//   - middleware.js runs first (the optional ACCESS_PASSWORD check);
//   - files in client/dist are served as static files;
//   - /api/<path>?<query> is rewritten to /api?__path=<path>&<query> and handed
//     to the serverless function in api/index.js (see vercel.json);
//   - anything else gets client/dist/index.html.
//
//   npm run build --prefix client
//   MONGODB_URI=mongodb://127.0.0.1:27017/finance_agent_verify node scripts/vercel-local.js
//
// PORT defaults to 3000. Environment variables are read the same way as on Vercel.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import handler from '../api/index.js';
import middleware from '../middleware.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'client', 'dist');
const port = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendFile(res, file) {
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const stop = await middleware(new Request(url, { headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string') }));
    if (stop) {
      res.writeHead(stop.status, Object.fromEntries(stop.headers));
      return res.end(await stop.text());
    }
    // Vercel serves files from the output directory before applying rewrites.
    const file = path.join(dist, decodeURIComponent(url.pathname));
    if (file.startsWith(dist) && url.pathname !== '/' && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);

    // "/api/:path*" -> "/api?__path=:path*"
    const api = url.pathname.match(/^\/api(?:\/(.*))?$/);
    if (api) {
      const query = new URLSearchParams(url.search);
      query.delete('__path');
      req.url = `/api?__path=${encodeURIComponent(api[1] || '')}${query.toString() ? `&${query}` : ''}`;
      return handler(req, res);
    }

    // "/((?!api/).*)" -> "/index.html"
    const index = path.join(dist, 'index.html');
    if (!fs.existsSync(index)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('client/dist is missing. Run: npm run build --prefix client');
    }
    return sendFile(res, index);
  })
  .listen(port, () => console.log(`Vercel-style local server on http://localhost:${port}`));
