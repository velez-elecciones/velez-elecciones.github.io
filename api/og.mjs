import { readFileSync } from "node:fs";
import path from "node:path";
import { CANDIDATES, parseCode, describe } from "./result-shared.mjs";
import { pngFor } from "./result-card.mjs";

const photos = new Map();

function photoOf(person) {
  if (!photos.has(person.id)) {
    const buf = readFileSync(path.join(process.cwd(), person.photo));
    const type = person.photo.endsWith(".png") ? "png" : "jpeg";
    photos.set(person.id, "data:image/" + type + ";base64," + buf.toString("base64"));
  }
  return photos.get(person.id);
}

export async function GET(request) {
  const rows = parseCode(new URL(request.url).searchParams.get("r") || "");
  if (!rows) return new Response("No encontrado", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    const images = Object.fromEntries(CANDIDATES.map((person) => [person.id, photoOf(person)]));
    const png = await pngFor(rows, images, describe(rows));
    return new Response(png, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable"
      }
    });
  } catch (error) {
    console.error("og", error);
    return new Response("No se pudo armar la imagen", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
