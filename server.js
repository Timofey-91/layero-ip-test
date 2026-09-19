import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

const CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/config.json";

const LHD_AGENT = JSON.stringify({
  version_name: "1.0.2.203",
  version_code: "203",
  platform: "win",
  device_id: "00000000",
  app: "tv.limehd.win",
  generation: "2",
});

// Кэш в оперативной памяти
let configCache = { data: null, expiresAt: 0 };
const m3u8Cache = new Map(); // path -> { content: string, expiresAt: number }

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

// Загрузка config.json с кэшированием на 60 секунд
async function fetchConfig() {
  const now = Date.now();
  if (configCache.data && now < configCache.expiresAt) {
    return configCache.data;
  }

  const r = await fetch(CONFIG_URL, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      "User-Agent": "Mozilla/5.0",
      "X-LHD-Agent": LHD_AGENT,
    },
  });

  if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
  const data = await r.json();

  configCache = {
    data,
    expiresAt: now + 60 * 1000, // Кэш на 60 сек
  };

  return data;
}

// Преобразование путей внутри M3U8 на прокси-сегменты
function resolveM3u8Urls(m3u8Text, baseUrlStr) {
  const baseUrl = new URL(baseUrlStr);
  const lines = m3u8Text.split("\n");

  const resolvedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      return line.replace(/URI=["']([^"']+)["']/g, (match, relativeUri) => {
        try {
          const absoluteUri = new URL(relativeUri, baseUrl).toString();
          return `URI="/proxy-segment?url=${encodeURIComponent(absoluteUri)}"`;
        } catch {
          return match;
        }
      });
    }

    try {
      const absoluteUri = new URL(trimmed, baseUrl).toString();
      return `/proxy-segment?url=${encodeURIComponent(absoluteUri)}`;
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

    // 1. Проксирование видеосегментов .ts
    if (url.pathname === "/proxy-segment") {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        response.writeHead(400, {
          ...corsHeaders(),
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Missing url parameter");
        return;
      }

      const segmentRes = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "X-LHD-Agent": LHD_AGENT,
          "Referer": "https://limehd.tv/",
          "Origin": "https://limehd.tv",
          "Accept": "*/*",
          "Connection": "keep-alive",
        },
      });

      if (!segmentRes.ok) {
        response.writeHead(segmentRes.status, {
          ...corsHeaders(),
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(`Segment fetch failed: ${segmentRes.status}`);
        return;
      }

      const arrayBuffer = await segmentRes.arrayBuffer();

      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type":
          segmentRes.headers.get("content-type") || "video/mp2t",
        "Content-Length": arrayBuffer.byteLength,
      });

      response.end(Buffer.from(arrayBuffer));
      return;
    }

    // 2. Обработка запросов M3U8 плейлиста
    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");

    if (!path) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Lime TV M3U8 Proxy with Cache is running.");
      return;
    }

    const now = Date.now();

    // Проверка короткого кэша плейлиста (3 секунды)
    if (m3u8Cache.has(path)) {
      const cached = m3u8Cache.get(path);
      if (now < cached.expiresAt) {
        response.writeHead(200, {
          ...corsHeaders(),
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        });
        response.end(cached.content);
        return;
      }
    }

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

    const limeResponse = await fetch(limeStreamUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "X-LHD-Agent": LHD_AGENT,
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
    const processedM3u8 = resolveM3u8Urls(rawM3u8, limeStreamUrl);

    // Сохраняем обработанный M3U8 в кэш на 3 секунды
    m3u8Cache.set(path, {
      content: processedM3u8,
      expiresAt: now + 3000,
    });

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
  console.log(`Lime TV Proxy with caching listening on port ${PORT}`);
});
