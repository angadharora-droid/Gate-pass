// Express 4 does not forward rejected promises from async handlers to the
// central error handler — this wrapper does, so a DB failure returns a clean
// JSON 500 instead of crashing the process with an unhandled rejection.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
