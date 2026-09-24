// Dev-only: serves the web viewer the way GitHub Pages will (web/ at the root, shared/ under
// /shared/), for testing in a browser.   node dev/serve-web.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.argv[2] || process.env.PORT || 5174);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const base = pathname.startsWith('/shared/') ? path.join(root, 'shared') : path.join(root, 'web');
  const rel = pathname.startsWith('/shared/') ? pathname.slice('/shared/'.length) : (pathname === '/' ? 'index.html' : pathname);
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`web viewer on http://localhost:${port}/`));
