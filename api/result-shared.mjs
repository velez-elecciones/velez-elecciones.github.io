// El código de un resultado son cuatro valores en este orden, el mismo del radar:
// Pugliese, Balestrini, Montero, Mazzitelli. "082" es 82%. "---" es sin datos.
export const CANDIDATES = [
  { id: "pugliese", name: "Nelson Pugliese", short: "Pugliese", color: "#003da5", photo: "img/pugliese.jpg", focus: "center 18%" },
  { id: "balestrini", name: "Federico Balestrini", short: "Balestrini", color: "#c49212", photo: "img/balestrini-face.jpg", focus: "center 18%" },
  { id: "montero", name: "Juan Cruz Montero", short: "Montero", color: "#1a8fe8", photo: "img/montero-face.jpg", focus: "center 18%" },
  { id: "mazzitelli", name: "Ignacio Mazzitelli", short: "Mazzitelli", color: "#0e7490", photo: "img/mazzitelli.png", focus: "center 22%" }
];

export function parseCode(code) {
  if (!/^(?:\d{3}|---){4}$/.test(code || "")) return null;
  const rows = CANDIDATES.map((person, index) => {
    const part = code.slice(index * 3, index * 3 + 3);
    if (part === "---") return { ...person, ranked: false, pct: null };
    const pct = Number(part);
    if (!Number.isInteger(pct) || pct > 100) return null;
    return { ...person, ranked: true, pct };
  });
  if (rows.some((row) => !row) || !rows.some((row) => row.ranked)) return null;
  return rows;
}

export function describe(rows) {
  const ranked = rows.filter((row) => row.ranked);
  const best = Math.max(...ranked.map((row) => row.pct));
  const winners = ranked.filter((row) => row.pct === best);
  const title = winners.length > 1
    ? "Empate: " + winners.map((row) => row.short).join(" y ") + " (" + best + "%)"
    : winners[0].name + " (" + best + "%)";
  const scores = rows.map((row) => row.short + " " + (row.ranked ? row.pct + "%" : "—")).join(" · ");
  return { title, scores, best, winners };
}
