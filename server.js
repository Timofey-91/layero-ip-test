import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

// Точный URL к конфигу на GitVerse
const CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/config.json";

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
  const r = await fetch(CONFIG_URL, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });

  if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
  return await r.json();
}

// Преобразуем относительные ссылки и URI внутри .m3u8 в абсолютные
function resolveM3u8Urls(m3u8Text, baseUrlStr) {
  const baseUrl = new URL(baseUrlStr);
  const lines = m3u8Text.split("\n");

  const resolvedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Переписываем URI="..." внутри тегов (#EXT-X-KEY, #EXT-X-MEDIA и т.д.)
    if (trimmed.startsWith("#")) {
      return line.replace(/URI=["']([^"']+)["']/g, (match, relativeUri) => {
        try {
          const absoluteUri = new URL(relativeUri, baseUrl).toString();
          return `URI="${absoluteUri}"`;
        } catch {
          return match;
        }
      });
    }

    // Переписываем обычные строки со ссылками на сегменты (.ts) или суб-плейлисты
    try {
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

    // 1. Получаем конфиг ссылок с GitVerse
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

    // 2. Запрашиваем .m3u8 с Lime TV с полной эмуляцией браузера (защита от 423)
    const limeResponse = await fetch(limeStreamUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://limehd.tv/",
        "Origin": "https://limehd.tv",
        "Accept": "*/*",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "Connection": "keep-alive",
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

    // 3. Превращаем относительные ссылки внутри M3U8 в абсолютные
    const processedM3u8 = resolveM3u8Urls(rawM3u8, limeStreamUrl);

    // 4. Отдаем готовый плейлист плееру
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
