import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { spawn } from 'node:child_process';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const root = join(process.cwd(), 'dist');

if (!existsSync(join(root, 'index.html'))) {
  console.error('找不到 dist/index.html，請先執行 npm run build。');
  process.exit(1);
}

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.task', 'application/octet-stream'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
]);

const server = createServer((request, response) => {
  const rawPath = decodeURIComponent(new URL(request.url || '/', `http://${host}`).pathname);
  const safePath = normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = join(root, safePath === '/' ? 'index.html' : safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(root, 'index.html');
  }

  response.writeHead(200, {
    'Content-Type': contentTypes.get(extname(filePath)) || 'application/octet-stream',
    'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`果忍對決已啟動：${url}`);
  if (process.platform === 'darwin' && !process.argv.includes('--no-open')) {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
});

