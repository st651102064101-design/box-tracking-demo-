import { Router } from 'express';
import { verifyToken } from '../lib/jwt.js';
import { subscribe, currentVersion } from '../lib/bus.js';

/**
 * `GET /api/stream` — server-sent events telling clients that state changed.
 *
 * Why SSE rather than WebSocket: everything here flows one way. Clients already
 * write through REST, so the duplex half of a socket would go unused, while the
 * half we do need — reconnecting after the Wi-Fi drops a handheld — is built
 * into EventSource and would otherwise be ours to write. It is also plain HTTP,
 * so it inherits the CORS rules and the Next.js `/api` proxy the rest of the
 * app already goes through; a socket upgrade does not survive that rewrite.
 *
 * The payload is only a version number. `PUT /api/state` replaces the entire
 * snapshot, so there is no delta to send — clients re-read `/api/state` and
 * their own signature check decides whether anything actually needs redrawing.
 */
export const streamRouter = Router();

/** Send at least this often so proxies and load balancers keep the pipe open. */
const HEARTBEAT_MS = 25_000;

/**
 * EventSource cannot set an Authorization header, so the token arrives as a
 * query parameter here. That is the standard workaround, and the reason
 * app.ts keeps this path out of the access log: the URL holds a credential and
 * request logs are the one place it must not be written down.
 */
function tokenFrom(req: { headers: Record<string, unknown>; query: Record<string, unknown> }): string {
  const header = String(req.headers.authorization ?? '');
  const [scheme, headerToken] = header.split(' ');
  if (scheme === 'Bearer' && headerToken) return headerToken;
  const q = req.query.token;
  return typeof q === 'string' ? q : '';
}

streamRouter.get('/', (req, res) => {
  const token = tokenFrom(req as never);
  if (!token) {
    return res.status(401).json({ error: 'unauthorized', message: 'ต้องเข้าสู่ระบบก่อน' });
  }
  try {
    verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'invalid_token', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    /* `no-transform` and X-Accel-Buffering stop nginx and friends from holding
       the response in a buffer waiting for it to end — which for a stream that
       never ends means the client hears nothing at all. */
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  /* How long EventSource waits before reconnecting itself after a drop. */
  res.write('retry: 3000\n\n');
  /* An immediate first frame: it proves the pipe is open end to end, which is
     what lets the client slow its polling down without risking going blind. */
  res.write(`event: hello\ndata: ${JSON.stringify({ v: currentVersion() })}\n\n`);

  const unsubscribe = subscribe((version, origin) => {
    res.write(`event: state\ndata: ${JSON.stringify({ v: version, origin })}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(': hb\n\n'); // an SSE comment — ignored by the client, keeps the socket warm
  }, HEARTBEAT_MS);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', close);
  res.on('close', close);
});

export default streamRouter;
