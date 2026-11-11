import { parseCode, describe } from "./result-shared.mjs";

function originOf(request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "velezelecciones.com";
  return "https://" + host.split(",")[0].trim();
}

export function pageFor(code, origin) {
  const rows = parseCode(code);
  if (!rows) return null;
  const { title, scores } = describe(rows);
  const url = origin + "/r/" + code;
  const image = origin + "/api/og?r=" + code + "&v=4";
  const dest = JSON.stringify("/test.html#r=" + code);
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${title} · Test Vélez</title>
<link rel="canonical" href="${url}">
<meta name="robots" content="noindex">
<meta name="description" content="${scores}">
<meta property="og:type" content="website">
<meta property="og:locale" content="es_AR">
<meta property="og:site_name" content="Elecciones Vélez 2026">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${scores}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${scores}">
<meta name="twitter:image" content="${image}">
<meta name="theme-color" content="#003da5">
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#003da5;color:#fff;font-family:system-ui,sans-serif">
<p><a href="/test.html#r=${code}" style="color:#fff">Ver el resultado</a></p>
<script>location.replace(${dest})</script>
</body>
</html>`;
}

export function GET(request) {
  const code = new URL(request.url).searchParams.get("code") || "";
  const html = pageFor(code, originOf(request));
  if (!html) return new Response("No encontrado", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=86400"
    }
  });
}
