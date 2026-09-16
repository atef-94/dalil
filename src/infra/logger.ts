// Structured JSON request logs. 500-level errors additionally log the real
// error message and stack trace server-side while the client only ever sees
// a generic message when NODE_ENV=production.
export interface RequestLogFields {
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip: string;
}

export function logRequest(fields: RequestLogFields): void {
  process.stdout.write(JSON.stringify(fields) + '\n');
}

export function logServerError(err: unknown, context: RequestLogFields): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  process.stderr.write(
    JSON.stringify({ ...context, level: 'error', message, stack }) + '\n',
  );
}
