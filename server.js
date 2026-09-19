import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

const CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey-91/peer_test/raw/branch/master/config.json";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
  };
}

// Загружаем конфиг с GitVerse
async function fetchConfig() {
  const cacheBusterUrl = `${CONFIG_URL}?t=${Date.now()}`;
  const r = await fetch(cacheBusterUrl, {
    headers: { "Cache-Control": "no-cache, no-store" },
  });

  if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
  return await r.json();
}

// Преобразуем относительные ссылки внутри .m3u8 в абсолютные
function resolveM3u8Urls(m3u8Text, baseUrlStr) {
  const baseUrl = new URL(baseUrlStr);
  const lines = m3u8Text.split("\n");

  const resolvedLines = lines.map((line) => {
    const trimmed = line.trim();
    // Пропускаем теги #EXT... и пустые строки
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }
    try {
      // Превращаем "segment1.ts" в "https://cdn.limehd.tv/.../segment1.ts"
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return line;
    }
  });

  return resolvedLines.join("\n");
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");

    if (!path) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Lime TV M3U8 Proxy is running.");
      return;
    }

    // 1. Получаем конфиг ссылок
    const config = await fetchConfig();
    const limeStreamUrl = config[path];

    if (!limeStreamUrl) {
      response.writeHead(404, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Channel not found in Lime config");
      return;
    }

    // 2. Скачиваем .m3u8 с Lime TV, используя российский IP сервера Layero
    const limeResponse = await fetch(limeStreamUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!limeResponse.ok) {
      response.writeHead(limeResponse.status, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(`Lime TV upstream error: ${limeResponse.status}`);
      return;
    }

    const rawM3u8 = await limeResponse.text();

    // 3. Переписываем ссылки внутри M3U8 на прямые URL CDN
    const processedM3u8 = resolveM3u8Urls(rawM3u8, limeStreamUrl);

    // 4. Отдаем готовый M3U8 плееру
    response.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
    });
    response.end(processedM3u8);

  } catch (error) {
    response.writeHead(500, {
      ...corsHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Proxy error: " + error.message);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Lime TV Proxy listening on port ${PORT}`);
});
