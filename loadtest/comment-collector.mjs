/* global console, process */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.COLLECTOR_PORT || '9999', 10);

function getCommentsFilePath() {
  const stateDir = process.env.LT2_STATE_DIR || __dirname;
  return path.join(stateDir, 'lt2_comments.json');
}

function readComments() {
  const commentsFilePath = getCommentsFilePath();
  if (!fs.existsSync(commentsFilePath)) return [];
  try {
    const raw = fs.readFileSync(commentsFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeComments(comments) {
  const commentsFilePath = getCommentsFilePath();
  const tmpPath = `${commentsFilePath}.tmp.${Date.now()}`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  fs.writeFileSync(fd, JSON.stringify(comments, null, 2), 'utf8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, commentsFilePath);
}

export function createCollectorServer() {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/comment') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data && data.id) {
            const comments = readComments();
            if (!comments.some((c) => c.id === data.id)) {
              comments.push({
                id: data.id,
                authorId: data.authorId || '',
                authorHandle: data.authorHandle || '',
                createdAt: new Date().toISOString(),
              });
              writeComments(comments);
              console.log(`[collector] Recorded comment ${data.id}`);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('comment-collector.mjs')) {
  const server = createCollectorServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[collector] Comment collector listening on port ${PORT}...`);
  });

  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}
