// The services' check that an authenticated actor with the right role is
// acting (see auth/roles.js). Every service function that changes something
// on a person's behalf calls it first, whatever the route already checked.

import { actorProblem } from '../auth/roles.js';
import { HttpError } from './runs.js';

/** The actor, if it may act with one of `roles`; otherwise an HttpError (401 or 403). */
export function requireActor(actor, ...roles) {
  const problem = actorProblem(actor, ...roles);
  if (problem) throw new HttpError(problem.status, problem.message);
  return actor;
}
