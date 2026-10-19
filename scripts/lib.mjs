// Funciones compartidas por los scripts de actualización (no dependen de nada externo).

const BROWSER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BOT_AGENT = "Mozilla/5.0 (compatible; VelezElecciones/1.0)";

// Pasa los bytes de una página a texto. Casi todas están en UTF-8, pero algunas (el sitio oficial del club) mandan Latin-1
// y declaran otra cosa dentro del HTML: se prueba UTF-8 estricto y, si no es válido, el charset del encabezado HTTP o windows-1252.
export function decodeBytes(bytes, contentType = "") {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* no es UTF-8 válido */ }
  const declared = (/charset=["']?([\w-]+)/i.exec(String(contentType)) || [])[1];
  for (const label of [declared, "windows-1252"]) {
    if (!label) continue;
    try { return new TextDecoder(label).decode(bytes); } catch { /* etiqueta desconocida */ }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export async function downloadHtml(url) {
  const response = await fetch(url, {
    headers: { "user-agent": BOT_AGENT, "accept-language": "es-AR,es;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(String(response.status));
  return decodeBytes(new Uint8Array(await response.arrayBuffer()), response.headers.get("content-type") || "");
}

// Solo el principio de la página (el <head> trae las etiquetas de imagen): evita bajar notas enteras para buscar una foto.
export async function downloadHead(url, timeout = 8000) {
  const response = await fetch(url, {
    headers: { "user-agent": BOT_AGENT, "accept-language": "es-AR,es;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(String(response.status));
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < 400000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (/<\/head>/i.test(Buffer.from(value).toString("latin1"))) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return decodeBytes(Buffer.concat(chunks), response.headers.get("content-type") || "");
}

function unescapeAttr(text) {
  return String(text || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// Fotos que no sirven: logos, íconos y recuadros genéricos que los medios ponen cuando una nota no tiene imagen propia.
const BAD_IMAGE = /logo|favicon|placeholder|sprite|blank|avatar|gravatar|default[-_.]?(image|og|share|thumb)|no[-_]?image|\.svg(\?|$)|\.gif(\?|$)/i;

// Deja solo direcciones https que parezcan una foto. Devuelve "" si no sirve.
export function goodImage(value, base) {
  const clean = unescapeAttr(value).trim();
  if (!clean) return ""; // un valor vacío se resolvería contra la base y devolvería la dirección de la propia nota
  let url;
  try { url = new URL(clean, base); } catch { return ""; }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:" || url.href.length > 600 || BAD_IMAGE.test(url.pathname)) return "";
  return url.href;
}

// Imagen principal de una nota (Open Graph o Twitter Card).
export function pageImage(html, base) {
  const wanted = ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"];
  const found = new Map();
  for (const meta of String(html).match(/<meta\s[^>]*>/gi) || []) {
    const key = ((/(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(meta) || [])[1] || "").toLowerCase();
    const content = (/content\s*=\s*["']([^"']*)["']/i.exec(meta) || [])[1];
    if (wanted.includes(key) && content && !found.has(key)) found.set(key, content);
  }
  for (const key of wanted) {
    const ok = goodImage(found.get(key), base);
    if (ok) return ok;
  }
  return "";
}

const MAX_ORIGINAL_BYTES = 250000;

// Dirección final de la miniatura de una nota. Las fotos originales pueden pesar varios MB, así que se piden ya reducidas
// (320×180, WebP, unos 7 KB) a un redimensionador público. Si ese servicio no responde para esa foto, se usa la original
// solo cuando es liviana; si no, la nota queda sin foto. Devuelve "" cuando no hay una miniatura razonable.
export async function thumbnail(url) {
  if (/^https:\/\/(?:www\.)?bing\.com\/th\?/i.test(url)) return url; // Bing ya la entrega chica
  const proxied = "https://wsrv.nl/?url=" + encodeURIComponent(url) + "&w=320&h=180&fit=cover&a=attention&output=webp&q=72";
  try {
    const response = await fetch(proxied, { headers: { "user-agent": BOT_AGENT }, signal: AbortSignal.timeout(20000) });
    const ok = response.ok && /^image\//i.test(response.headers.get("content-type") || "");
    await response.arrayBuffer();
    if (ok) return proxied;
  } catch { /* se prueba con la original */ }
  try {
    const head = await fetch(url, { method: "HEAD", headers: { "user-agent": BOT_AGENT }, redirect: "follow", signal: AbortSignal.timeout(10000) });
    const size = Number(head.headers.get("content-length"));
    if (head.ok && /^image\//i.test(head.headers.get("content-type") || "") && size > 0 && size <= MAX_ORIGINAL_BYTES) return url;
  } catch { /* sin foto */ }
  return "";
}

// Los enlaces de Google Noticias son redirecciones: se resuelve la nota real para poder leerla y citarla con su medio.
// Si Google cambia el mecanismo, falla sin romper nada y la nota queda sin leer.
export async function resolveGoogleNews(url) {
  const id = new URL(url).pathname.split("/").pop();
  try {
    const raw = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const direct = raw.match(/https?:\/\/[\x21-\x7e]+/);
    if (direct) return direct[0];
  } catch { /* se sigue con el otro método */ }
  const page = await fetch("https://news.google.com/rss/articles/" + id + "?hl=es-419&gl=AR&ceid=AR:es-419", {
    headers: { "user-agent": BROWSER_AGENT }, signal: AbortSignal.timeout(15000)
  });
  const html = await page.text();
  const signature = html.match(/data-n-a-sg="([^"]+)"/);
  const stamp = html.match(/data-n-a-ts="([^"]+)"/);
  if (!signature || !stamp) throw new Error("Google Noticias no devolvió la firma (" + page.status + ")");
  const inner = JSON.stringify([
    "garturlreq",
    [["es-419", "AR", ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"], null, null, 1, 1, "AR:es-419", null, 180, null, null, null, null, null, 0, 1], "es-419", "AR", 1, [2, 4, 8], 1, 1, null, 0, 0, null, 0],
    id, Number(stamp[1]), signature[1]
  ]);
  const response = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": BROWSER_AGENT },
    body: "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]])),
    signal: AbortSignal.timeout(15000)
  });
  const found = (await response.text()).match(/garturlres\\",\\"(https?:[^"\\]+)/);
  if (!found) throw new Error("Google Noticias no devolvió la nota (" + response.status + ")");
  return JSON.parse('"' + found[1] + '"');
}
