import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { NextFunction, Request, Response } from 'express';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_TAIL_BYTES = 512 * 1024;
const LOG_FILE_NAME = 'api-errors.log';

type DiagnosticRecord = {
  timestamp: string;
  event: string;
  request_id?: string;
  method?: string;
  route?: string;
  status?: number;
  duration_ms?: number;
  stage?: string;
  error?: {
    name: string;
    message: string;
    code?: string;
    errno?: number;
    stack?: string;
    cause?: string;
  };
  metadata?: Record<string, string | number | boolean | null>;
};

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"'\]]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 12000);
}

function safeError(error: unknown): DiagnosticRecord['error'] {
  if (error instanceof Error) {
    const extended = error as Error & { code?: unknown; errno?: unknown; cause?: unknown };
    const cause = extended.cause instanceof Error
      ? redactText(extended.cause.message)
      : typeof extended.cause === 'string' ? redactText(extended.cause) : undefined;
    return {
      name: redactText(error.name || 'Error').slice(0, 120),
      message: redactText(error.message || 'Unknown error').slice(0, 2000),
      ...(typeof extended.code === 'string' ? { code: extended.code.slice(0, 120) } : {}),
      ...(typeof extended.errno === 'number' ? { errno: extended.errno } : {}),
      ...(error.stack ? { stack: redactText(error.stack) } : {}),
      ...(cause ? { cause } : {}),
    };
  }
  return { name: 'UnknownError', message: redactText(String(error)).slice(0, 2000) };
}

function rotateLog(filePath: string): void {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < MAX_LOG_BYTES) return;
    const firstBackup = `${filePath}.1`;
    const secondBackup = `${filePath}.2`;
    try { if (fs.existsSync(secondBackup)) fs.unlinkSync(secondBackup); } catch { /* best effort */ }
    try { if (fs.existsSync(firstBackup)) fs.renameSync(firstBackup, secondBackup); } catch { /* best effort */ }
    fs.renameSync(filePath, firstBackup);
  } catch {
    // Keep the active log writable when rotation fails.
  }
}

export function getApiDiagnosticLogPath(): string {
  return path.join(app.getPath('userData'), 'logs', LOG_FILE_NAME);
}

/** Writes one bounded JSON-lines record directly to disk, independently of console/electron-log transports. */
export function appendApiDiagnosticRecord(record: DiagnosticRecord): boolean {
  try {
    const filePath = getApiDiagnosticLogPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    rotateLog(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
    return true;
  } catch {
    return false;
  }
}

function getRequestRoute(req: Request): string {
  const routePath = (req as Request & { route?: { path?: string } }).route?.path;
  if (typeof routePath === 'string') {
    return `${req.baseUrl || ''}${routePath.startsWith('/') ? routePath : `/${routePath}`}`.slice(0, 300);
  }
  return String(req.path || '/')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .slice(0, 300);
}

function requestIdFrom(res: Response): string | undefined {
  const value = res.locals?.apiRequestId;
  return typeof value === 'string' ? value : undefined;
}

/** Records a route-level exception with its real stage and stack trace. Never records request bodies. */
export function recordApiDiagnosticError(
  req: Request,
  res: Response,
  stage: string,
  error: unknown,
  metadata?: Record<string, string | number | boolean | null>,
): void {
  appendApiDiagnosticRecord({
    timestamp: new Date().toISOString(),
    event: 'api.exception',
    request_id: requestIdFrom(res),
    method: String(req.method || 'UNKNOWN').slice(0, 12),
    route: getRequestRoute(req),
    status: res.statusCode >= 400 ? res.statusCode : 500,
    stage: stage.slice(0, 100),
    error: safeError(error),
    ...(metadata ? { metadata } : {}),
  });
}

/**
 * Adds a trace ID to every API request and records failed API responses.
 * Runs before body parsing/auth so it also sees parser, auth and middleware failures.
 */
export function apiDiagnosticsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith('/api')) {
    next();
    return;
  }

  const requestId = randomUUID();
  const startedAt = Date.now();
  res.locals.apiRequestId = requestId;
  res.setHeader('X-Lyra-Request-Id', requestId);

  res.once('finish', () => {
    const status = res.statusCode;
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase());
    const isSalesWrite = isWrite && /^\/api\/(?:orders|bills)(?:\/|$)/.test(req.path);
    if (status < 500 && !(isSalesWrite && status >= 400)) return;

    appendApiDiagnosticRecord({
      timestamp: new Date().toISOString(),
      event: 'api.request_failed',
      request_id: requestId,
      method: String(req.method || 'UNKNOWN').slice(0, 12),
      route: getRequestRoute(req),
      status,
      duration_ms: Math.max(0, Date.now() - startedAt),
    });
  });

  next();
}

/** Returns only the newest bounded portion for an authenticated support export. */
export function readApiDiagnosticLog(): string {
  try {
    const filePath = getApiDiagnosticLogPath();
    if (!fs.existsSync(filePath)) return '';
    const size = fs.statSync(filePath).size;
    const handle = fs.openSync(filePath, 'r');
    try {
      const length = Math.min(size, MAX_LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, Math.max(0, size - length));
      const text = buffer.toString('utf8');
      return size > length ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return '';
  }
}
