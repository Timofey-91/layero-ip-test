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

let configCache = { data: null, expiresAt: 0 };
const m3u8Cache = new Map();

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

async function fetchConfig(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && configCache.data && now < configCache.expiresAt) {
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
    expiresAt: now + 30 * 1000, // Кэш конфига 30 секунд
  };

  return data;
}

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

    // 1. Проксирование сегментов
    if (url.pathname === "/proxy-segment") {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        response.writeHead(400, corsHeaders());
        response.end();
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
        // При ошибке сегмента сбрасываем кэш плейлистов, чтобы плеер перезапросил свежий M3U8
        m3u8Cache.clear();
        configCache.data = null;

        // Отдаем чистый код 503 без текста, чтобы плеер не путал его с видеофайлом
        response.writeHead(503, corsHeaders());
        response.end();
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

    // 2. Запрос M3U8 плейлиста
    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");

    if (!path) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Lime TV Proxy is running.");
      return;
    }

    const now = Date.now();

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
      response.writeHead(404, corsHeaders());
      response.end("Channel not found");
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
      response.writeHead(limeResponse.status, corsHeaders());
      response.end();
      return;
    }

    const rawM3u8 = await limeResponse.text();
    const processedM3u8 = resolveM3u8Urls(rawM3u8, limeStreamUrl);

    m3u8Cache.set(path, {
      content: processedM3u8,
      expiresAt: now + 2000, // Кэш плейлиста всего 2 секунды
    });

    response.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
    });
    response.end(processedM3u8);
  } catch (error) {
    response.writeHead(500, corsHeaders());
    response.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Lime TV Proxy listening on port ${PORT}`);
});
