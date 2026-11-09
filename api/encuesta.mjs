// Encuesta abierta del sitio: ¿a quién votarías para presidente de Vélez?
// GET devuelve el conteo (cacheado unos segundos en la CDN). POST registra o cambia el voto de un navegador.
// Los votos se guardan en Upstash Redis (integración de Vercel), por su API REST: no hay dependencias.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLOSES_AT = "2026-11-15T08:00:00-03:00";
const SEGMENTS = ["socio", "hincha"];
const UNDECIDED = "indecisos";
const COOKIE = "enc26";
const COOKIE_DAYS = 60;
// En Argentina muchas conexiones móviles comparten IP: el tope frena la carga masiva sin trabar a la gente.
const NEW_VOTERS_PER_IP_PER_DAY = 30;
const KEYS = { votes: "{enc26}:votos", counts: "{enc26}:conteo", ip: "{enc26}:ip:" };

// Un voto por navegador. Si cambia de opción, se resta la anterior. Todo en un solo paso para que no se pisen dos pedidos.
const VOTE_SCRIPT = `
local prev = redis.call('HGET', KEYS[1], ARGV[1])
if prev == ARGV[2] then return 0 end
if not prev then
  local n = redis.call('INCR', KEYS[3])
  if n == 1 then redis.call('EXPIRE', KEYS[3], 172800) end
  if n > tonumber(ARGV[3]) then return -1 end
else
  redis.call('HINCRBY', KEYS[2], prev, -1)
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
if prev then return 2 end
return 1`;

let choicesCache = null;
function choices() {
  if (!choicesCache) {
    const data = JSON.parse(readFileSync(path.join(process.cwd(), "data", "candidates.json"), "utf8"));
    choicesCache = data.candidates.filter((c) => c.status !== "withdrawn").map((c) => c.id).concat(UNDECIDED);
  }
  return choicesCache;
}

function store() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

async function redis(db, command) {
  const response = await fetch(db.url, {
    method: "POST",
    headers: { authorization: "Bearer " + db.token, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error("Redis " + response.status + " " + (body.error || ""));
  return body.result;
}

const isOpen = () => Date.now() < Date.parse(CLOSES_AT);

async function tally(db) {
  const flat = (await redis(db, ["HGETALL", KEYS.counts])) || [];
  const ids = choices();
  const todos = Object.fromEntries(ids.map((id) => [id, 0]));
  const socios = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [segment, choice] = String(flat[i]).split("|");
    const count = Math.max(0, Number(flat[i + 1]) || 0);
    if (!(choice in todos)) continue;
    todos[choice] += count;
    if (segment === "socio") socios[choice] += count;
  }
  const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    open: isOpen(),
    closesAt: CLOSES_AT,
    options: ids,
    total: sum(todos),
    totalSocios: sum(socios),
    todos,
    socios,
    updated: new Date().toISOString()
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function clientIp(request) {
  return (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || request.headers.get("x-real-ip") || "sin-ip";
}

function sameSite(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return [new URL(request.url).host, request.headers.get("x-forwarded-host"), request.headers.get("host")].includes(host);
  } catch {
    return false;
  }
}

export async function GET() {
  const db = store();
  if (!db) return json({ error: "La encuesta todavía no está disponible." }, 503);
  try {
    return json(await tally(db), 200, { "cache-control": "public, max-age=0, s-maxage=10, stale-while-revalidate=30" });
  } catch (error) {
    console.error("encuesta GET", error);
    return json({ error: "No se pudieron leer los resultados." }, 503);
  }
}

export async function POST(request) {
  const db = store();
  if (!db) return json({ error: "La encuesta todavía no está disponible." }, 503);
  if (!sameSite(request)) return json({ error: "Votá desde velezelecciones.com/encuesta.html." }, 403);
  if (!isOpen()) return json({ error: "La encuesta cerró cuando abrió la votación en el club." }, 403);

  let body = null;
  try { body = await request.json(); } catch { /* cuerpo inválido */ }
  const choice = body && String(body.choice || "");
  const segment = body && String(body.segment || "");
  if (!choices().includes(choice) || !SEGMENTS.includes(segment)) {
    return json({ error: "Elegí una opción y contanos si votás el domingo." }, 400);
  }

  let voter = readCookie(request, COOKIE);
  const fresh = !/^[0-9a-f-]{36}$/.test(voter);
  if (fresh) voter = randomUUID();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  const ipKey = KEYS.ip + createHash("sha256").update(clientIp(request) + "|" + db.token).digest("hex").slice(0, 24) + ":" + day;

  try {
    const result = await redis(db, ["EVAL", VOTE_SCRIPT, "3", KEYS.votes, KEYS.counts, ipKey, voter, segment + "|" + choice, String(NEW_VOTERS_PER_IP_PER_DAY)]);
    if (Number(result) === -1) {
      return json({ error: "Desde esta conexión ya se votó muchas veces hoy. Probá mañana o desde otra red." }, 429);
    }
    const headers = {};
    if (fresh) headers["set-cookie"] = `${COOKIE}=${voter}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
    return json({ ...(await tally(db)), voto: { choice, segment }, changed: Number(result) === 2 }, 200, headers);
  } catch (error) {
    console.error("encuesta POST", error);
    return json({ error: "No se pudo guardar el voto. Probá de nuevo en un rato." }, 503);
  }
}
