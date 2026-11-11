import { ImageResponse } from "@vercel/og";
import { CANDIDATES, parseCode, describe } from "./result-shared.mjs";
import { cardElement, WIDTH, HEIGHT } from "./result-layout.mjs";

export const config = { runtime: "edge" };

export default async function handler(request) {
  const rows = parseCode(new URL(request.url).searchParams.get("r") || "");
  if (!rows) return new Response("No encontrado", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    const origin = new URL(request.url).origin;
    const [regular, bold] = await Promise.all([
      fetch(origin + "/fonts/Inter-Regular.ttf").then((res) => { if (!res.ok) throw new Error("fuente"); return res.arrayBuffer(); }),
      fetch(origin + "/fonts/Inter-Bold.ttf").then((res) => { if (!res.ok) throw new Error("fuente"); return res.arrayBuffer(); })
    ]);
    const images = Object.fromEntries(CANDIDATES.map((person) => [person.id, origin + "/" + person.photo]));
    return new ImageResponse(cardElement(rows, images, describe(rows)), {
      width: WIDTH,
      height: HEIGHT,
      fonts: [
        { name: "Inter", data: regular, weight: 400, style: "normal" },
        { name: "Inter", data: bold, weight: 700, style: "normal" }
      ],
      headers: { "cache-control": "public, max-age=31536000, immutable" }
    });
  } catch (error) {
    console.error("og", error);
    return new Response(error instanceof Error ? error.message : "No se pudo armar la imagen", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
}
