import { readFileSync } from "node:fs";
import path from "node:path";
import { CANDIDATES, parseCode, describe } from "./result-shared.mjs";

function photoOf(person) {
  const buf = readFileSync(path.join(process.cwd(), person.photo));
  const type = person.photo.endsWith(".png") ? "png" : "jpeg";
  return "data:image/" + type + ";base64," + buf.toString("base64");
}

export async function GET(request) {
  const rows = parseCode(new URL(request.url).searchParams.get("r") || "");
  if (!rows) return new Response("No encontrado", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  try {
    const { pngFor } = await import("./result-card.mjs");
    const images = Object.fromEntries(CANDIDATES.map((person) => [person.id, photoOf(person)]));
    const png = await pngFor(rows, images, describe(rows));
    return new Response(png, {
      headers: {
        "content-type": "image/png",
        "content-length": String(png.byteLength),
        "cache-control": "public, max-age=31536000, immutable"
      }
    });
  } catch (error) {
    console.error("og", error);
    const message = error instanceof Error ? error.message : "No se pudo armar la imagen";
    return new Response(message, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
}
