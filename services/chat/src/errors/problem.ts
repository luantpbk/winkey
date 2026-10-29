export interface ProblemFieldError {
  field: string;
  message: string;
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: ProblemFieldError[];
}

export class ProblemError extends Error {
  public readonly status: number;
  public readonly type: string;
  public readonly title: string;
  public readonly detail?: string;
  public readonly code?: string;
  public readonly errors?: ProblemFieldError[];
  public readonly headers?: Record<string, string>;

  constructor(options: {
    status: number;
    title: string;
    type?: string;
    detail?: string;
    code?: string;
    errors?: ProblemFieldError[];
    headers?: Record<string, string>;
  }) {
    super(options.detail || options.title);
    this.status = options.status;
    this.title = options.title;
    this.type =
      options.type ||
      `https://winkey.vn/problems/${options.code?.toLowerCase().replace(/_/g, '-') || options.status}`;
    this.detail = options.detail;
    this.code = options.code;
    this.errors = options.errors;
    this.headers = options.headers;
  }

  toProblemDocument(instance?: string): ProblemDocument {
    const doc: ProblemDocument = {
      type: this.type,
      title: this.title,
      status: this.status,
    };
    if (this.detail) doc.detail = this.detail;
    if (this.code) doc.code = this.code;
    if (this.errors && this.errors.length > 0) doc.errors = this.errors;
    if (instance) doc.instance = instance;
    return doc;
  }

  static badRequest(detail: string, code?: string, errors?: ProblemFieldError[]): ProblemError {
    return new ProblemError({
      status: 400,
      title: 'Bad Request',
      detail,
      code,
      errors,
    });
  }

  static unauthorized(detail = 'Authentication required', code?: string): ProblemError {
    return new ProblemError({
      status: 401,
      title: 'Unauthorized',
      detail,
      code,
    });
  }

  static forbidden(detail = 'Access forbidden', code?: string): ProblemError {
    return new ProblemError({
      status: 403,
      title: 'Forbidden',
      detail,
      code,
    });
  }

  static notFound(detail = 'Resource not found', code?: string): ProblemError {
    return new ProblemError({
      status: 404,
      title: 'Not Found',
      detail,
      code,
    });
  }

  static conflict(detail: string, code?: string): ProblemError {
    return new ProblemError({
      status: 409,
      title: 'Conflict',
      detail,
      code,
    });
  }

  static tooManyRequests(retryAfterSeconds = 60, detail = 'Rate limit exceeded'): ProblemError {
    return new ProblemError({
      status: 429,
      title: 'Too Many Requests',
      detail,
      code: 'RATE_LIMITED',
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
    });
  }

  static internal(detail = 'An internal server error occurred'): ProblemError {
    return new ProblemError({
      status: 500,
      title: 'Internal Server Error',
      detail,
      code: 'INTERNAL_ERROR',
    });
  }
}
