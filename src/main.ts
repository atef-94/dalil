import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildApplication } from './app.js';
import { openDatabase } from './infra/sqlite-repository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const port = Number(process.env.PORT ?? 3000);
  const tokenSecret = process.env.TOKEN_SECRET ?? 'dev-secret';
  const secretStoreKey = process.env.SECRET_STORE_KEY ?? tokenSecret;
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const dbPath = process.env.SQLITE_PATH ?? join(__dirname, '..', 'data', 'active-os.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  process.stdout.write(`persistent storage: ${dbPath}\n`);

  const { httpServer, services } = await buildApplication({
    nodeEnv,
    tokenSecret,
    secretStoreKey,
    allowedOrigins,
    staticDir: join(__dirname, '..', 'public'),
    db,
    rateLimitWindowMs: process.env.RATE_LIMIT_WINDOW_MS ? Number(process.env.RATE_LIMIT_WINDOW_MS) : undefined,
    rateLimitMax: process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : undefined,
    authRateLimitMax: process.env.AUTH_RATE_LIMIT_MAX ? Number(process.env.AUTH_RATE_LIMIT_MAX) : undefined,
    automationRetryBaseDelayMs: process.env.AUTOMATION_RETRY_BASE_DELAY_MS ? Number(process.env.AUTOMATION_RETRY_BASE_DELAY_MS) : 300,
    automationMaxConcurrentRuns: process.env.AUTOMATION_MAX_CONCURRENT_RUNS ? Number(process.env.AUTOMATION_MAX_CONCURRENT_RUNS) : undefined,
  });

  // Crash recovery: any WorkflowRun left `running` in storage is one that
  // never finished because the process died mid-execution — resume them
  // before accepting traffic so in-flight automation work is never silently
  // lost across a restart (this is what makes the persisted run table a
  // real durable job queue, not just an audit trail).
  const recovered = await services.automation.recoverStuckRuns();
  if (recovered.length > 0) {
    process.stdout.write(`recovered ${recovered.length} workflow run(s) left running by a previous process\n`);
  }

  const server = httpServer.listen(port);
  process.stdout.write(`ACTIVE Operating System listening on :${port} (${nodeEnv})\n`);

  const sweepInterval = setInterval(() => {
    void services.sweepOverdueAndEmit();
  }, 60_000);
  sweepInterval.unref();

  // Scheduled/recurring workflow trigger tick — checks every minute for any
  // active `scheduled` workflow whose interval has elapsed (each workflow
  // tracks its own lastScheduledRunAt, so this can run as often as we like
  // without duplicating work — see AutomationService.runDueScheduledWorkflows).
  const scheduledWorkflowInterval = setInterval(() => {
    void services.automation.runDueScheduledWorkflows();
  }, 60_000);
  scheduledWorkflowInterval.unref();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`received ${signal}, shutting down gracefully\n`);
    clearInterval(sweepInterval);
    clearInterval(scheduledWorkflowInterval);
    const forceExit = setTimeout(() => {
      process.stdout.write('graceful shutdown timed out after 10s, forcing exit\n');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    httpServer
      .close()
      .then(() => {
        db.close();
        clearTimeout(forceExit);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  void server;
}

main().catch((err) => {
  process.stderr.write(`fatal startup error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
