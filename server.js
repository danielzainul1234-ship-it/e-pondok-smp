const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

// Where the shared app data (santri, pengurus, kegiatan, settings, dst.) lives.
// In production this should point at a mounted persistent volume so data
// survives redeploys/restarts; falls back to a local folder for dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'epondok-data.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* already exists */ }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Files that must never be served over HTTP even though they live at the root
const BLOCKED = new Set(['/server.js', '/package.json', '/package-lock.json', '/railway.json', '/.gitignore']);

const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15MB safety cap (base64 logo/photos inflate size)

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// GET /api/data -> the current shared app state (or {} if nothing saved yet)
function handleGetData(req, res) {
  fs.readFile(DATA_FILE, 'utf8', (err, raw) => {
    if (err) return sendJSON(res, 200, {});
    try {
      sendJSON(res, 200, JSON.parse(raw));
    } catch (e) {
      sendJSON(res, 200, {});
    }
  });
}

// POST /api/data -> replace the shared app state with the given JSON body.
// This is a simple "whole blob, last write wins" store: good enough for a
// single-pesantren admin app where edits aren't happening concurrently on
// two devices at the exact same second.
function handlePostData(req, res) {
  let size = 0;
  const chunks = [];
  let tooLarge = false;

  req.on('data', (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      sendJSON(res, 413, { error: 'payload_too_large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (tooLarge) return; // response already sent
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      return sendJSON(res, 400, { error: 'invalid_json' });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return sendJSON(res, 400, { error: 'invalid_payload' });
    }
    // Atomic-ish write: write to a temp file then rename, so a crash mid-write
    // never leaves a half-written / corrupted data file behind.
    const tmpFile = DATA_FILE + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFile(tmpFile, JSON.stringify(data), 'utf8', (err) => {
      if (err) return sendJSON(res, 500, { error: 'write_failed' });
      fs.rename(tmpFile, DATA_FILE, (err2) => {
        if (err2) return sendJSON(res, 500, { error: 'write_failed' });
        sendJSON(res, 200, { ok: true });
      });
    });
  });

  req.on('error', () => { /* client aborted; nothing to respond to */ });
}

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);

  if (reqPath === '/api/data') {
    if (req.method === 'GET') return handleGetData(req, res);
    if (req.method === 'POST') return handlePostData(req, res);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  if (reqPath === '/') reqPath = '/index.html';

  if (BLOCKED.has(reqPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  // Prevent directory traversal
  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(ROOT_DIR, safePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for unknown routes
      fs.readFile(path.join(ROOT_DIR, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`E-Pondok SMP server running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
