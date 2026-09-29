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

  static badRequest(
    detail: string,
    errors?: ProblemFieldError[],
    code = 'BAD_REQUEST',
  ): ProblemError {
    return new ProblemError({
      status: 400,
      title: 'Bad Request',
      code,
      detail,
      errors,
    });
  }

  static unauthorized(
    detail = 'Missing or invalid credentials',
    code = 'UNAUTHORIZED',
  ): ProblemError {
    return new ProblemError({
      status: 401,
      title: 'Unauthorized',
      code,
      detail,
    });
  }

  static forbidden(detail = 'Authenticated but not allowed', code = 'FORBIDDEN'): ProblemError {
    return new ProblemError({
      status: 403,
      title: 'Forbidden',
      code,
      detail,
    });
  }

  static notFound(detail = 'Resource not found', code = 'NOT_FOUND'): ProblemError {
    return new ProblemError({
      status: 404,
      title: 'Not Found',
      code,
      detail,
    });
  }

  static conflict(detail: string, code = 'CONFLICT'): ProblemError {
    return new ProblemError({
      status: 409,
      title: 'Conflict',
      code,
      detail,
    });
  }

  static tooManyRequests(retryAfterSeconds: number, detail = 'Rate limit exceeded'): ProblemError {
    return new ProblemError({
      status: 429,
      title: 'Too Many Requests',
      code: 'RATE_LIMIT_EXCEEDED',
      detail,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
    });
  }
}
