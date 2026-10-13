/* Smoke Management Plan worksheet sync: Cloudflare Worker
   KV keys (one namespace, bound as DATA_KV):
     "doc"   : {version, updatedAt, updatedBy, data, log}  the shared worksheet plus its change log
     "users" : [{name, code, role}]  role is "editor" or "viewer"

   Auth: Authorization: Bearer <code>
     code === env.SYNC_PASSWORD   -> owner (full access, manages "users")
     code matches a users[] entry -> that entry's role
     anything else                -> 401

   Routes:
     GET  /whoami          -> {name, role}
     GET  /doc             -> {version, updatedAt, updatedBy, data}  (version 0, data null if empty)
     PUT  /doc             body {baseVersion, data}; 409 with the current doc if baseVersion is stale
     GET  /log             -> [{start, at, by, fields:[keys], created?}]  oldest first, any role
     GET  /users, PUT /users   owner only
     GET  /osm/nominatim/search?..., /osm/nominatim/reverse?...   OpenStreetMap address search, any role
     POST /osm/overpass    body data=<Overpass QL>                   OpenStreetMap map search, any role
       These relay to OpenStreetMap from the Worker. Browsers on github.io pages are sometimes refused
       (no CORS header, or 406), and OSM's usage policies ask apps to identify themselves with a
       User-Agent, which a browser can't set. Answers are cached so repeat searches don't hit OSM.
*/

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const text = (msg, status) => new Response(msg, { status, headers: CORS });

const LOG_MAX = 500;                 // entries kept
const LOG_MERGE_MS = 15 * 60 * 1000; // one person's saves within 15 minutes become one entry

function changedKeys(before, after) {
  const a = before || {}, b = after || {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => k !== '_savedAt' && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}

function appendLog(log, by, at, fields, created) {
  const out = Array.isArray(log) ? log.slice() : [];
  const last = out[out.length - 1];
  if (!created && last && !last.created && last.by === by && Date.parse(at) - Date.parse(last.at) < LOG_MERGE_MS) {
    out[out.length - 1] = { ...last, at, fields: [...new Set([...last.fields, ...fields])] };
  } else {
    out.push({ start: at, at, by, fields, ...(created ? { created: true } : {}) });
  }
  return out.slice(-LOG_MAX);
}

async function readUsers(env) {
  const raw = await env.DATA_KV.get('users');
  try { const u = raw ? JSON.parse(raw) : []; return Array.isArray(u) ? u : []; } catch { return []; }
}

async function identify(request, env) {
  const code = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!code) return null;
  if (env.SYNC_PASSWORD && code === env.SYNC_PASSWORD) return { name: env.OWNER_NAME || 'Owner', role: 'owner' };
  const u = (await readUsers(env)).find((x) => x.code === code);
  return u ? { name: u.name, role: u.role === 'viewer' ? 'viewer' : 'editor' } : null;
}

