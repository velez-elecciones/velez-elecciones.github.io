// Actualiza solo las posturas, perfiles y respuestas del test a partir de notas recientes.
// Lee data/news.json, baja cada nota nueva, pide a un modelo de lenguaje que extraiga lo que dijo
// cada candidato y SOLO guarda lo que trae una cita textual que aparece en la nota.
//
// Variables de entorno:
//   GEMINI_API_KEY    clave gratuita de Google AI Studio (https://aistudio.google.com/apikey)
//   ANTHROPIC_API_KEY o OPENAI_API_KEY   (alternativas, de pago)
//   LLM_MODEL         opcional (por defecto gemini-3.5-flash-lite en Gemini)
//   LLM_PROVIDER      opcional: gemini | anthropic | openai | mock
//   Si no hay ninguna clave, el script no hace nada y termina bien.
//   DATA_DIR           opcional, carpeta de datos (para pruebas)
//   MOCK_ARTICLES_FILE y MOCK_LLM_FILE: solo con LLM_PROVIDER=mock (pruebas sin red)
//   CHANGELOG_FILE     opcional: ruta donde dejar un resumen de cambios en texto

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./update-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");

const MAX_ARTICLES = 12;
const MAX_AGE_DAYS = 14;
const MAX_PER_TOPIC = 5;
const MIN_TEXT = 500;
const MAX_TEXT = 7500;
const LEDGER_MAX = 600;
const CONFIRM_HOSTS = 2;
const PENDING_DAYS = 30;
const PALETTE = ["#7c3aed", "#0f766e", "#b45309", "#be185d", "#4d7c0f", "#475569"];

const provider = (process.env.LLM_PROVIDER ||
  (process.env.GEMINI_API_KEY ? "gemini" : process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : "")).toLowerCase();

// DRY_RUN=1: no escribe nada, solo muestra qué se guardaría. FORCE_ALL=1: vuelve a leer notas ya procesadas o citadas.
const DRY = process.env.DRY_RUN === "1";
const FORCE = process.env.FORCE_ALL === "1";

