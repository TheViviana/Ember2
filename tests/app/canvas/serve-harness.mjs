/**
 * 浏览器验收结果服务（C2/C3）：零依赖、只监听 127.0.0.1、不进 CI。
 *
 * 启动（仓库根）：
 *   node tests/app/canvas/serve-harness.mjs --out /tmp/ember-harness.json
 * 打开验收页：
 *   pnpm vite --port 5199
 *   http://127.0.0.1:5199/tests/app/canvas/browser-harness.html
 * 结果回传：页面 POST /result（JSON）；`--out` 缺省时只写 stdout，不落仓。
 * 探活：GET /health → ok。
 */
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { argv, stdout } from 'node:process';

function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
}

const port = Number(option('--port', '5200'));
const out = option('--out', '');

const HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const server = createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, HEADERS);
    response.end();
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  if (request.method === 'POST' && request.url === '/result') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (out !== '') writeFileSync(out, `${body}\n`);
      stdout.write(`${body}\n`);
      response.writeHead(204, HEADERS);
      response.end();
    });
    return;
  }
  response.writeHead(404, HEADERS);
  response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  stdout.write(`harness 结果服务：http://127.0.0.1:${port}/result\n`);
  if (out !== '') stdout.write(`结果写入：${out}\n`);
});
