// An error whose message is safe to show the client — the central error
// handler in server.js answers it with its own status instead of a bare 500.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}