const OSM_UA = 'SMP-Worksheet/1.0 (prescribed burn smoke management worksheet; https://github.com/eric-carlson/smoke-management-plan-worksheet)';
let overpassGood = null;   // the server that answered last, tried first next time (lives as long as this Worker instance)
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function cached(key, ttl, make) {
  const cache = caches.default, req = new Request('https://osm-cache.invalid/' + key);
  const hit = await cache.match(req);
  if (hit) return new Response(hit.body, { status: hit.status, headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'hit' } });
  const res = await make();
  if (res.ok) {
    const body = await res.text();
    await cache.put(req, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` } }));
    return new Response(body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  return res;
}
async function osm(request, pathname) {
  const url = new URL(request.url);
  if (request.method === 'GET' && /^\/osm\/nominatim\/(search|reverse)$/.test(pathname)) {
    const target = 'https://nominatim.openstreetmap.org/' + pathname.split('/').pop() + url.search;
    return cached('nom-' + (await sha256(target)), 7 * 86400, async () => {
      const r = await fetch(target, { headers: { 'User-Agent': OSM_UA, 'Accept': 'application/json', 'Referer': 'https://eric-carlson.github.io/' } });
      return r.ok ? r : text(`Nominatim answered ${r.status}`, 502);
    });
  }
  if (request.method === 'POST' && pathname === '/osm/overpass') {
    const body = await request.text();
    if (!/^data=/.test(body) || body.length > 8000) return text('Expected data=<query>', 400);
    return cached('ovp-' + (await sha256(body)), 86400, async () => {
      let why = '';
      const order = overpassGood ? [overpassGood, ...OVERPASS.filter((u) => u !== overpassGood)] : OVERPASS;
      for (const target of order) {
        try {
          const r = await fetch(target, { method: 'POST', body, headers: { 'User-Agent': OSM_UA, 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000) });
          if (r.ok) { overpassGood = target; return r; }
          why = `${new URL(target).host} answered ${r.status}`;
          if (r.status === 400) return text(await r.text(), 400);
        } catch (e) { why = `${new URL(target).host} ${e.name === 'TimeoutError' ? 'timed out' : 'could not be reached'}`; }
      }
      return text(why || 'Overpass unavailable', 502);
    });
  }
  return text('Not found', 404);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const { pathname } = new URL(request.url);

    const who = await identify(request, env);
    if (!who) return text('Unauthorized', 401);

    if (pathname === '/whoami' && request.method === 'GET') return json(who);

    if (pathname.startsWith('/osm/')) return osm(request, pathname);

    if (pathname === '/doc') {
      if (request.method === 'GET') {
        const raw = await env.DATA_KV.get('doc');
        if (!raw) return json({ version: 0, updatedAt: null, updatedBy: null, data: null });
        const { log, ...doc } = JSON.parse(raw);
        return json(doc);
      }
      if (request.method === 'PUT') {
        if (who.role === 'viewer') return text('Read-only access', 403);
        let body;
        try { body = await request.json(); } catch { return text('Invalid JSON', 400); }
        if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data) || typeof body.baseVersion !== 'number') {
          return text('Expected {baseVersion: number, data: object}', 400);
        }
        const raw = await env.DATA_KV.get('doc');
        const current = raw ? JSON.parse(raw) : { version: 0, updatedAt: null, updatedBy: null, data: null };
        if (body.baseVersion !== current.version) { const { log, ...doc } = current; return json(doc, 409); }
        const at = new Date().toISOString();
        const fields = changedKeys(current.data, body.data);
        const created = current.data == null;
        const log = (fields.length || created) ? appendLog(current.log, who.name, at, created ? [] : fields, created) : (current.log || []);
        const next = { version: current.version + 1, updatedAt: at, updatedBy: who.name, data: body.data, log };
        await env.DATA_KV.put('doc', JSON.stringify(next));
        return json({ version: next.version, updatedAt: next.updatedAt, updatedBy: next.updatedBy });
      }
      return text('Method not allowed', 405);
    }

    if (pathname === '/log' && request.method === 'GET') {
      const raw = await env.DATA_KV.get('doc');
      return json(raw ? (JSON.parse(raw).log || []) : []);
    }

    if (pathname === '/users') {
      if (who.role !== 'owner') return text('Owner only', 403);
      if (request.method === 'GET') return json(await readUsers(env));
      if (request.method === 'PUT') {
        let list;
        try { list = await request.json(); } catch { return text('Invalid JSON', 400); }
        if (!Array.isArray(list)) return text('Expected an array', 400);
        const codes = new Set();
        for (const u of list) {
          if (!u || typeof u.name !== 'string' || !u.name.trim() || typeof u.code !== 'string' || u.code.length < 8 || !['editor', 'viewer'].includes(u.role)) {
            return text('Each entry needs name, code (8+ characters), and role (editor or viewer)', 400);
          }
          if (u.code === env.SYNC_PASSWORD || codes.has(u.code)) return text('Duplicate access code', 400);
          codes.add(u.code);
        }
        await env.DATA_KV.put('users', JSON.stringify(list));
        return json({ ok: true });
      }
      return text('Method not allowed', 405);
    }

    return text('Not found', 404);
  },
};
