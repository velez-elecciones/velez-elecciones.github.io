import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { cardElement, WIDTH, HEIGHT } from "./result-layout.mjs";

function readFirst(paths) {
  const misses = [];
  for (const file of paths) {
    try { return readFileSync(file); } catch (error) { misses.push(file + " (" + error.code + ")"); }
  }
  throw new Error(misses.join(" | "));
}

function loadFonts() {
  const regular = readFirst([
    path.join(process.cwd(), "fonts", "Inter-Regular.ttf"),
    fileURLToPath(new URL("../fonts/Inter-Regular.ttf", import.meta.url))
  ]);
  const bold = readFirst([
    path.join(process.cwd(), "fonts", "Inter-Bold.ttf"),
    fileURLToPath(new URL("../fonts/Inter-Bold.ttf", import.meta.url))
  ]);
  return [
    { name: "Inter", data: regular, weight: 400, style: "normal" },
    { name: "Inter", data: bold, weight: 700, style: "normal" }
  ];
}

let wasmReady;
function ready() {
  if (!wasmReady) {
    const wasm = readFirst([
      path.join(process.cwd(), "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm"),
      fileURLToPath(new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url))
    ]);
    wasmReady = initWasm(wasm);
  }
  return wasmReady;
}

export async function pngFor(rows, images, summary) {
  await ready();
  const svg = await satori(cardElement(rows, images, summary), { width: WIDTH, height: HEIGHT, fonts: loadFonts() });
  return new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng();
}
