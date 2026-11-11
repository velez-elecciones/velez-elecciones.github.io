export const WIDTH = 1200;
export const HEIGHT = 630;
const PANEL_W = 680;
const PANEL_H = 574;
const PHOTO = 104;
const FACE_W = 160;
const FACE_H = 172;

function h(type, style, children, extra) {
  const props = { ...extra };
  if (style) props.style = style;
  if (children != null) props.children = children;
  return { type, props };
}

function radarPoint(index, total, ratio) {
  const angle = -Math.PI / 2 + index * 2 * Math.PI / total;
  return (50 + Math.cos(angle) * 36 * ratio).toFixed(2) + "," + (50 + Math.sin(angle) * 36 * ratio).toFixed(2);
}

function radarSvg(rows) {
  const ring = (ratio) => h("polygon", null, null, {
    points: rows.map((_, index) => radarPoint(index, rows.length, ratio)).join(" "),
    fill: "none",
    stroke: "rgba(0,61,165,0.22)",
    "stroke-width": 0.7
  });
  const axes = rows.map((_, index) => {
    const [x, y] = radarPoint(index, rows.length, 1).split(",");
    return h("line", null, null, { x1: 50, y1: 50, x2: x, y2: y, stroke: "rgba(0,61,165,0.22)", "stroke-width": 0.7 });
  });
  const shape = rows.map((row, index) => row.ranked ? radarPoint(index, rows.length, Math.max(0, Math.min(100, row.pct)) / 100) : null).filter(Boolean);
  const polygon = shape.length >= 3
    ? [h("polygon", null, null, { points: shape.join(" "), fill: "rgba(0,61,165,0.16)", stroke: "#003da5", "stroke-width": 1.6, "stroke-linejoin": "round" })]
    : [];
  return h("svg", { position: "absolute", left: 246, top: 193 }, [...[0.25, 0.5, 0.75, 1].map(ring), ...axes, ...polygon], {
    width: 188,
    height: 188,
    viewBox: "0 0 100 100"
  });
}

function face(row, left, top, src) {
  return h("div", {
    position: "absolute", left, top, width: FACE_W, height: FACE_H,
    display: "flex", flexDirection: "column", alignItems: "center"
  }, [
    h("div", {
      width: PHOTO + 8, height: PHOTO + 8, borderRadius: (PHOTO + 8) / 2, background: row.color,
      display: "flex", alignItems: "center", justifyContent: "center"
    }, [
      h("img", { borderRadius: PHOTO / 2, objectFit: "cover", objectPosition: row.focus }, null, { src, width: PHOTO, height: PHOTO })
    ]),
    h("div", {
      marginTop: 6, fontFamily: "Inter", fontSize: 32, fontWeight: 700, lineHeight: 1,
      color: row.ranked ? row.color : "#8aa0bd"
    }, row.ranked ? row.pct + "%" : "–"),
    h("div", {
      marginTop: 2, fontFamily: "Inter", fontSize: 20, fontWeight: 400, lineHeight: 1.1, color: "#3b4d6b"
    }, row.short)
  ]);
}

function places(rows) {
  const cx = PANEL_W / 2;
  const cy = PANEL_H / 2;
  const orbit = 188;
  return rows.map((row, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 2;
    return {
      left: Math.round(cx + Math.cos(angle) * orbit - FACE_W / 2),
      top: Math.round(cy + Math.sin(angle) * orbit - FACE_H / 2)
    };
  });
}

export function cardElement(rows, images, summary) {
  const spots = places(rows);
  const label = summary.winners.length > 1 ? summary.winners.map((row) => row.short).join(" y ") : summary.winners[0].short;
  const titleSize = label.length > 22 ? 40 : label.length > 14 ? 52 : 68;
  return h("div", {
    width: WIDTH, height: HEIGHT, display: "flex", flexDirection: "row", background: "#003da5"
  }, [
    h("div", {
      width: 460, height: HEIGHT, display: "flex", flexDirection: "column", justifyContent: "center",
      paddingLeft: 48, paddingRight: 28
    }, [
      h("div", { fontFamily: "Inter", fontSize: 18, fontWeight: 700, letterSpacing: 1.6, color: "rgba(255,255,255,0.78)" }, "TEST ELECTORAL"),
      h("div", { marginTop: 22, fontFamily: "Inter", fontSize: 26, fontWeight: 400, color: "rgba(255,255,255,0.92)" }, summary.winners.length > 1 ? "Empate de afinidad" : "Mayor afinidad"),
      h("div", { marginTop: 8, width: 384, fontFamily: "Inter", fontSize: titleSize, fontWeight: 700, lineHeight: 1.05, color: "#fff" }, label),
      h("div", { marginTop: 6, fontFamily: "Inter", fontSize: 92, fontWeight: 700, lineHeight: 1, color: "#fff" }, summary.best + "%"),
      h("div", { marginTop: 28, fontFamily: "Inter", fontSize: 20, fontWeight: 400, color: "rgba(255,255,255,0.8)" }, "Elecciones Vélez 2026")
    ]),
    h("div", { width: PANEL_W, height: PANEL_H, marginTop: 28, marginLeft: 12, display: "flex", position: "relative", background: "#fff", borderRadius: 28 }, [
      radarSvg(rows),
      ...rows.map((row, index) => face(row, spots[index].left, spots[index].top, images[row.id]))
    ])
  ]);
}
