// Busca los partidos de Vélez (último resultado y próximos) y escribe data/matches.json.
// Fuente: la API pública de ESPN. El marcador en vivo lo consulta el navegador de quien mira la página (ver velez.html);
// este archivo es el punto de partida y el respaldo si esa consulta falla.
// Uso: node scripts/update-matches.mjs     (Node 18 o más nuevo, sin dependencias)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const TEAM_ID = String(process.env.VELEZ_TEAM_ID || "21");
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const BA = "America/Argentina/Buenos_Aires";
const MAX_UPCOMING = 3;

// >>> interpretación de eventos de ESPN: copia exacta en velez.html
const COMPETITIONS = {
  "arg.1": "Liga Profesional",
  "arg.copa": "Copa Argentina",
  "arg.supercopa": "Supercopa Argentina",
  "conmebol.libertadores": "Copa Libertadores",
  "conmebol.sudamericana": "Copa Sudamericana",
  "conmebol.recopa": "Recopa Sudamericana"
};

// Fases que ESPN escribe en inglés.
const ROUNDS = {
  "round of 64": "32avos de final", "round of 32": "16avos de final", "round of 16": "Octavos de final",
  "quarterfinals": "Cuartos de final", "quarterfinal": "Cuartos de final", "semifinals": "Semifinal", "semifinal": "Semifinal",
  "final": "Final", "group stage": "Fase de grupos", "playoffs": "Playoffs"
};

// Esta función se repite igual en velez.html (el navegador interpreta los eventos del scoreboard con la misma lógica).
export function normalizeEvent(e, fallbackLeague = "") {
  const comp = e && Array.isArray(e.competitions) ? e.competitions[0] : null;
  if (!comp || !Array.isArray(comp.competitors) || comp.competitors.length !== 2) return null;
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away || !home.team || !away.team) return null;
  const status = comp.status || e.status || {};
  const type = status.type || {};
  const league = (e.league && e.league.slug) || fallbackLeague || "";
  const numberOf = (value) => {
    const raw = value && typeof value === "object" ? (value.value ?? value.displayValue) : value;
    const n = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const side = (c) => ({
    id: String(c.team.id),
    name: String(c.team.displayName || c.team.name || "").trim(),
    short: String(c.team.shortDisplayName || c.team.displayName || "").trim(),
    logo: c.team.logo || (Array.isArray(c.team.logos) && c.team.logos[0] ? c.team.logos[0].href : "") || "",
    score: numberOf(c.score),
    shootout: numberOf(c.shootoutScore),
    winner: c.winner === true
  });
  const sides = { home: side(home), away: side(away) };
  const shootout = sides.home.shootout !== null || sides.away.shootout !== null;

  // Goles (solo el scoreboard los trae). Si hubo definición por penales, sus remates vienen mezclados con los goles: no se listan.
  const goals = shootout ? [] : (Array.isArray(comp.details) ? comp.details : [])
    .filter((d) => d && d.scoringPlay === true && d.team)
    .map((d) => ({
      team: String(d.team.id),
      player: String((d.athletesInvolved && d.athletesInvolved[0] && (d.athletesInvolved[0].displayName || d.athletesInvolved[0].shortName)) || "").trim(),
      clock: String((d.clock && d.clock.displayValue) || "").trim(),
      penalty: d.penaltyKick === true,
      ownGoal: d.ownGoal === true
    }));

  const roundText = String((e.seasonType && e.seasonType.name) || "").replace(/^torneo\s+/i, "").trim();
  const note = String(comp.altGameNote || (comp.notes && comp.notes[0] && comp.notes[0].headline) || "");
  const roundKey = (note.split(",").pop() || roundText).trim().toLowerCase();
  const stage = ROUNDS[roundKey] || (league === "arg.1" ? roundText : (ROUNDS[roundText.toLowerCase()] || ""));
  const link = (Array.isArray(e.links) ? e.links : []).find((l) => l && /espn\.com\/soccer\/match/i.test(l.href || ""));
  const date = new Date(e.date || comp.date);

  return {
    id: String(e.id),
    league,
    competition: COMPETITIONS[league] || String((e.league && (e.league.shortName || e.league.name)) || "").replace(/^argentine\s+/i, "") || "",
    stage,
    date: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
    state: type.state || "pre",
    status: type.name || "",
    completed: type.completed === true,
    clock: String(status.displayClock || "").trim(),
    venue: String((comp.venue && comp.venue.fullName) || "").trim(),
    url: link ? link.href : "",
    home: sides.home,
    away: sides.away,
    goals
  };
}

