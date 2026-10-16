// Busca noticias y sondeos reales sobre las elecciones de Vélez y escribe data/*.json y data/live.js.
// Uso: node scripts/update-data.mjs
// Necesita Node 18 o más nuevo. No usa dependencias.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const MAX_AGE_DAYS = 60;
const MAX_NEWS = 18;

// Búsquedas fijas. Las de cada candidato se arman con data/candidates.json.
const NEWS_QUERIES = [
  "Vélez Sarsfield elecciones 2026",
  "Vélez comicios 15 de noviembre candidatos",
  "Vélez elecciones nuevo candidato presidente lista",
  "Vélez elecciones candidato baja declinó candidatura",
  "Vélez Sarsfield encuesta elecciones socios",
  "Vélez Sarsfield sondeo intención de voto presidente",
  "site:velez.com.ar elecciones 2026",
  "site:tribuna.ar Vélez elecciones candidato",
  "site:cemba.com.ar Vélez elecciones Montero",
  "site:newsdigitales.com Vélez elecciones candidatos",
  "site:dobleamarilla.com.ar Vélez elecciones",
  "site:tycsports.com Vélez elecciones candidato",
  "site:ole.com.ar Vélez elecciones candidato",
  "site:lanacion.com.ar Vélez elecciones candidato",
  "site:infobae.com Vélez elecciones candidato",
  "site:muynews.com Vélez elecciones",
  "site:canal26.com Vélez elecciones",
  "site:perfil.com Vélez elecciones candidato",
  "site:youtube.com Vélez elecciones candidato entrevista",
  "Renovadora Vélez Mazitelli elecciones",
  "Ignacio Mazzitelli Vélez candidato presidente Renovadora",
  "Cruzada Renovadora Vélez 2026 candidato",
  "Círculo El Fortín Plan Vé Primero Vélez elecciones",
  "Legado Vélez Agrupación Amalfitani elecciones Pugliese",
  "ADN Azul y Blanco Montero propuestas Vélez",
  // Vida institucional que también mira el socio que vota: asambleas, balances, padrón, estatuto, dirigencia.
  "Vélez Sarsfield asamblea memoria y balance",
  "Vélez Sarsfield comisión directiva",
  "Vélez Sarsfield dirigencia oficialismo oposición",
  "Vélez Sarsfield cuota social padrón socios",
  "Vélez Sarsfield estatuto sociedad anónima deportiva",
  "Vélez Sarsfield Berlanga presidente del club",
  "site:velez.com.ar asamblea memoria balance",
  "site:velez.com.ar comisión directiva"
];

// Barrido general de Google Noticias: solo lo de los últimos 2 días, para que lo más nuevo no quede fuera del tope de resultados.
const RECENT_QUERIES = [
  "Vélez Sarsfield",
  "Club Atlético Vélez Sarsfield",
  "Vélez Sarsfield elecciones",
  "Vélez Sarsfield candidato presidente",
  "Vélez Sarsfield asamblea",
  "Vélez Sarsfield dirigencia",
  "Fortín elecciones agrupaciones",
  "site:velez.com.ar",
  "site:tribuna.ar Vélez",
  "site:dobleamarilla.com.ar Vélez"
];

const MUST_BE_VELEZ = /sarsfield|fort[ií]n|amalfitani|berlanga|pugliese|balestrini|ballestrini|bragarnik|g[aá]mez|legado v[eé]lez|primero v[eé]lez|adn azul|mazz?itelli|juan cruz montero|club atl[eé]tico v[eé]lez|presidente de v[eé]lez|oficialismo de v[eé]lez|(elecciones|comicios|candidat\w+|lista|socios|presidencia)\s+(en|de|a)\s+v[eé]lez/i;
const MUST_BE_ELECTION = /elecci|comicios|candidat|presidencia de v|agrupaci|legado v[eé]lez|primero v[eé]lez|adn azul|renovadora|padr[oó]n|junta electoral|encuesta|sondeo|intenci[oó]n de voto|listas? (de|para|opositora)/i;
const POLL_WORDS = /encuesta|sondeo|intenci[oó]n de voto|relevamiento de opini/i;

