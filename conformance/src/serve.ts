import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';

/** Serves files by path from [read]; for tests and for trying a provider locally. */
export function serveFiles(
  read: (path: string) => Promise<Uint8Array | undefined>,
  port = 0,
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
    read(path)
      .then((body) => {
        if (!body) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': path.endsWith('.png') ? 'image/png' : path.endsWith('.zip') ? 'application/zip' : 'application/json' });
        res.end(body);
      })
      .catch(() => res.writeHead(500).end());
  });
  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      done({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Serves a folder, refusing paths that leave it. */
export function serveFolder(root: string, port = 0) {
  const base = resolve(root);
  return serveFiles(async (path) => {
    const file = normalize(join(base, path));
    if (!file.startsWith(base + sep)) return undefined;
    return readFile(file).then((b) => new Uint8Array(b), () => undefined);
  }, port);
}

