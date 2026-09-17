// Every thrown error that carries a numeric `.status` property is resolved to
// that HTTP status by the router's generic catch-all — this keeps the
// framework-agnostic HTTP layer free of imports from domain error types.

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export class TokenError extends HttpError {
  constructor(message: string) {
    super(401, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

export class RateLimitError extends HttpError {
  constructor(message: string) {
    super(429, message);
  }
}

// Business errors default to 409 Conflict (the common case: state-machine
// violations) but allow a specific status where the situation calls for one
// (e.g. 404 when the referenced unit does not exist).
export class InventoryError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message);
  }
}
export class SalesError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message);
  }
}
export class FinanceError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message);
  }
}
export class BrokerError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message);
  }
}
export class OrgValidationError extends ValidationError {}
export class HrError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message);
  }
}
export class OperationsError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message);
  }
}
export class LegalError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message);
  }
}
export class PurchasingError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message);
  }
}
export class AutomationError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message);
  }
}
