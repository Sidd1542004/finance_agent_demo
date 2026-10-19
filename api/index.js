// Vercel serverless function: the whole Express API as one function.
//
// vercel.json rewrites /api/<path>?<query> to /api?__path=<path>&<query>, so
// every API route reaches this one file. The original path is put back on
// req.url before Express sees it.

import { app } from '../server/src/app.js';

export function restorePath(url) {
  const parsed = new URL(url || '/', 'http://localhost');
  const original = parsed.searchParams.get('__path');
  if (original === null) return url;
  parsed.searchParams.delete('__path');
  const query = parsed.searchParams.toString();
  return `/api/${original.replace(/^\/+/, '')}${query ? `?${query}` : ''}`;
}

export default function handler(req, res) {
  req.url = restorePath(req.url);
  return app(req, res);
}