// Señales para que una persona revise los datos (se escriben en data/review.json).
const CANDIDACY = /candidat[oa]s? a (la )?presiden|lanz[oó] (su )?candidatura|encabezar[aá] (la )?lista|nuevo candidato|nueva lista|oficializ[oó] (su )?(lista|candidatura)/i;
const WITHDRAWAL = /se baj[oó]|declin[oó]|renunci[oó] a (su )?candidatura|retir[oó] (su )?candidatura|baja de (su )?candidatura|no ser[aá] candidato|no ir[aá] de candidato/i;
const STATEMENT = /entrevista|propuest|plan |proyecto|dijo|asegur[oó]|anunci[oó]|habl[oó]|declar[oó]|plataforma|spot/i;

// Etiquetas por candidato, a partir de los alias de data/candidates.json.
function escapeRe(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function buildTags(candidates) {
  const tags = {};
  for (const candidate of candidates) {
    const aliases = (candidate.aliases || []).filter(Boolean).map(escapeRe);
    if (aliases.length) tags[candidate.id] = new RegExp(aliases.join("|"), "i");
  }
  return tags;
}

export function validate(candidatesPayload, quizPayload) {
  const errors = [];
  const candidates = candidatesPayload && candidatesPayload.candidates;
  const questions = quizPayload && quizPayload.questions;
  if (!Array.isArray(candidates) || !candidates.length) errors.push("candidates.json no tiene candidatos");
  if (!Array.isArray(questions) || !questions.length) errors.push("quiz.json no tiene preguntas");
  if (errors.length) return errors;
  const topics = new Set((candidatesPayload.topics || []).map((t) => t.id));
  const byQuestion = new Map(questions.map((q) => [q.id, new Set((q.options || []).map((o) => o.id))]));
  const seen = new Set();
  for (const c of candidates) {
    if (!c.id || seen.has(c.id)) errors.push("id repetido o vacío: " + c.id);
    seen.add(c.id);
    const where = c.id + ": ";
    for (const [topic, items] of Object.entries(c.positions || {})) {
      if (!topics.has(topic)) errors.push(where + "tema desconocido " + topic);
      for (const item of items || []) {
        if (!item.summary) errors.push(where + "postura sin resumen en " + topic);
        if (!/^https?:\/\//.test(item.url || "")) errors.push(where + "postura sin enlace en " + topic + ": " + item.summary);
        if (item.date && Number.isNaN(Date.parse(item.date))) errors.push(where + "fecha inválida en " + topic);
      }
    }
    for (const [qid, stance] of Object.entries(c.stances || {})) {
      const options = byQuestion.get(qid);
      if (!options) { errors.push(where + "postura para una pregunta que no existe: " + qid); continue; }
      if (!/^https?:\/\//.test(stance.url || "")) errors.push(where + "respuesta sin enlace en " + qid);
      if (!stance.summary) errors.push(where + "respuesta sin resumen en " + qid);
      for (const id of [...(stance.supports || []), ...(stance.partial || [])]) {
        if (!options.has(id)) errors.push(where + "opción inexistente " + id + " en " + qid);
      }
    }
  }
  return errors;
}

const HOSTS = {
  "tribuna.ar": "Tribuna",
  "dobleamarilla.com.ar": "Doble Amarilla",
  "tycsports.com": "TyC Sports",
  "clarin.com": "Clarín",
  "ole.com.ar": "Olé",
  "lanacion.com.ar": "La Nación",
  "infobae.com": "Infobae",
  "newsdigitales.com": "Newsdigitales",
  "velez.com.ar": "Sitio oficial de Vélez",
  "cemba.com.ar": "Diario CEMBA",
  "lapostadiario.com": "La Posta Diario",
  "msn.com": "MSN",
  "tn.com.ar": "TN",
  "perfil.com": "Perfil",
  "pagina12.com.ar": "Página/12",
  "espn.com.ar": "ESPN",
  "espn.com": "ESPN",
  "bolavip.com": "Bolavip",
  "mundoalbiceleste.com": "Mundo Albiceleste",
  "elgrafico.com.ar": "El Gráfico",
  "ambito.com": "Ámbito",
  "cronista.com": "El Cronista",
  "iprofesional.com": "iProfesional",
  "totalnews.com.ar": "Total News",
  "futbolprimera.com.ar": "Fútbol Primera",
  "dsports.com.ar": "DSports",
  "diariopopular.com.ar": "Diario Popular",
  "lavoz.com.ar": "La Voz",
  "eldiadegolpe.com": "Olé",
  "muynews.com": "MUY News",
  "canal26.com": "Canal 26",
  "rbdradio.com.ar": "RBD Radio",
  "youtube.com": "YouTube",
  "reddit.com": "Reddit · r/VelezSarsfield"
};

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function sourceName(url, fallback) {
  const host = hostOf(url);
  if (HOSTS[host]) return HOSTS[host];
  const root = host.split(".").slice(-3).join(".");
  if (HOSTS[root]) return HOSTS[root];
  const parent = host.split(".").slice(-2).join(".");
  if (HOSTS[parent]) return HOSTS[parent];
  if (fallback) return fallback;
  return host;
}

function decode(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const match = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return match ? match[1] : "";
}

function attr(block, name, attribute) {
  const match = block.match(new RegExp("<" + name + "\\s[^>]*" + attribute + "=\"([^\"]*)\"", "i"));
  return match ? match[1] : "";
}

function parseFeed(xml, origin) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of blocks) {
    let title = decode(tag(block, "title"));
    let link = decode(tag(block, "link"));
    const description = decode(tag(block, "description"));
    const published = new Date(decode(tag(block, "pubDate")));
    let outlet = decode(tag(block, "News:Source")) || decode(tag(block, "source"));
    const outletUrl = attr(block, "source", "url");

    if (origin === "bing") {
      try {
        const real = new URL(link).searchParams.get("url");
        if (real) link = real;
      } catch { /* queda el enlace original */ }
    } else if (origin === "google") {
      const suffix = outlet ? " - " + outlet : "";
      if (suffix && title.endsWith(suffix)) title = title.slice(0, -suffix.length);
    }

    if (!title || !link || Number.isNaN(published.getTime())) continue;
    items.push({
      title,
      description: origin === "google" ? "" : description,
      url: link,
      published: published.toISOString(),
      source: sourceName(origin === "google" && outletUrl ? outletUrl : link, outlet),
      origin
    });
  }
  return items;
}

function parseAtom(xml, feed) {
  const items = [];
  for (const block of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
    const title = decode(tag(block, "title"));
    const link = (block.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    const published = new Date(decode(tag(block, "updated")) || decode(tag(block, "published")));
    const description = decode(tag(block, "content")).replace(/submitted by.*$/i, "").trim();
    if (!title || !link || Number.isNaN(published.getTime())) continue;
    items.push({ title, description, url: decode(link), published: published.toISOString(), source: feed.name, origin: "feed", kind: feed.kind, club: Boolean(feed.club) });
  }
  return items;
}

// Feeds directos de medios y de la comunidad de hinchas (data/sources.json).
async function readFeeds(feeds) {
  const found = [];
  for (const feed of feeds) {
    try {
      const xml = await get(feed.url);
      const items = /<entry[\s>]/.test(xml) && !/<item[\s>]/.test(xml)
        ? parseAtom(xml, feed)
        : parseFeed(xml, "feed").map((item) => ({ ...item, kind: feed.kind, club: Boolean(feed.club), source: feed.kind === "community" ? feed.name : item.source }));
      found.push(...items);
    } catch (error) {
      console.warn("Feed falló:", feed.url, String(error));
    }
    if (feed.kind === "community") await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return found;
}

async function get(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; VelezElecciones/1.0)", "accept-language": "es-AR,es;q=0.9" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(response.status + " " + url);
  return response.text();
}

async function search(query, window = "60d", withBing = true) {
  const found = [];
  const bing = "https://www.bing.com/news/search?q=" + encodeURIComponent(query) + "&format=rss&setlang=es-AR&cc=AR";
  const google = "https://news.google.com/rss/search?q=" + encodeURIComponent(query + " when:" + window) + "&hl=es-419&gl=AR&ceid=AR:es-419";
  const [b, g] = await Promise.allSettled([withBing ? get(bing) : Promise.resolve(null), get(google)]);
  if (b.status === "fulfilled" && b.value) found.push(...parseFeed(b.value, "bing"));
  else if (b.status === "rejected") console.warn("Bing falló:", query, String(b.reason));
  if (g.status === "fulfilled") found.push(...parseFeed(g.value, "google"));
  else console.warn("Google falló:", query, String(g.reason));
  return found;
}

function normalize(title) {
  return title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

let TAGS = {};

// Posts de hinchas: alcanza con que hablen de la elección del club (el subreddit ya es de Vélez).
const COMMUNITY_ELECTION = /elecciones|comicios|candidat[oa]|junta electoral|padr[oó]n|agrupaci[oó]n/i;
const COMMUNITY_CLUB = /club|socios?|presiden|lista|agrupaci|candidat|junta|comisi[oó]n/i;

// Vida institucional del club que mira quien vota (asambleas, balance, padrón, estatuto, dirigencia).
const INSTITUTIONAL = /asamblea|memoria y balance|junta electoral|padr[oó]n|estatuto|comisi[oó]n directiva|cuota social|sociedad an[oó]nima|dirigencia|oficialismo|oposici[oó]n/i;
// Notas de partido o de mercado de pases: no son de la elección aunque nombren a la dirigencia.
const MATCHDAY = /\bvs\.?\b|en vivo|alineaciones|formaciones|estad[ií]sticas|pron[oó]stico|resultado|\bgoles?\b|previa|d[oó]nde ver|tabla|fecha \d+|fichaje|refuerzo|mercado de pases|renov[oó] (su )?contrato|extiende su contrato/i;
// Otros "Vélez" (Vélez-Málaga, política de España o de México) que no tienen nada que ver con el club.
const OTHER_VELEZ = /m[aá]laga|psoe|ayuntamiento|alcalde|tabasco|morena|lleida|catalu[ñn]a/i;

function isRelevant(item) {
  const text = item.title + " " + item.description;
  if (OTHER_VELEZ.test(text)) return false;
  if (item.kind === "community") {
    const named = Object.values(TAGS).some((re) => re.test(text));
    return (COMMUNITY_ELECTION.test(item.title) && COMMUNITY_CLUB.test(text)) || (named && COMMUNITY_ELECTION.test(text));
  }
  const known = /v[eé]lez|fort[ií]n/i.test(text) && Object.values(TAGS).some((re) => re.test(text));
  const tagged = Object.values(TAGS).some((re) => re.test(text));
  // El título tiene que hablar de la elección; la descripción sola alcanza solo si nombra a un candidato.
  const election = MUST_BE_ELECTION.test(item.title) || (tagged && MUST_BE_ELECTION.test(item.description || ""));
  const institutional = INSTITUTIONAL.test(item.title) && !MATCHDAY.test(item.title);
  // Las notas del sitio oficial son de Vélez aunque el título no lo diga; las de las secciones de Vélez de los medios, solo si hablan de vida institucional.
  if (item.source === "Sitio oficial de Vélez") return election || institutional;
  if (item.club && institutional && !/dalmacio/i.test(text)) return true;
  // En vida institucional alcanza con que el título nombre a Vélez ("Vélez fijó la fecha de la Asamblea").
  const velezInTitle = /\bv[eé]lez\b/i.test(item.title) && !/dalmacio|v[eé]lez[- ]m[aá]laga/i.test(item.title);
  return ((MUST_BE_VELEZ.test(text) || known) && election) || (velezInTitle && institutional);
}

function tagsFor(item) {
  const text = item.title + " " + item.description;
  return Object.keys(TAGS).filter((key) => TAGS[key].test(text));
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA, file), "utf8")); } catch { return fallback; }
}

