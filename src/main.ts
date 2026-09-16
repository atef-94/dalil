import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApplication } from './app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const port = Number(process.env.PORT ?? 3000);
  const tokenSecret = process.env.TOKEN_SECRET ?? 'dev-secret';
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const { httpServer, services } = await buildApplication({
    nodeEnv,
    tokenSecret,
    allowedOrigins,
    staticDir: join(__dirname, '..', 'public'),
  });

  const server = httpServer.listen(port);
  process.stdout.write(`ACTIVE Operating System listening on :${port} (${nodeEnv})\n`);

  const sweepInterval = setInterval(() => {
    void services.finance.sweepOverdue();
  }, 60_000);
  sweepInterval.unref();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`received ${signal}, shutting down gracefully\n`);
    clearInterval(sweepInterval);
    const forceExit = setTimeout(() => {
      process.stdout.write('graceful shutdown timed out after 10s, forcing exit\n');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    httpServer
      .close()
      .then(() => {
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
