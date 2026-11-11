import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CANDIDATES, parseCode, describe } from "./result-shared.mjs";

function readAsset(name, fileUrl) {
  const paths = [path.join(process.cwd(), "share", name), fileURLToPath(fileUrl)];
  for (const file of paths) {
    try { return readFileSync(file); } catch { /* el siguiente */ }
  }
  throw new Error("No está " + name);
}

function photoOf(person) {
  const file = person.id === "balestrini"
    ? readAsset("balestrini-face.jpg", new URL("../share/balestrini-face.jpg", import.meta.url))
    : person.id === "montero"
      ? readAsset("montero-face.jpg", new URL("../share/montero-face.jpg", import.meta.url))
      : person.id === "mazzitelli"
        ? readAsset("mazzitelli.png", new URL("../share/mazzitelli.png", import.meta.url))
        : readAsset("pugliese.jpg", new URL("../share/pugliese.jpg", import.meta.url));
  const type = person.id === "mazzitelli" ? "image/png" : "image/jpeg";
  return "data:" + type + ";base64," + file.toString("base64");
}

function codeOf(request) {
  return (new URL(request.url).searchParams.get("r") || "").replace(/\.png$/i, "");
}

export async function GET(request) {
  const rows = parseCode(codeOf(request));
  if (!rows) return new Response("No encontrado", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  try {
    const { pngFor } = await import("./result-card.mjs");
    const images = Object.fromEntries(CANDIDATES.map((person) => [person.id, photoOf(person)]));
    const png = await pngFor(rows, images, describe(rows));
    return new Response(png, {
      headers: {
        "content-type": "image/png",
        "content-length": String(png.byteLength),
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=31536000, immutable"
      }
    });
  } catch (error) {
    console.error("og", error);
    return new Response("No se pudo armar la imagen", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
}

export async function HEAD(request) {
  const res = await GET(request);
  if (res.body) await res.body.cancel();
  return new Response(null, { status: res.status, headers: res.headers });
}