async function main() {
  await mkdir(DATA, { recursive: true });
  const now = new Date();
  const oldest = now.getTime() - MAX_AGE_DAYS * 86400000;

  // Candidatos y test son la fuente de verdad. Si no cumplen las reglas, no se publica nada.
  const candidatesPayload = await readJson("candidates.json", null);
  const quizPayload = await readJson("quiz.json", null);
  const errors = validate(candidatesPayload, quizPayload);
  if (errors.length) {
    console.error("Datos inválidos, no se publica nada:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  const candidates = candidatesPayload.candidates.filter((c) => c.status !== "withdrawn");
  TAGS = buildTags(candidates);

  // --bundle-only: solo regenera data/live.js con lo que ya hay en data/ (se usa después de refresh-profiles).
  if (process.argv.includes("--bundle-only")) {
    const live = {
      news: await readJson("news.json", { items: [] }),
      polls: await readJson("polls.json", { polls: [], mentions: [] }),
      candidates: candidatesPayload,
      quiz: quizPayload
    };
    await writeFile(path.join(DATA, "live.js"), "window.VELEZ_DATA = " + JSON.stringify(live) + ";\n");
    console.log("live.js regenerado.");
    return;
  }

  const queries = [...NEWS_QUERIES];
  for (const c of candidates) {
    queries.push("Vélez elecciones " + c.name + (c.group ? " " + c.group : ""));
    queries.push("\"" + c.name + "\" Vélez entrevista propuestas");
  }

  const all = [];
  for (const query of queries) {
    try { all.push(...await search(query)); } catch (error) { console.warn("Búsqueda falló:", query, String(error)); }
  }
  // Barrido general de los últimos 2 días en Google Noticias (el filtro de relevancia descarta lo que no es de la elección ni del club).
  for (const query of RECENT_QUERIES) {
    try { all.push(...await search(query, "2d", false)); } catch (error) { console.warn("Barrido falló:", query, String(error)); }
  }
  const sourcesPayload = await readJson("sources.json", { feeds: [], listed: [] });
  all.push(...await readFeeds(Array.isArray(sourcesPayload.feeds) ? sourcesPayload.feeds : []));

  const byTitle = new Map();
  for (const item of all) {
    if (!isRelevant(item)) continue;
    if (new Date(item.published).getTime() < oldest) continue;
    if (new Date(item.published).getTime() > now.getTime() + 86400000) continue;
    const key = normalize(item.title);
    const prev = byTitle.get(key);
    // Preferimos el enlace directo (Bing) al de Google News.
    if (!prev || (prev.origin === "google" && item.origin === "bing")) byTitle.set(key, item);
  }

  const previous = await readJson("news.json", { items: [] });
  const previousItems = (previous.items || []).filter((item) => item && item.title && item.url && item.published);
  for (const item of previousItems) {
    if (!isRelevant({ title: item.title, description: item.summary || "", kind: item.kind, source: item.source, club: item.club })) continue;
    const key = normalize(item.title);
    if (!byTitle.has(key) && new Date(item.published).getTime() >= oldest) byTitle.set(key, { ...item, description: item.description || "" });
  }

  const words = (title) => new Set(normalize(title).split(" ").filter((word) => word.length > 2));
  const similar = (a, b) => {
    const wa = words(a); const wb = words(b);
    let common = 0;
    wa.forEach((word) => { if (wb.has(word)) common += 1; });
    return common / Math.max(1, Math.min(wa.size, wb.size)) >= 0.7;
  };
  const kept = [];
  for (const item of [...byTitle.values()].sort((a, b) => new Date(b.published) - new Date(a.published))) {
    const twin = kept.findIndex((other) => other.source === item.source && similar(other.title, item.title));
    if (twin === -1) kept.push(item);
    else if (kept[twin].origin === "google" && item.origin === "bing") kept[twin] = item;
  }

  // Los posts de la comunidad suman, pero no desplazan a las notas de medios.
  const MAX_COMMUNITY = 4;
  const fromMedia = kept.filter((item) => item.kind !== "community");
  const fromCommunity = kept.filter((item) => item.kind === "community").slice(0, MAX_COMMUNITY);
  const mixed = [...fromMedia.slice(0, MAX_NEWS - fromCommunity.length), ...fromCommunity]
    .sort((a, b) => new Date(b.published) - new Date(a.published));

  const news = mixed
    .map((item) => ({
      title: item.title,
      summary: item.description && normalize(item.description) !== normalize(item.title) ? item.description.slice(0, 260) : "",
      url: item.url,
      source: item.source,
      published: item.published,
      tags: tagsFor(item),
      ...(item.kind === "community" ? { kind: "community" } : {}),
      ...(item.club ? { club: true } : {})
    }));

  const fetchedAnything = all.length > 0;
  const newsPayload = fetchedAnything || previousItems.length
    ? { updated: now.toISOString(), checkedAt: now.toISOString(), items: news }
    : previous;
  if (!fetchedAnything) {
    console.warn("No se pudo leer ninguna fuente. Se conserva lo anterior.");
    newsPayload.checkedAt = previous.checkedAt || previous.updated || now.toISOString();
  } else if (JSON.stringify(previous.items || []) === JSON.stringify(news)) {
    newsPayload.updated = previous.updated || newsPayload.updated;
  }

  newsPayload.sources = Array.isArray(sourcesPayload.listed) ? sourcesPayload.listed : [];

  const pollsPrev = await readJson("polls.json", { polls: [], mentions: [] });
  const mentions = news.filter((item) => POLL_WORDS.test(item.title + " " + item.summary)).slice(0, 6);
  const pollsPayload = {
    updated: pollsPrev.updated || now.toISOString(),
    checkedAt: fetchedAnything ? now.toISOString() : (pollsPrev.checkedAt || now.toISOString()),
    polls: Array.isArray(pollsPrev.polls) ? pollsPrev.polls : [],
    mentions
  };

  // Señales para revisar a mano: candidatos nuevos, bajas y notas con declaraciones más nuevas que los datos.
  const reviewPrev = await readJson("review.json", { flags: [] });
  const knownFlags = new Map((reviewPrev.flags || []).map((flag) => [flag.url, flag]));
  const cited = new Set();
  const latest = {};
  for (const c of candidates) {
    const dates = [];
    for (const items of Object.values(c.positions || {})) {
      for (const item of items || []) { cited.add(item.url); if (item.date) dates.push(Date.parse(item.date)); }
    }
    for (const stance of Object.values(c.stances || {})) {
      cited.add(stance.url);
      if (stance.date) dates.push(Date.parse(stance.date));
    }
    latest[c.id] = dates.length ? Math.max(...dates) : 0;
  }
  const flags = [];
  for (const item of byTitle.values()) {
    if (Date.parse(item.published) < now.getTime() - 14 * 86400000) continue;
    if (item.kind === "community") continue;
    const text = item.title + " " + (item.description || "");
    const tags = tagsFor(item);
    let kind = null;
    if (WITHDRAWAL.test(text)) kind = "posible-baja";
    else if (CANDIDACY.test(text) && !tags.length) kind = "posible-candidato-nuevo";
    else if (tags.length && STATEMENT.test(item.title) && !cited.has(item.url)
      && tags.some((id) => Date.parse(item.published) > (latest[id] || 0) + 86400000)) kind = "posible-postura-nueva";
    if (!kind) continue;
    const previousFlag = knownFlags.get(item.url);
    flags.push({
      kind, title: item.title, url: item.url, source: item.source, published: item.published, tags,
      firstSeen: previousFlag ? previousFlag.firstSeen : now.toISOString()
    });
  }
  const freshFlags = flags.filter((flag) => !knownFlags.has(flag.url));
  const reviewPayload = { checkedAt: now.toISOString(), flags };

  await writeFile(path.join(DATA, "news.json"), JSON.stringify(newsPayload, null, 2) + "\n");
  await writeFile(path.join(DATA, "polls.json"), JSON.stringify(pollsPayload, null, 2) + "\n");
  await writeFile(path.join(DATA, "review.json"), JSON.stringify(reviewPayload, null, 2) + "\n");
  const live = { news: newsPayload, polls: pollsPayload, candidates: candidatesPayload, quiz: quizPayload };
  await writeFile(path.join(DATA, "live.js"), "window.VELEZ_DATA = " + JSON.stringify(live) + ";\n");

  // En GitHub Actions avisa si hay algo nuevo para revisar (el flujo abre un issue).
  const bodyFile = process.env.REVIEW_BODY_FILE;
  if (bodyFile) {
    const label = { "posible-baja": "Posible baja", "posible-candidato-nuevo": "Posible candidato nuevo", "posible-postura-nueva": "Declaración más nueva que los datos" };
    const lines = freshFlags.map((flag) => `- **${label[flag.kind]}** · ${flag.source}, ${flag.published.slice(0, 10)}: [${flag.title}](${flag.url})${flag.tags.length ? " (" + flag.tags.join(", ") + ")" : ""}`);
    await writeFile(bodyFile, "Notas nuevas para revisar contra `data/candidates.json`:\n\n" + lines.join("\n") + "\n\nSi cambia algo (candidato, agrupación, postura), editá `data/candidates.json` con la fuente y la fecha.\n");
  }
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `new_flags=${freshFlags.length}\n`, { flag: "a" });
  }

  console.log(`Candidatos activos: ${candidates.length}. Noticias: ${news.length}. Sondeos cargados: ${pollsPayload.polls.length}. Notas que mencionan encuestas: ${mentions.length}. Para revisar: ${flags.length} (${freshFlags.length} nuevas).`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
