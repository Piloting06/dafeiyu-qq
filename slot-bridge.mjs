import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const routes = new Set(['policy', 'discover', 'message', 'join', 'join/result'].map(p => `/api/qq-community/official/${p}`));
export function activePort(text) {
  const value = text.replace(/#[^\n]*/g, '').trim();
  const match = /^server\s+127\.0\.0\.1:(3200|3201)\s*;$/.exec(value);
  if (!match) throw new Error('unsupported active slot');
  return Number(match[1]);
}
export function bridgeServer(resolvePort, transport = fetch) {
  let active = 0;
  const server = createServer(async (req, res) => {
    const end = (code) => { if (!res.destroyed) res.writeHead(code, {'Content-Type':'application/json','Cache-Control':'no-store'}).end('{}'); };
    if (req.method !== 'POST' || !routes.has(req.url)) { end(404); req.resume(); return; }
    if (active >= 32) { end(503); req.resume(); return; }
    if (!/^Bearer [^\s]{32,4096}$/.test(req.headers.authorization || '')) { end(401); req.resume(); return; }
    if (Number(req.headers['content-length'] || 0) > 65536) { end(413); req.resume(); return; }
    active++;
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); req.destroy(); res.destroy(); }, 7000);
    const disconnected = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', disconnected);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { end(413); return; }
        chunks.push(chunk);
      }
      const port = await resolvePort();
      const upstream = await transport(`http://127.0.0.1:${port}${req.url}`, {
        method:'POST', redirect:'error', signal:abort.signal,
        headers:{'Content-Type':'application/json', Authorization:req.headers.authorization},
        body:Buffer.concat(chunks),
      });
      let length = 0; const body = [];
      for await (const chunk of upstream.body || []) {
        length += chunk.length;
        if (length > 65536) { abort.abort(); throw new Error('oversize response'); }
        body.push(chunk);
      }
      res.writeHead(upstream.status, {'Content-Type':'application/json','Cache-Control':'no-store'}).end(Buffer.concat(body));
    } catch { end(503); }
    finally { clearTimeout(timer); res.off('close',disconnected); active--; }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000; server.maxHeadersCount = 24;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const file = process.env.DAFEIYU_UPSTREAM_FILE;
  if (!file) throw new Error('active slot file required');
  const server = bridgeServer(async () => activePort(await readFile(file,'utf8')));
  server.listen(52902,'127.0.0.1');
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => {server.closeAllConnections(); process.exit(0);},8000).unref();
  });
}