// <<< fin de la interpretación de eventos de ESPN

function involvesVelez(match) {
  return match.home.id === TEAM_ID || match.away.id === TEAM_ID;
}

// Último partido terminado y próximos (los que todavía no terminaron). Un partido "no terminado" cuya hora quedó muy atrás
// (suspendido o postergado sin nueva fecha) no cuenta como próximo.
export function pickMatches(pastEvents, fixtureEvents, now = new Date()) {
  const byId = new Map();
  for (const e of [...(fixtureEvents || []), ...(pastEvents || [])]) { // los resultados pisan a la versión "programado"
    const match = normalizeEvent(e);
    if (match && match.date && involvesVelez(match)) byId.set(match.id, match);
  }
  const list = [...byId.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const last = [...list].reverse().find((m) => m.completed && m.state === "post") || null;
  const staleBefore = now.getTime() - 4 * 3600000;
  const upcoming = list.filter((m) => !m.completed && Date.parse(m.date) >= staleBefore).slice(0, MAX_UPCOMING);
  return { last, upcoming };
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; VelezElecciones/1.0)" }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(response.status + " " + url);
  return response.json();
}

function dayIn(zone, iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(iso)).replace(/-/g, "");
}

// El calendario no trae los goles ni el marcador de los penales: se completan con el scoreboard de ese día.
async function withGoals(match) {
  for (const day of [...new Set([dayIn(BA, match.date), dayIn("UTC", match.date)])]) {
    try {
      const board = await getJson(`${ESPN}/${match.league}/scoreboard?dates=${day}`);
      const found = (board.events || []).find((e) => String(e.id) === match.id);
      const full = found && normalizeEvent(found, match.league);
      if (full) {
        const shoot = (mine, other) => (other.shootout !== null ? other.shootout : mine.shootout);
        return { ...match, home: { ...match.home, shootout: shoot(match.home, full.home) }, away: { ...match.away, shootout: shoot(match.away, full.away) }, goals: full.goals };
      }
    } catch (error) {
      console.warn("No se pudieron leer los goles:", String(error).slice(0, 120));
    }
  }
  return match;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA, file), "utf8")); } catch { return fallback; }
}

async function main() {
  await mkdir(DATA, { recursive: true });
  const previous = await readJson("matches.json", null);
  let past;
  let fixture;
  try {
    [past, fixture] = await Promise.all([
      getJson(`${ESPN}/all/teams/${TEAM_ID}/schedule`),
      getJson(`${ESPN}/all/teams/${TEAM_ID}/schedule?fixture=true`)
    ]);
  } catch (error) {
    console.warn("No se pudo leer el calendario de Vélez; se conserva lo anterior:", String(error).slice(0, 160));
    return;
  }
  const picked = pickMatches(past.events, fixture.events);
  if (!picked.last && !picked.upcoming.length) {
    console.warn("ESPN no devolvió partidos de Vélez; se conserva lo anterior.");
    return;
  }
  const last = picked.last ? await withGoals(picked.last) : null;
  const team = (past.team && { id: String(past.team.id), name: past.team.displayName }) || (previous && previous.team) || { id: TEAM_ID };
  const now = new Date().toISOString();
  const body = { source: "ESPN", team, last, upcoming: picked.upcoming };
  const changed = !previous || JSON.stringify({ source: previous.source, team: previous.team, last: previous.last, upcoming: previous.upcoming }) !== JSON.stringify(body);
  const payload = { updated: changed ? now : previous.updated || now, checkedAt: now, ...body };
  await writeFile(path.join(DATA, "matches.json"), JSON.stringify(payload, null, 2) + "\n");
  const brief = (m) => m ? `${m.home.short} ${m.home.score === null ? "vs" : m.home.score + "-" + m.away.score} ${m.away.short} (${m.date.slice(0, 10)})` : "ninguno";
  console.log(`Partidos de Vélez. Último: ${brief(last)}. Próximo: ${brief(picked.upcoming[0])}. ${changed ? "Hay novedades." : "Sin cambios."}`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
