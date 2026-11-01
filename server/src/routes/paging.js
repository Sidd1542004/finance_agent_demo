// Cursor pagination now lives in services/paging.js, so routes and the
// services that list records share it. Kept here for existing imports.

export { PAGE, pageParams, pageOf } from '../services/paging.js';
