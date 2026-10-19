// Cursor pagination for the record lists, newest first:
//   ?before=<ISO createdAt>&limit=<n>   (limit: default 50, at most 200)
// Answers { items, nextCursor }. nextCursor is the createdAt of the last item,
// or null on the last page. Records created in the same millisecond as the
// last one are all kept on the same page, so a page boundary never skips one.

import { HttpError } from '../services/runs.js';

export const PAGE = { default: 50, max: 200 };

export function pageParams(query = {}) {
  let before = null;
  if (query.before !== undefined && query.before !== '') {
    before = new Date(String(query.before));
    if (Number.isNaN(before.getTime())) throw new HttpError(400, '"before" must be a date and time, as given in nextCursor.');
  }
  const n = Math.floor(Number(query.limit));
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, PAGE.max) : PAGE.default;
  return { before, limit };
}

/**
 * One page of `Model` matching `filter`.
 * @param select fields to return; `map` turns each document into a list item
 */
export async function pageOf(Model, filter, { before, limit }, { select, map = (d) => d } = {}) {
  const where = before ? { ...filter, createdAt: { $lt: before } } : filter;
  const docs = await Model.find(where)
    .select(select)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  if (docs.length <= limit) return { items: docs.map(map), nextCursor: null };

  const page = docs.slice(0, limit);
  const boundary = page[page.length - 1].createdAt;
  // Others created at exactly the same time as the last item on this page.
  const ties = await Model.find({ ...filter, createdAt: boundary, _id: { $nin: page.map((d) => d._id) } })
    .select(select)
    .sort({ _id: -1 })
    .lean();
  const items = [...page, ...ties];
  // Nothing older than the boundary: this was the last page after all.
  const more = await Model.exists({ ...filter, createdAt: { $lt: boundary } });
  return { items: items.map(map), nextCursor: more ? new Date(boundary).toISOString() : null };
}
