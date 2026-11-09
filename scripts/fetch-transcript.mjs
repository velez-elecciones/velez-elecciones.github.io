// Baja la transcripción de un video de YouTube (los subtítulos que genera YouTube) y la guarda en data/transcripts/<id>.json.
// Uso: node scripts/fetch-transcript.mjs <id o enlace de YouTube>
// Se corre a mano: desde los servidores de GitHub, YouTube suele frenar estas consultas.
// En los vivos, YouTube arma los subtítulos unas horas después de que termina la transmisión.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
// El cliente de la app de Android todavía entrega los subtítulos sin el token que pide la versión web.
const ANDROID = { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "es-419", gl: "AR" };
const MAX_SEGMENT_SECONDS = 30;

export function videoId(input) {
  const text = String(input || "").trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  const match = text.match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/);
  return match ? match[1] : "";
}

async function player(id) {
  const page = await fetch("https://www.youtube.com/watch?v=" + id + "&hl=es-419", {
    headers: { "user-agent": BROWSER, "accept-language": "es-AR,es;q=0.9" }, signal: AbortSignal.timeout(20000)
  });
  const html = await page.text();
  const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
  if (!key) throw new Error("YouTube no devolvió la página del video (" + page.status + ")");
  const response = await fetch("https://www.youtube.com/youtubei/v1/player?key=" + key + "&prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip" },
    body: JSON.stringify({ context: { client: ANDROID }, videoId: id }),
    signal: AbortSignal.timeout(20000)
  });
  return response.json();
}

// Los subtítulos vienen en renglones de pocas palabras: se juntan en frases de hasta 30 segundos para poder citar y enlazar el minuto.
export function segmentsFrom(events) {
  const segments = [];
  let current = null;
  for (const event of events || []) {
    if (!event.segs) continue;
    const text = event.segs.map((seg) => seg.utf8 || "").join("").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const t = Math.floor((event.tStartMs || 0) / 1000);
    if (!current || t - current.t > MAX_SEGMENT_SECONDS || /[.?!…]$/.test(current.text)) {
      current = { t, text };
      segments.push(current);
    } else {
      current.text += " " + text;
    }
  }
  return segments;
}

async function main() {
  const id = videoId(process.argv[2]);
  if (!id) {
    console.error("Uso: node scripts/fetch-transcript.mjs <id o enlace de YouTube>");
    process.exit(1);
  }
  const data = await player(id);
  const status = data.playabilityStatus || {};
  if (status.status !== "OK") throw new Error("YouTube no deja ver el video: " + (status.reason || status.status));
  const tracks = ((data.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
  const spanish = tracks.filter((track) => /^es/.test(track.languageCode));
  // Mejor los subtítulos cargados por el canal; si no hay, los automáticos.
  const track = spanish.find((t) => t.kind !== "asr") || spanish[0];
  if (!track) {
    console.error("Todavía no hay subtítulos en español para este video" + (tracks.length ? " (hay: " + tracks.map((t) => t.languageCode).join(", ") + ")" : "") + ". En los vivos, YouTube los arma unas horas después.");
    process.exit(2);
  }
  const response = await fetch(track.baseUrl.replace(/&fmt=[^&]*/, "") + "&fmt=json3", { headers: { "user-agent": BROWSER }, signal: AbortSignal.timeout(30000) });
  const segments = segmentsFrom((await response.json()).events);
  if (!segments.length) throw new Error("Los subtítulos vinieron vacíos");
  const details = data.videoDetails || {};
  const micro = (data.microformat || {}).playerMicroformatRenderer || {};
  const live = micro.liveBroadcastDetails || {};
  const payload = {
    videoId: id,
    url: "https://www.youtube.com/watch?v=" + id,
    title: details.title || "",
    channel: details.author || "",
    published: live.startTimestamp || micro.publishDate || "",
    duration: Number(details.lengthSeconds) || 0,
    captions: track.kind === "asr" ? "automáticos de YouTube" : "cargados por el canal",
    fetchedAt: new Date().toISOString(),
    segments
  };
  await mkdir(path.join(DATA, "transcripts"), { recursive: true });
  const file = path.join(DATA, "transcripts", id + ".json");
  await writeFile(file, JSON.stringify(payload, null, 1) + "\n");
  const words = segments.reduce((sum, s) => sum + s.text.split(" ").length, 0);
  console.log(`${payload.title} (${payload.channel}): ${segments.length} frases, ${words} palabras, subtítulos ${payload.captions}. Guardado en ${path.relative(ROOT, file)}.`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(String(error)); process.exit(1); });
}
