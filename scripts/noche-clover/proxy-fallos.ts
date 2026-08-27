/**
 * Proxy HTTP que reenvía a Clover de verdad pero puede SABOTEAR peticiones concretas.
 *
 * Sirve para probar los caminos de fallo de punta a punta sin simular el API: el estado en Clover
 * es real, sólo se rompe el transporte. Se controla por HTTP:
 *
 *   POST /__fallo  { "patron": "line_items", "modo": "429"|"500"|"timeout"|"cortar", "veces": 2 }
 *   POST /__reset
 *   GET  /__stats
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const PUERTO = Number(process.env.PROXY_PORT ?? 8899);
const DESTINO = process.env.PROXY_TARGET ?? 'https://sandbox.dev.clover.com';

type Fallo = { patron: string; modo: '429' | '500' | 'timeout' | 'cortar'; veces: number };
let fallo: Fallo | null = null;
const stats = { total: 0, saboteadas: 0, porRuta: {} as Record<string, number> };

const servidor = createServer((req, res) => {
  const url = req.url ?? '/';

  if (url === '/__fallo' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { fallo = JSON.parse(b); res.writeHead(200).end(JSON.stringify({ ok: true, fallo })); });
    return;
  }
  if (url === '/__reset') { fallo = null; stats.total = 0; stats.saboteadas = 0; stats.porRuta = {};
    res.writeHead(200).end(JSON.stringify({ ok: true })); return; }
  if (url === '/__stats') { res.writeHead(200).end(JSON.stringify(stats)); return; }

  stats.total++;
  const clave = `${req.method} ${url.split('?')[0].replace(/\/[A-Z0-9]{10,}/g, '/{id}')}`;
  stats.porRuta[clave] = (stats.porRuta[clave] ?? 0) + 1;

  // ¿toca sabotear?
  if (fallo && fallo.veces > 0 && url.includes(fallo.patron)) {
    fallo.veces--; stats.saboteadas++;
    if (fallo.modo === 'timeout') return;                       // se queda colgado: el cliente expira
    if (fallo.modo === 'cortar') { req.socket.destroy(); return; }
    const code = fallo.modo === '429' ? 429 : 500;
    res.writeHead(code, { 'Content-Type': 'application/json', ...(code === 429 ? { 'Retry-After': '1' } : {}) });
    res.end(JSON.stringify({ message: code === 429 ? 'Too Many Requests' : 'Internal Server Error' }));
    return;
  }

  const destino = new URL(DESTINO);
  const hacer = destino.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = hacer({
    hostname: destino.hostname, port: destino.port || (destino.protocol === 'https:' ? 443 : 80),
    path: url, method: req.method,
    headers: { ...req.headers, host: destino.hostname },
  }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  upstream.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(JSON.stringify({ message: String(e) })); });
  req.pipe(upstream);
});

servidor.listen(PUERTO, () => console.log(`proxy de fallos en :${PUERTO} -> ${DESTINO}`));
