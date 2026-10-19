// Cursor pagination for the record lists: every record exactly once, newest
// first, even when several were created in the same millisecond.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pageOf, pageParams, PAGE } from '../src/routes/paging.js';

// Just enough of a Mongoose model, over an array, for pageOf.
function fakeModel(docs) {
  const t = (v) => (v instanceof Date ? v.getTime() : v);
  const matches = (d, where) =>
    Object.entries(where).every(([k, cond]) => {
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('$lt' in cond && !(t(d[k]) < t(cond.$lt))) return false;
        if ('$nin' in cond && cond.$nin.includes(d[k])) return false;
        if ('$in' in cond && !cond.$in.includes(d[k])) return false;
        return true;
      }
      return t(d[k]) === t(cond);
    });
  const query = (where) => {
    let out = docs.filter((d) => matches(d, where));
    const chain = {
      select: () => chain,
      sort: (spec) => {
        const keys = Object.entries(spec);
        out = [...out].sort((a, b) => {
          for (const [k, dir] of keys) if (t(a[k]) !== t(b[k])) return (t(a[k]) < t(b[k]) ? -1 : 1) * dir;
          return 0;
        });
        return chain;
      },
      limit: (n) => {
        out = out.slice(0, n);
        return chain;
      },
      lean: async () => out.map((d) => ({ ...d })),
    };
    return chain;
  };
  return { find: query, exists: async (where) => docs.some((d) => matches(d, where)) };
}

const at = (minute, ms = 0) => new Date(Date.UTC(2026, 9, 1, 0, minute, 0, ms));

async function everyPage(Model, filter, limit) {
  const pages = [];
  let before = null;
  for (let i = 0; i < 50; i += 1) {
    const page = await pageOf(Model, filter, { before, limit });
    pages.push(page);
    if (!page.nextCursor) break;
    before = new Date(page.nextCursor);
  }
  return pages;
}

test('pages cover every record once, newest first', async () => {
  const docs = Array.from({ length: 23 }, (_, i) => ({ _id: `id${String(i).padStart(2, '0')}`, createdAt: at(i), status: i % 3 ? 'needs_review' : 'approved' }));
  const pages = await everyPage(fakeModel(docs), {}, 10);
  assert.deepEqual(
    pages.map((p) => p.items.length),
    [10, 10, 3],
  );
  const ids = pages.flatMap((p) => p.items.map((d) => d._id));
  assert.equal(new Set(ids).size, 23);
  assert.deepEqual(
    ids,
    [...docs].reverse().map((d) => d._id),
  );
  assert.equal(pages[0].nextCursor, at(13).toISOString());
  assert.equal(pages.at(-1).nextCursor, null);
});

test('records created in the same millisecond are never split across pages or skipped', async () => {
  const docs = [];
  for (let i = 0; i < 6; i += 1) docs.push({ _id: `a${i}`, createdAt: at(5) }); // six at the same instant
  for (let i = 0; i < 4; i += 1) docs.push({ _id: `b${i}`, createdAt: at(9 - i) });
  for (let i = 0; i < 3; i += 1) docs.push({ _id: `c${i}`, createdAt: at(1, i) });
  const pages = await everyPage(fakeModel(docs), {}, 5);
  const ids = pages.flatMap((p) => p.items.map((d) => d._id));
  assert.equal(ids.length, docs.length, 'nothing lost');
  assert.equal(new Set(ids).size, docs.length, 'nothing twice');
  assert.ok(
    pages.some((p) => p.items.filter((d) => d._id.startsWith('a')).length === 6),
    'the six stay together',
  );
});

test('a filter applies to every page; an exact last page has no cursor', async () => {
  const docs = Array.from({ length: 12 }, (_, i) => ({ _id: `id${i}`, createdAt: at(i), status: i < 4 ? 'approved' : 'needs_review' }));
  const pages = await everyPage(fakeModel(docs), { status: { $in: ['approved'] } }, 4);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].items.length, 4);
  assert.equal(pages[0].nextCursor, null);
});

test('page parameters: default 50, at most 200, and a clear error for a bad cursor', () => {
  assert.deepEqual(pageParams({}), { before: null, limit: PAGE.default });
  assert.equal(PAGE.default, 50);
  assert.equal(pageParams({ limit: '500' }).limit, 200);
  assert.equal(pageParams({ limit: '0' }).limit, 50);
  assert.equal(pageParams({ limit: 'many' }).limit, 50);
  assert.equal(pageParams({ before: '2026-10-01T00:05:00.000Z' }).before.toISOString(), '2026-10-01T00:05:00.000Z');
  assert.throws(
    () => pageParams({ before: 'yesterday-ish' }),
    (err) => err.status === 400 && /nextCursor/.test(err.message),
  );
});
