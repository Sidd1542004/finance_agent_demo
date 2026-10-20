// Vercel Routing Middleware. Runs before every request on Vercel, including
// the static dashboard files, which are served without reaching the Express
// app. When ACCESS_PASSWORD is set, it asks for it (HTTP Basic auth, any user
// name). Returning nothing lets the request continue.
//
// Locally, the Express app does the same check (server/src/app.js).

import { accessAllowed, CHALLENGE_HEADERS, CHALLENGE_TEXT } from './server/src/accessAuth.js';

export default function middleware(request) {
  const password = process.env.ACCESS_PASSWORD;
  if (!password) return undefined;
  const { pathname } = new URL(request.url);
  if (accessAllowed({ password, path: pathname, authorization: request.headers.get('authorization') })) return undefined;
  return new Response(CHALLENGE_TEXT, { status: 401, headers: { ...CHALLENGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}
