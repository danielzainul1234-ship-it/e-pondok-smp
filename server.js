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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Revisi data saat ini = mtime file data (dalam ms, sebagai string) -- dipakai
// sebagai penanda versi sederhana supaya perangkat yang datanya sudah basi
// (mis. tab HP/laptop yang dibuka lama & belum memuat ulang) tidak diam-diam
// MENIMPA perubahan terbaru dari perangkat lain dengan data lamanya (lihat
// catatan "optimistic concurrency" di bawah).
//
// Catatan: revisi ini dikirim lewat FIELD DI DALAM BODY JSON (`_rev`), BUKAN
// header HTTP (ETag/If-Match) -- percobaan awal memakai header ETag ternyata
// tidak sampai ke browser secara konsisten di balik proxy/edge Railway (header
// khusus ini tampak "hilang" walau Cache-Control tetap sampai), jadi supaya
// tidak bergantung pada perilaku header yang di luar kendali kita, revisi
// dititipkan sebagai field biasa di dalam data JSON yang memang sudah kita
// kirim bolak-balik.
function getCurrentRevision(cb) {
  fs.stat(DATA_FILE, (err, stat) => {
    if (err) return cb(null); // belum ada data sama sekali -> revisi awal
    cb(String(stat.mtimeMs));
  });
}

// GET /api/data -> the current shared app state (or {} if nothing saved yet),
// dengan field `_rev` disisipkan ke dalam objeknya supaya client tahu "versi"
// data yang baru saja dia muat, dan bisa mengirimkannya kembali saat menyimpan
// (lihat handlePostData).
function handleGetData(req, res) {
  getCurrentRevision((rev) => {
    fs.readFile(DATA_FILE, 'utf8', (err, raw) => {
      // Cache-Control: no-store -- endpoint ini HARUS selalu memberi data & revisi
      // TERBARU, tidak boleh ada browser/proxy cache di antaranya yang menyajikan
      // jawaban lama (kalau itu terjadi, deteksi konflik jadi tidak berguna karena
      // client bisa saja melihat revisi basi dan berpikir datanya sudah sinkron).
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      let payload;
      if (err) {
        payload = {};
      } else {
        try { payload = JSON.parse(raw); } catch (e) { payload = {}; }
      }
      if (rev) payload._rev = rev;
      const body = JSON.stringify(payload);
      res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
}

// POST /api/data -> replace the shared app state with the given JSON body.
// Optimistic concurrency: client mengirim field `_rev` di dalam body berisi
// revisi terakhir yang dia MUAT (dari GET sebelumnya). Kalau revisi itu sudah
// tidak cocok lagi dengan revisi saat ini di server -- artinya ada perangkat
// LAIN yang sudah menyimpan perubahan lebih baru sejak client ini terakhir
// memuat data -- tolak dengan 409 Conflict alih-alih diam-diam menimpanya. Ini
// mencegah tab/perangkat yang datanya sudah basi menghapus perubahan terbaru
// admin tanpa disadari. Client lama yang belum mengirim `_rev` (mis. cache
// browser yang belum memuat versi baru ini) tetap diperbolehkan menyimpan
// seperti sebelumnya, supaya transisi tidak mendadak memblokir siapa pun.
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

    // Ambil & buang field `_rev` -- ini metadata protokol sinkronisasi, bukan
    // bagian dari data aplikasi, jadi jangan sampai ikut tersimpan permanen.
    const clientRev = data._rev;
    delete data._rev;

    getCurrentRevision((currentRev) => {
      if (clientRev && currentRev && clientRev !== currentRev) {
        // Data di server sudah berubah sejak client ini terakhir memuatnya --
        // JANGAN timpa. Beri tahu client supaya dia memuat ulang data terbaru
        // lalu (kalau perlu) mengulang penyimpanannya di atas data terbaru itu.
        return sendJSON(res, 409, { error: 'conflict', currentRevision: currentRev });
      }
      // Atomic-ish write: write to a temp file then rename, so a crash mid-write
      // never leaves a half-written / corrupted data file behind.
      const tmpFile = DATA_FILE + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFile(tmpFile, JSON.stringify(data), 'utf8', (err) => {
        if (err) return sendJSON(res, 500, { error: 'write_failed' });
        fs.rename(tmpFile, DATA_FILE, (err2) => {
          if (err2) return sendJSON(res, 500, { error: 'write_failed' });
          getCurrentRevision((newRev) => {
            sendJSON(res, 200, { ok: true, _rev: newRev || null });
          });
        });
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
