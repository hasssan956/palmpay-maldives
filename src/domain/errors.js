// Domain errors carry a stable machine code. The HTTP layer maps them to
// status codes; clients key their copy off `code`, never off `message`.

export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what) => new DomainError(`${what}_not_found`, `${what.replace(/_/g, ' ')} not found`, { status: 404 });
export const invalid = (message, details) => new DomainError('invalid_request', message, { status: 422, details });
export const conflict = (code, message, details) => new DomainError(code, message, { status: 409, details });
