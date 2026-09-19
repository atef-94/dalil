import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { HttpError } from './errors.js';
import { logRequest, logServerError } from './logger.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';
import { parseMultipart } from './multipart.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RequestContext {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  headers: IncomingMessage['headers'];
  ip: string;
}

export type RouteHandler = (ctx: RequestContext) => Promise<{ status: number; body?: unknown } | void>;

interface Route {
  method: HttpMethod;
  segments: string[];
  handler: RouteHandler;
  maxBodyBytes?: number;
}

export interface RouteOptions {
  /** Overrides the default MAX_BODY_BYTES cap for this one route — used by
   * file-import routes, which legitimately receive multi-megabyte
   * Excel/PDF uploads that would otherwise be rejected as "too large" by
   * the same cap that protects every ordinary JSON route from abuse. */
  maxBodyBytes?: number;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB cap for ordinary JSON routes
// File-import routes (Lead/Inventory/Payment) accept real spreadsheet/PDF
// uploads — 25MB comfortably covers a large Excel workbook or a
// multi-page PDF export while still bounding worst-case memory use.
export const IMPORT_MAX_BODY_BYTES = 25 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface HttpServerOptions {
  staticDir?: string;
  allowedOrigins: string[]; // empty => same-origin default (no CORS header emitted)
  nodeEnv: string;
  globalRateLimiter: SlidingWindowRateLimiter;
  authRateLimiter: SlidingWindowRateLimiter;
}

export class HttpServer {
  private routes: Route[] = [];
  private server: Server | undefined;

  constructor(private readonly options: HttpServerOptions) {}

  register(method: HttpMethod, path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler, maxBodyBytes: options?.maxBodyBytes });
  }

  get(path: string, handler: RouteHandler): void {
    this.register('GET', path, handler);
    // HEAD support piggy-backs on GET, discarding the response body.
    this.register('HEAD', path, async (ctx) => {
      const result = await handler(ctx);
      return result ? { status: result.status } : undefined;
    });
  }
  post(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.register('POST', path, handler, options);
  }
  patch(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.register('PATCH', path, handler, options);
  }
  delete(path: string, handler: RouteHandler): void {
    this.register('DELETE', path, handler);
  }

  private matchRoute(method: HttpMethod, path: string): { route: Route; params: Record<string, string> } | undefined {
    const pathSegments = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== pathSegments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i]!;
        const pathSeg = pathSegments[i]!;
        if (routeSeg.startsWith(':')) {
          params[routeSeg.slice(1)] = decodeURIComponent(pathSeg);
        } else if (routeSeg !== pathSeg) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return undefined;
  }

  private async readBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBodyBytes) {
        throw new HttpError(413, 'request body too large');
      }
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return undefined;
    const raw = Buffer.concat(chunks);

    // Multipart/form-data (real file uploads — Lead/Inventory/Payment
    // import routes) never goes through JSON.parse; everything else on
    // this hand-written server is JSON as before.
    const contentType = req.headers['content-type'] ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      return parseMultipart(raw, contentType);
    }

    const text = raw.toString('utf8');
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'invalid JSON body');
    }
  }

  private applySecurityHeaders(res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
    );
    if (this.options.nodeEnv === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
  }

  private applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!origin) return;
    const { allowedOrigins } = this.options;
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,HEAD,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-demo-user');
      res.setHeader('Vary', 'Origin');
    }
  }

  private clientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]!.trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    const { staticDir } = this.options;
    if (!staticDir) return false;
    const safePath = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(staticDir, safePath);
    if (!filePath.startsWith(staticDir)) return false;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return false;
      const contents = await readFile(filePath);
      const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.writeHead(200);
      res.end(contents);
      return true;
    } catch {
      return false;
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const ip = this.clientIp(req);
    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    this.applySecurityHeaders(res);
    this.applyCors(req, res);

    const finish = (status: number, body?: unknown) => {
      const durationMs = Date.now() - start;
      logRequest({ ts: new Date().toISOString(), method, path, status, durationMs, ip });
      if (method === 'HEAD' || body === undefined) {
        res.writeHead(status);
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };

    if (method === 'OPTIONS') {
      finish(204);
      return;
    }

    try {
      const globalLimit = this.options.globalRateLimiter.consume(ip);
      if (!globalLimit.allowed) {
        throw new HttpError(429, 'too many requests');
      }
      if (path.startsWith('/api/auth/')) {
        const authLimit = this.options.authRateLimiter.consume(ip);
        if (!authLimit.allowed) {
          throw new HttpError(429, 'too many auth requests');
        }
      }

      const match = this.matchRoute(method, path);
      if (!match) {
        if ((method === 'GET' || method === 'HEAD') && (await this.serveStatic(path, res))) {
          const durationMs = Date.now() - start;
          logRequest({ ts: new Date().toISOString(), method, path, status: 200, durationMs, ip });
          return;
        }
        throw new HttpError(404, 'not found');
      }

      const body = method === 'POST' || method === 'PATCH' ? await this.readBody(req, match.route.maxBodyBytes ?? MAX_BODY_BYTES) : undefined;
      const ctx: RequestContext = {
        method,
        path,
        params: match.params,
        query: url.searchParams,
        body,
        headers: req.headers,
        ip,
      };
      const result = await match.route.handler(ctx);
      finish(result?.status ?? 204, result?.body);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const durationMs = Date.now() - start;
      const logFields = { ts: new Date().toISOString(), method, path, status, durationMs, ip };
      if (status >= 500) {
        logServerError(err, logFields);
      } else {
        logRequest(logFields);
      }
      const clientMessage =
        status >= 500 && this.options.nodeEnv === 'production'
          ? 'internal server error'
          : err instanceof Error
            ? err.message
            : 'internal server error';
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(status);
      res.end(JSON.stringify({ error: clientMessage }));
    }
  }

  listen(port: number): Server {
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server.listen(port);
    return this.server;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