class ModelError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA, file), "utf8")); } catch { return fallback; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function norm(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”«»„"]/g, '"').replace(/[‘’`´]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(text) {
  return norm(text).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function escapeRe(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

const NAMED_ENTITIES = {
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", agrave: "à", egrave: "è", ccedil: "ç", iquest: "¿", iexcl: "¡",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", deg: "°"
};

function decodeEntities(text) {
  return text
    .replace(/&([a-zA-Z]+);/g, (whole, name) => (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : whole))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function articleText(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|noscript|figure)[\s\S]*?<\/\1>/gi, " ");
  const paragraphs = (cleaned.match(/<(p|h1|h2|h3|li|blockquote)[^>]*>[\s\S]*?<\/\1>/gi) || [])
    .map((block) => decodeEntities(
      block
        .replace(/<\/?(a|b|i|em|strong|span|u|mark|small|sup|sub|font)(\s[^>]*)?>/gi, "") // etiquetas en línea: no agregan espacio
        .replace(/<[^>]+>/g, " ")
    ).replace(/\s+/g, " ").replace(/\s+([.,;:!?)])/g, "$1").trim())
    .filter((line) => line.length > 40);
  return paragraphs.join("\n").slice(0, MAX_TEXT);
}

// Los enlaces de Google Noticias son redirecciones: se resuelve la nota real para poder leerla y citarla con su medio.
// Si Google cambia el mecanismo, falla sin romper nada y la nota queda sin leer.
async function resolveGoogleNews(url) {
  const id = new URL(url).pathname.split("/").pop();
  try {
    const raw = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const direct = raw.match(/https?:\/\/[\x21-\x7e]+/);
    if (direct) return direct[0];
  } catch { /* se sigue con el otro método */ }
  const agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const page = await fetch("https://news.google.com/rss/articles/" + id + "?hl=es-419&gl=AR&ceid=AR:es-419", {
    headers: { "user-agent": agent }, signal: AbortSignal.timeout(15000)
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
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": agent },
    body: "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]])),
    signal: AbortSignal.timeout(15000)
  });
  const found = (await response.text()).match(/garturlres\\",\\"(https?:[^"\\]+)/);
  if (!found) throw new Error("Google Noticias no devolvió la nota (" + response.status + ")");
  return JSON.parse('"' + found[1] + '"');
}

async function download(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; VelezElecciones/1.0)", "accept-language": "es-AR,es;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
}

function buildPrompt(article, text, candidates, topics, questions) {
  const cand = candidates.map((c) => `- ${c.id}: ${c.name} (${(c.aliases || []).join(", ")})`).join("\n");
  const tops = topics.map((t) => `- ${t.id}: ${t.label}`).join("\n");
  const qs = questions.map((q) => `- ${q.id}: ${q.title}\n${q.options.map((o) => `    · ${o.id}: ${o.text}`).join("\n")}`).join("\n");
  return `Sos un asistente que extrae declaraciones de la nota periodística de abajo sobre las elecciones de Vélez Sarsfield (15/11/2026). Respondé SOLO con un objeto JSON, sin texto extra.

CANDIDATOS CONOCIDOS
${cand}

TEMAS PARA "positions"
${tops}

PREGUNTAS DEL TEST PARA "stances"
${qs}

REGLAS
1. Tema "formula": solo cuando la nota nombra al compañero o compañera de fórmula (vicepresidente) o informa un cambio en la fórmula. Que alguien sea candidato a presidente por una agrupación NO es "formula": va en "vinculos" o "perfil".
   Temas "formula", "perfil" y "vinculos" (fórmula, trayectoria y alianzas): podés incluir hechos CONFIRMADOS que la nota informe sobre el candidato (quién lo acompaña en la fórmula, su cargo o trayectoria, qué agrupaciones o dirigentes lo apoyan), aunque los cuente el periodista. Solo hechos presentados como ciertos ("presentó", "anunció", "confirmó", "acompañará", "fue elegido"). Nunca rumores ni condicionales ("iría", "sería", "podría", "se especula", "trascendió").
   En el resto de los temas y en "stances" solo incluí lo que el candidato dijo o propuso según la nota. En todos los casos: no infieras, no completes con conocimiento previo, no uses opiniones del periodista.
2. Cada ítem lleva "quote": una cita TEXTUAL, copiada igual que en la nota (entre 25 y 300 caracteres). Si no hay una cita textual que lo respalde, no incluyas el ítem.
3. "summary" en español rioplatense neutro, máximo 220 caracteres, en tercera persona, sin adjetivos valorativos.
4. En "stances", "supports" lista las opciones que la declaración respalda claramente y "partial" las que respalda en parte. Si no está claro, usá listas vacías o no incluyas el ítem.
5. Si la nota informa un CAMBIO (otro compañero de fórmula, una alianza nueva, un apoyo que se retira, una fusión de listas), registralo en el tema que corresponda con la cita del hecho nuevo, y en el resumen contá cómo quedó la situación actual.
6. Si la nota informa que un candidato conocido se bajó, declinó o retiró su candidatura, ponelo en "withdrawals" con la cita. Si la misma cita dice que se suma a la lista de otro candidato conocido (fusión o acuerdo), poné en "joins" el id de ese candidato; si no, dejalo vacío.
7. Si la nota informa que un candidato conocido pasó a competir bajo otro nombre de agrupación, frente o lista (por una fusión o un acuerdo), ponelo en "groupChanges" con el nombre nuevo tal como lo escribe la nota y la cita.
8. Si la nota informa de una candidatura a presidente de Vélez de alguien que NO está en la lista, ponela en "newCandidates" con la cita.
9. Si la nota no trae nada de esto, devolvé las listas vacías.

FORMATO
{"positions":[{"candidate":"id","topic":"id","summary":"...","quote":"..."}],
 "stances":[{"candidate":"id","question":"id","supports":["optionId"],"partial":["optionId"],"summary":"...","quote":"..."}],
 "withdrawals":[{"candidate":"id","joins":"id o vacío","quote":"..."}],
 "groupChanges":[{"candidate":"id","group":"nombre nuevo","quote":"..."}],
 "newCandidates":[{"name":"...","role":"Candidato a presidente","group":"agrupación o vacío","quote":"..."}]}

NOTA
Título: ${article.title}
Medio: ${article.source}
Fecha: ${article.published.slice(0, 10)}
Texto:
${text}`;
}

async function askModel(prompt, article) {
  if (provider === "mock") {
    const map = JSON.parse(await readFile(process.env.MOCK_LLM_FILE, "utf8"));
    return JSON.stringify(map[article.url] || {});
  }
  if (provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.LLM_MODEL || "claude-sonnet-4-5", max_tokens: 2000, temperature: 0, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) throw new ModelError("Anthropic " + response.status + " " + (await response.text()).slice(0, 200), response.status);
    const body = await response.json();
    return (body.content || []).map((part) => part.text || "").join("");
  }
  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ model: process.env.LLM_MODEL || "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) throw new ModelError("OpenAI " + response.status + " " + (await response.text()).slice(0, 200), response.status);
    const body = await response.json();
    return body.choices?.[0]?.message?.content || "";
  }
  if (provider === "gemini") {
    const model = process.env.LLM_MODEL || "gemini-3.5-flash-lite";
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" }
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) throw new ModelError("Gemini " + response.status + " " + (await response.text()).slice(0, 200), response.status);
    const body = await response.json();
    return (body.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  }
  throw new Error("Proveedor no soportado: " + provider);
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function quoteOk(quote, haystack) {
  const q = norm(quote);
  return q.length >= 25 && q.length <= 320 && haystack.includes(q);
}

function mentions(candidate, haystack) {
  const names = [candidate.name, ...(candidate.aliases || [])].filter(Boolean).map(norm);
  return names.some((name) => name && haystack.includes(name));
}

// Hechos (fórmula, perfil, alianzas, bajas, fusiones) no se registran si la cita es un rumor o un condicional ("iría", "sería", "habría").
const NOUN_RIA = /(?:secretar|tesorer|galer|categor|alegr|gestor|mayor|minor|teor|auditor|consultor|librer|ferreter|panader|zapater|carnicer|pizzer|cafeter|sastrer|peluquer|joyer|relojer|mercer|geograf)[ií]a/g;
function isTentative(text) {
  const t = String(text || "").normalize("NFC").toLowerCase().replace(NOUN_RIA, " ");
  return /[a-záéíóúñ]+rí(?:a|as|an|amos)\b/.test(t) || /\b(?:se especula|trascendi[oó]|trascendidos|al parecer|de confirmarse|rumor(?:es)?)\b/.test(t);
}

// Los nombres propios del resumen tienen que estar en la nota: si el modelo deforma una palabra, el ítem se descarta.
function namesOk(summary, haystack) {
  return String(summary || "").split(/(?<=[.!?:])\s+/).every((sentence) =>
    sentence.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(1)
      .every((word) => word.length < 4 || !/^\p{Lu}/u.test(word) || haystack.includes(norm(word))));
}

const FACT_TOPICS = new Set(["formula", "perfil", "vinculos"]);

// Motivo por el que se descarta una propuesta del modelo ("" si se acepta).
function whyRejected(kind, p, candidate, haystack) {
  if (!p || !candidate) return "candidato desconocido";
  if (!quoteOk(p.quote, haystack)) return "la cita NO aparece textual en la nota";
  if (!mentions(candidate, haystack)) return "el candidato no se nombra en la nota";
  if (p.summary && !namesOk(p.summary, haystack)) return "el resumen nombra algo que no está en la nota";
  const factual = !(kind === "postura" || kind === "test") || FACT_TOPICS.has(p.topic);
  if (factual && isTentative(p.quote)) return "la cita es un rumor o está en condicional";
  return "";
}

// Citas propuestas por el modelo que no están en la nota (letras cambiadas, texto inventado).
function brokenQuotes(result, haystack) {
  const all = ["positions", "stances", "withdrawals", "groupChanges", "newCandidates"].flatMap((key) => (Array.isArray(result[key]) ? result[key] : []));
  return all.filter((p) => p && p.quote && !quoteOk(p.quote, haystack)).map((p) => String(p.quote).slice(0, 320));
}

async function main() {
  if (!provider) {
    console.log("No hay GEMINI_API_KEY (ni otra clave): se saltea la actualización automática de posturas. Noticias y sondeos siguen funcionando.");
    return;
  }
  // --selftest: solo comprueba que el modelo responde (se lanza a mano desde GitHub Actions).
  if (process.argv.includes("--selftest")) {
    const answer = await askModel('Respondé solo con este JSON, sin texto extra: {"ok":true}', { url: "selftest" });
    console.log("Respuesta del modelo (" + provider + "):", answer.slice(0, 200));
    if (!parseJson(answer)) { console.error("La respuesta no es JSON."); process.exit(1); }
    return;
  }
  await mkdir(DATA, { recursive: true });
  const now = new Date();
  const candidatesPayload = await readJson("candidates.json", null);
  const quizPayload = await readJson("quiz.json", null);
  const newsPayload = await readJson("news.json", { items: [] });
  const ledger = await readJson("processed.json", { items: {} });
  const pending = await readJson("pending.json", { withdrawals: {}, newCandidates: {}, groups: {} });
  pending.withdrawals = pending.withdrawals || {};
  pending.newCandidates = pending.newCandidates || {};
  pending.groups = pending.groups || {};
  // Lo que no se confirma en un mes se descarta: una novedad aislada no pesa para siempre.
  const expireAt = now.getTime() - PENDING_DAYS * 86400000;
  for (const key of ["withdrawals", "groups"]) {
    for (const id of Object.keys(pending[key])) {
      pending[key][id] = (pending[key][id] || []).filter((hit) => Date.parse(hit.date) >= expireAt);
      if (!pending[key][id].length) delete pending[key][id];
    }
  }
  for (const id of Object.keys(pending.newCandidates)) {
    pending.newCandidates[id].sources = (pending.newCandidates[id].sources || []).filter((hit) => Date.parse(hit.date) >= expireAt);
    if (!pending.newCandidates[id].sources.length) delete pending.newCandidates[id];
  }
  const changelog = await readJson("changelog.json", { entries: [] });
  if (validate(candidatesPayload, quizPayload).length) {
    console.error("Los datos actuales no son válidos; no se toca nada.");
    process.exit(1);
  }

  const active = () => candidatesPayload.candidates.filter((c) => c.status !== "withdrawn");
  const topics = candidatesPayload.topics;
  const questions = quizPayload.questions;
  const cited = new Set();
  for (const c of candidatesPayload.candidates) {
    for (const items of Object.values(c.positions || {})) items.forEach((item) => cited.add(item.url));
    Object.values(c.stances || {}).forEach((s) => cited.add(s.url));
  }

  // En la prueba en seco con FORCE_ALL se parte de perfiles vacíos (en memoria) para ver todo lo que se extraería.
  if (DRY && FORCE) {
    for (const c of candidatesPayload.candidates) {
      c.positions = Object.fromEntries(Object.keys(c.positions || {}).map((k) => [k, []]));
      c.stances = {};
    }
  }
  const write = DRY ? async () => {} : writeFile;
  const oldest = now.getTime() - MAX_AGE_DAYS * 86400000;
  const queue = (newsPayload.items || [])
    .filter((item) => item && isHttp(item.url) && item.title && Date.parse(item.published) >= oldest)
    .filter((item) => FORCE || (!seenBefore(ledger.items[item.url], now) && !cited.has(item.url)))
    .filter((item) => item.kind !== "community" && !/reddit\.com|youtube\.com/.test(hostOf(item.url)))
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, MAX_ARTICLES);

  let articles = null;
  if (provider === "mock") articles = JSON.parse(await readFile(process.env.MOCK_ARTICLES_FILE, "utf8"));

  const log = [];
  let changed = false;
  console.log(`Notas por revisar: ${queue.length}. Proveedor: ${provider}.`);

  for (const entry of queue) {
    const item = { ...entry }; // "item.url" pasa a ser la nota real si el enlace era de Google Noticias
    const mark = (result) => {
      const stamp = { at: now.toISOString(), result };
      ledger.items[entry.url] = stamp;
      ledger.items[item.url] = stamp;
    };
    let text = "";
    try {
      if (articles) text = (articles.find((a) => a.url === entry.url) || {}).text || "";
      else {
        if (hostOf(entry.url) === "news.google.com") {
          try { item.url = await resolveGoogleNews(entry.url); } catch (error) {
            console.warn("No se pudo abrir el enlace de Google Noticias:", String(error));
            mark("unresolved");
            continue;
          }
          if (/reddit\.com|youtube\.com/.test(hostOf(item.url))) { mark("skipped"); continue; }
          if (!FORCE && cited.has(item.url)) { mark("cited"); continue; }
        }
        text = articleText(await download(item.url));
      }
    } catch (error) {
      console.warn("No se pudo leer:", item.url, String(error));
      mark("unreadable");
      continue;
    }
    if (text.length < MIN_TEXT) {
      if (DRY) console.log(`\n--- ${item.source}: ${item.title}\n    texto leído: ${text.length} caracteres (insuficiente, se descarta)`);
      mark("unreadable");
      continue;
    }

    const haystack = norm(text);
    let result;
    try {
      const prompt = buildPrompt(item, text, active(), topics, questions);
      const answer = await askModel(prompt, item);
      if (DRY) console.log(`\n--- ${item.source}: ${item.title}\n    texto (inicio): ${text.slice(0, 700).replace(/\s+/g, " ")}\n    respuesta cruda del modelo: ${String(answer).slice(0, 900).replace(/\s+/g, " ")}`);
      result = parseJson(answer);
      // A veces el modelo cambia letras al copiar una cita. Se le pide una sola vez que la corrija; si no, ese ítem se descarta.
      const broken = result && provider !== "mock" ? brokenQuotes(result, haystack) : [];
      if (broken.length) {
        if (DRY) console.log(`    ${broken.length} cita(s) no coinciden con la nota; se le pide corregirlas una vez`);
        const again = parseJson(await askModel(prompt + "\n\nCORRECCIÓN: estas citas tuyas NO aparecen textuales en la nota (cambiaste letras al copiar):\n" +
          broken.map((q) => "- " + q).join("\n") + "\nRespondé de nuevo el JSON completo, copiando cada cita carácter por carácter desde el texto de la nota, o quitá el ítem si no podés.", item));
        if (again) {
          result = again;
          if (DRY) console.log(`    respuesta corregida: ${JSON.stringify(again).slice(0, 700)}`);
        }
      }
    } catch (error) {
      console.warn("El modelo falló:", item.url, String(error));
      // Sin permiso, modelo inexistente o cupo agotado: no tiene sentido seguir con el resto.
      if ([401, 403, 404, 413, 429].includes(error.status)) { console.warn("Se corta esta corrida; se reintenta en la próxima."); break; }
      continue; // sin marcar: se reintenta en la próxima corrida
    }
    if (!result) { mark("invalid"); continue; }

    const date = item.published.slice(0, 10);
    if (DRY) {
      const byId = new Map(active().map((c) => [c.id, c]));
      console.log(`    texto leído: ${text.length} caracteres`);
      const check = (kind, p, extra) => {
        const verdict = whyRejected(kind, p, byId.get(p && p.candidate), haystack) || "ACEPTADA";
        console.log(`    propuesta ${kind} (${p && p.candidate}${extra}): ${verdict}\n      resumen: ${p && (p.summary || p.group)}\n      cita: «${p && p.quote}»`);
      };
      (Array.isArray(result.positions) ? result.positions : []).forEach((p) => check("postura", p, "/" + (p && p.topic)));
      (Array.isArray(result.stances) ? result.stances : []).forEach((p) => check("test", p, "/" + (p && p.question)));
      (Array.isArray(result.withdrawals) ? result.withdrawals : []).forEach((p) => check("baja", p, p && p.joins ? " -> " + p.joins : ""));
      (Array.isArray(result.groupChanges) ? result.groupChanges : []).forEach((p) => check("agrupacion", p, ""));
      console.log(`    candidatos nuevos propuestos: ${(result.newCandidates || []).length}`);
    }
    const candidatesById = new Map(active().map((c) => [c.id, c]));
    const snapshot = JSON.stringify(candidatesPayload);
    const entries = [];

    for (const p of Array.isArray(result.positions) ? result.positions : []) {
      const c = candidatesById.get(p && p.candidate);
      if (!topics.some((t) => t.id === (p && p.topic)) || !p.summary || whyRejected("postura", p, c, haystack)) continue;
      c.positions = c.positions || {};
      const list = (c.positions[p.topic] = c.positions[p.topic] || []);
      if (list.some((x) => x.url === item.url)) continue;
      list.push({ summary: String(p.summary).slice(0, 260), quote: String(p.quote).trim(), source: item.source, url: item.url, date, auto: true });
      // Tope por tema: se descartan las automáticas más viejas, nunca las cargadas a mano.
      while (list.length > MAX_PER_TOPIC) {
        const drop = list.map((x, i) => ({ x, i })).filter((e) => e.x.auto)
          .sort((a, b) => Date.parse(a.x.date || 0) - Date.parse(b.x.date || 0))[0];
        if (!drop) break;
        list.splice(drop.i, 1);
      }
      entries.push(`${c.name}: nueva postura en ${p.topic}`);
    }

    for (const s of Array.isArray(result.stances) ? result.stances : []) {
      const c = candidatesById.get(s && s.candidate);
      const q = questions.find((x) => x.id === (s && s.question));
      if (!q || !s.summary || whyRejected("test", s, c, haystack)) continue;
      const ids = new Set(q.options.map((o) => o.id));
      const supports = (Array.isArray(s.supports) ? s.supports : []).filter((id) => ids.has(id));
      const partial = (Array.isArray(s.partial) ? s.partial : []).filter((id) => ids.has(id) && !supports.includes(id));
      if (!supports.length && !partial.length) continue;
      c.stances = c.stances || {};
      const old = c.stances[q.id];
      if (old && old.date && Date.parse(old.date) >= Date.parse(date)) continue;
      c.stances[q.id] = { supports, partial, summary: String(s.summary).slice(0, 260), quote: String(s.quote).trim(), source: item.source, url: item.url, date, auto: true };
      entries.push(`${c.name}: respuesta del test «${q.id}» actualizada`);
    }

    for (const w of Array.isArray(result.withdrawals) ? result.withdrawals : []) {
      const c = candidatesById.get(w && w.candidate);
      if (whyRejected("baja", w, c, haystack)) continue;
      const joins = candidatesById.has(w.joins) && w.joins !== c.id ? w.joins : "";
      const slot = (pending.withdrawals[c.id] = pending.withdrawals[c.id] || []);
      if (!slot.some((x) => x.url === item.url)) slot.push({ url: item.url, host: hostOf(item.url), date, quote: String(w.quote).trim(), joins });
    }

    for (const g of Array.isArray(result.groupChanges) ? result.groupChanges : []) {
      const c = candidatesById.get(g && g.candidate);
      const group = String((g && g.group) || "").trim();
      if (!c || !group || group.length > 80 || norm(group) === norm(c.group)) continue;
      if (whyRejected("agrupacion", g, c, haystack) || !haystack.includes(norm(group))) continue;
      const slot = (pending.groups[c.id] = pending.groups[c.id] || []);
      if (!slot.some((x) => x.url === item.url)) slot.push({ url: item.url, host: hostOf(item.url), date, group, quote: String(g.quote).trim() });
    }

    for (const n of Array.isArray(result.newCandidates) ? result.newCandidates : []) {
      if (!n || !n.name || !quoteOk(n.quote, haystack) || isTentative(n.quote) || !haystack.includes(norm(n.name))) continue;
      const id = slug(n.name);
      if (!id || candidatesPayload.candidates.some((c) => c.id === id || norm(c.name) === norm(n.name))) continue;
      const slot = (pending.newCandidates[id] = pending.newCandidates[id] || { name: String(n.name).trim(), role: String(n.role || "Candidato a presidente").trim(), group: String(n.group || "").trim(), sources: [] });
      if (!slot.sources.some((x) => x.url === item.url)) slot.sources.push({ url: item.url, host: hostOf(item.url), date, quote: String(n.quote).trim() });
    }

    if (entries.length) {
      const errors = validate(candidatesPayload, quizPayload);
      if (errors.length) {
        Object.assign(candidatesPayload, JSON.parse(snapshot)); // se descarta todo lo de esta nota
        console.warn("Cambios descartados por no pasar la validación:", item.url, errors.slice(0, 3));
        mark("rejected");
        continue;
      }
      changed = true;
      entries.forEach((text2) => log.push({ at: now.toISOString(), text: text2, url: item.url, source: item.source }));
    }
    mark(entries.length ? "applied" : "empty");
  }

  // Bajas y candidatos nuevos: solo cuando al menos dos medios distintos lo informan.
  for (const [id, hits] of Object.entries(pending.withdrawals)) {
    const hosts = new Set(hits.map((h) => h.host));
    const c = candidatesPayload.candidates.find((x) => x.id === id);
    if (c && c.status !== "withdrawn" && hosts.size >= CONFIRM_HOSTS) {
      const latest = [...hits].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
      // Fusión: solo si al menos dos medios distintos dicen que se suma a la misma lista.
      const joinHits = hits.filter((h) => h.joins);
      const target = [...new Set(joinHits.map((h) => h.joins))].find((tid) =>
        new Set(joinHits.filter((h) => h.joins === tid).map((h) => h.host)).size >= CONFIRM_HOSTS &&
        candidatesPayload.candidates.some((x) => x.id === tid && x.status !== "withdrawn"));
      c.status = "withdrawn";
      c.withdrawal = { date: latest.date, source: hostLabel(latest.host), url: latest.url, joins: target || "" };
      changed = true;
      log.push({ at: now.toISOString(), text: `${c.name}: baja de la candidatura confirmada por ${hosts.size} medios`, url: latest.url, source: latest.host });
      if (target) {
        const receiver = candidatesPayload.candidates.find((x) => x.id === target);
        const proof = joinHits.filter((h) => h.joins === target).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
        receiver.positions = receiver.positions || {};
        (receiver.positions.vinculos = receiver.positions.vinculos || []).push({
          summary: `${c.name} bajó su candidatura y se suma a la lista de ${receiver.name}.`,
          quote: proof.quote, source: hostLabel(proof.host), url: proof.url, date: proof.date, auto: true
        });
        log.push({ at: now.toISOString(), text: `${c.name} se suma a la lista de ${receiver.name}`, url: proof.url, source: proof.host });
      }
      delete pending.withdrawals[id];
    }
  }
  // Cambio de agrupación (fusiones): dos medios distintos tienen que coincidir en el nombre nuevo.
  for (const [id, hits] of Object.entries(pending.groups)) {
    const c = candidatesPayload.candidates.find((x) => x.id === id);
    if (!c || c.status === "withdrawn") { delete pending.groups[id]; continue; }
    const names = [...new Set(hits.map((h) => norm(h.group)))];
    const agreed = names.find((name) => new Set(hits.filter((h) => norm(h.group) === name).map((h) => h.host)).size >= CONFIRM_HOSTS);
    if (!agreed) continue;
    const proof = hits.filter((h) => norm(h.group) === agreed).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
    c.group = proof.group;
    c.logo = ""; // el escudo anterior ya no representa a la agrupación
    c.positions = c.positions || {};
    (c.positions.vinculos = c.positions.vinculos || []).push({
      summary: `Pasa a competir como ${proof.group}.`, quote: proof.quote, source: hostLabel(proof.host), url: proof.url, date: proof.date, auto: true
    });
    changed = true;
    log.push({ at: now.toISOString(), text: `${c.name}: ahora compite como ${proof.group}`, url: proof.url, source: proof.host });
    delete pending.groups[id];
  }
  for (const [id, slot] of Object.entries(pending.newCandidates)) {
    const hosts = new Set(slot.sources.map((s) => s.host));
    if (hosts.size < CONFIRM_HOSTS || candidatesPayload.candidates.some((c) => c.id === id)) continue;
    const first = slot.sources[0];
    candidatesPayload.candidates.push({
      id, status: "active", name: slot.name, short: slot.name.split(" ").slice(-1)[0], role: slot.role, group: slot.group,
      color: PALETTE[candidatesPayload.candidates.length % PALETTE.length], photo: "", logo: "",
      aliases: [...new Set([slot.name, slot.name.split(" ").slice(-1)[0]].filter((a) => a.length >= 5))], social: [], positions: {
        perfil: [{ summary: `Los medios informan su candidatura: ${slot.name}${slot.group ? " (" + slot.group + ")" : ""}.`, quote: first.quote, source: hostLabel(first.host), url: first.url, date: first.date, auto: true }]
      }, stances: {}
    });
    changed = true;
    log.push({ at: now.toISOString(), text: `${slot.name}: nuevo candidato informado por ${hosts.size} medios`, url: first.url, source: first.host });
    delete pending.newCandidates[id];
  }

  if (changed) {
    const errors = validate(candidatesPayload, quizPayload);
    if (errors.length) {
      console.error("Resultado inválido, no se guarda:\n - " + errors.join("\n - "));
      process.exit(1);
    }
    candidatesPayload.updated = now.toISOString();
    await write(path.join(DATA, "candidates.json"), JSON.stringify(candidatesPayload, null, 2) + "\n");
  }

  const keep = Object.entries(ledger.items).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, LEDGER_MAX);
  await write(path.join(DATA, "processed.json"), JSON.stringify({ items: Object.fromEntries(keep) }, null, 2) + "\n");
  await write(path.join(DATA, "pending.json"), JSON.stringify(pending, null, 2) + "\n");
  if (log.length) {
    changelog.entries = [...log, ...(changelog.entries || [])].slice(0, 200);
    await write(path.join(DATA, "changelog.json"), JSON.stringify(changelog, null, 2) + "\n");
  }
  if (DRY) {
    console.log("\n=== PRUEBA EN SECO: esto es lo que se guardaría (no se escribió nada) ===");
    for (const c of candidatesPayload.candidates) {
      for (const [topic, items] of Object.entries(c.positions || {})) {
        for (const item of items.filter((x) => x.auto)) console.log(`[${c.name}] ${topic}: ${item.summary}\n    cita: «${item.quote}»\n    ${item.url}`);
      }
      for (const [qid, s] of Object.entries(c.stances || {})) {
        if (s.auto) console.log(`[${c.name}] test ${qid} -> respalda: ${s.supports.join(",") || "-"} | parcial: ${s.partial.join(",") || "-"}: ${s.summary}\n    cita: «${s.quote}»\n    ${s.url}`);
      }
    }
    for (const [id, hits] of Object.entries(pending.withdrawals)) console.log(`[pendiente de confirmar] posible baja de ${id}: ${hits.map((h) => h.host).join(", ")}`);
    for (const [id, hits] of Object.entries(pending.groups)) console.log(`[pendiente de confirmar] posible cambio de agrupación de ${id}: ${hits.map((h) => h.group + " (" + h.host + ")").join(", ")}`);
    for (const [id, slot] of Object.entries(pending.newCandidates)) console.log(`[pendiente de confirmar] posible candidato nuevo ${slot.name}: ${slot.sources.map((s) => s.host).join(", ")}`);
  }
  if (process.env.CHANGELOG_FILE) {
    await write(process.env.CHANGELOG_FILE, log.map((e) => `- ${e.text} ([${e.source}](${e.url}))`).join("\n") + "\n");
  }
  console.log(changed ? `Cambios aplicados: ${log.length}.` : "Sin cambios en candidatos.");
}

function isHttp(url) { return /^https?:\/\//i.test(String(url || "")); }
function hostLabel(host) { return host; }

// Una nota ya vista no se vuelve a leer, salvo los enlaces de Google Noticias que no se pudieron abrir (se reintentan cada 12 horas).
function seenBefore(stamp, now) {
  if (!stamp) return false;
  if (stamp.result === "unresolved") return now.getTime() - Date.parse(stamp.at) < 12 * 3600000;
  return true;
}

main().catch((error) => { console.error(error); process.exit(1); });
