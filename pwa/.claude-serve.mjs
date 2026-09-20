// Local dev server for testing on a phone. Not part of the app.
//
//   node .claude-serve.mjs            -> https on 8443 (and http on 8099)
//   node .claude-serve.mjs --http     -> http only
//
// WHY HTTPS MATTERS, and it is not optional:
//
// iOS gates both of the APIs this app needs behind a SECURE CONTEXT:
//   * DeviceOrientationEvent.requestPermission()  — tilt, lean, compass
//   * navigator.mediaDevices.getUserMedia()       — the camera
//
// Over plain http on a LAN address (http://192.168.x.x) Safari does not merely
// deny these — it hides them, so feature detection reports "this device has no
// motion sensors" on a phone that plainly has them. localhost is exempt, which
// is why everything works on the desktop and nothing works on the phone.
//
// Self-signed means Safari shows a warning the first time. Tap Advanced ->
// Visit Website once; after that the origin is a proper secure context and
// both APIs light up.

import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = process.cwd();
const HERE = dirname(fileURLToPath(import.meta.url));
const HTTPS_PORT = 8443;
const HTTP_PORT = 8099;
const httpOnly = process.argv.includes('--http');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Reject any path containing a ".." segment rather than regex-scrubbing it.
function safeJoin(root, urlPath) {
  const parts = urlPath.split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return null;
  return join(root, parts.join(sep));
}

async function handler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = safeJoin(ROOT, p);
  if (!file) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const s = await stat(file);
    if (s.isDirectory()) throw new Error('dir');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + p);
  }
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

const keyPath = join(HERE, '.certs', 'key.pem');
const certPath = join(HERE, '.certs', 'cert.pem');
const haveCert = existsSync(keyPath) && existsSync(certPath);

console.log(`serving ${ROOT}\n`);

if (!httpOnly && haveCert) {
  createHttps({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, handler)
    .listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log('  HTTPS — use this on your phone (motion + camera need it):');
      console.log(`    https://localhost:${HTTPS_PORT}`);
      for (const { name, address } of lanAddresses()) {
        console.log(`    https://${address}:${HTTPS_PORT}   (${name})`);
      }
      console.log('\n  First visit shows a certificate warning. Tap Advanced ->');
      console.log('  Visit Website. That is expected for a self-signed cert.\n');
    });
} else if (!httpOnly) {
  console.log('  No certificate found in .certs/ — falling back to http.');
  console.log('  Motion sensors and camera will NOT work on a phone over http.\n');
}

// The http listener is a desktop convenience only. If the port is taken by an
// older instance, say so and carry on — https is the one that matters.
const httpServer = createHttp(handler);
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`  HTTP port ${HTTP_PORT} already in use — skipping (https is unaffected).`);
  } else {
    console.error('  HTTP server error:', err.message);
  }
});
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`  HTTP (desktop only) — http://localhost:${HTTP_PORT}`);
});
