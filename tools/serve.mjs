// tools/serve.mjs — static server for gate runs. Binds port 0 (OS-chosen),
// writes the real URL to docs/.serve-url so the caller reads it rather than
// assuming one. A hardcoded shared dev port has twice caused a project's
// suite to run against a DIFFERENT project's site; this makes that
// impossible.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const ROOT = process.cwd();
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.md': 'text/markdown; charset=utf-8',
};

const server = createServer((req, res) => {
  let rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^[\/\\]+/, '');
  if (rel === '' || rel.endsWith('/')) rel = join(rel, 'index.html');
  const f = join(ROOT, rel);
  if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(join(ROOT, 'docs', '.serve-url'), url);
  console.log(url);
});
