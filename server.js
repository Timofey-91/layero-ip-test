import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

// Источники конфигураций
const LIME_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/config.json";
const WINK_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/mediavitrina-proxy/raw/branch/master/wink.json";

// Специальный заголовок для авторизации в CDN Lime HD
const LHD_AGENT = JSON.stringify({
  version_name: "1.0.2.203",
  version_code: "203",
  platform: "win",
  device_id: "00000000",
  app: "tv.limehd.win",
  generation: "2",
});

// Кэш конфигураций и плейлистов
let configCache = { lime: {}, wink: {}, expiresAt: 0 };
const m3u8Cache = new Map();

// CORS заголовки для работы любых плееров
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

/**
 * ЧЁТКОЕ РАЗДЕЛЕНИЕ ЛАЙМ И ВИНК ПО ДОМЕНАМ И ЗАГОЛОВКАМ
 */
function getHeadersForUrl(targetUrl) {
  const lowerUrl = targetUrl.toLowerCase();

  // Домены, принадлежащие инфраструктуре Lime HD / Telecloud
  const isLime =
    lowerUrl.includes("lime") ||
    lowerUrl.includes("telecloud") ||
    lowerUrl.includes("vse-tv") ||
    lowerUrl.includes("lhd");

  // Домены, принадлежащие инфраструктуре Wink / Ростелеком / Ngenix / Mediavitrina
  const isWink =
    lowerUrl.includes("wink") ||
    lowerUrl.includes("rt.ru") ||
    lowerUrl.includes("mediavitrina") ||
    lowerUrl.includes("ngenix") ||
    lowerUrl.includes("cdntv") ||
    lowerUrl.includes("zabava");

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
  };

  if (isLime) {
    // Заголовки строго для Лайма
    headers["X-LHD-Agent"] = LHD_AGENT;
    headers["Referer"] = "https://limehd.tv/";
    headers["Origin"] = "https://limehd.tv";
  } else if (isWink) {
    // Заголовки строго для Винка
    headers["Referer"] = "https://wink.ru/";
    headers["Origin"] = "https://wink.ru";
  }

  return headers;
}

/**
 * Загрузка конфигураций с разделением на Lime и Wink
 */
async function fetchConfigs(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && configCache.expiresAt > now) {
    return configCache;
  }

  const [limeRes, winkRes] = await Promise.allSettled([
    fetch(LIME_CONFIG_URL, {
      headers: {
        "Cache-Control": "no-cache, no-store",
        "User-Agent": "Mozilla/5.0",
        "X-LHD-Agent": LHD_AGENT,
      },
    }),
    fetch(WINK_CONFIG_URL, {
      headers: {
        "Cache-Control": "no-cache, no-store",
        "User-Agent": "Mozilla/5.0",
      },
    }),
  ]);

  let limeData = {};
  let winkData = {};

  if (limeRes.status === "fulfilled" && limeRes.value.ok) {
    try {
      limeData = await limeRes.value.json();
    } catch (e) {
      console.error("Ошибка парсинга конфига Lime:", e);
    }
  }

  if (winkRes.status === "fulfilled" && winkRes.value.ok) {
    try {
      winkData = await winkRes.value.json();
    } catch (e) {
      console.error("Ошибка парсинга конфига Wink:", e);
    }
  }

  configCache = {
    lime: limeData,
    wink: winkData,
    expiresAt: now + 30 * 1000, // Кэш конфигов на 30 секунд
  };

  return configCache;
}

/**
 * Проверка, является ли URL ссылкой на M3U8 плейлист
 */
function isM3u8Url(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return (
      parsed.pathname.endsWith(".m3u8") ||
      parsed.pathname.includes(".m3u8") ||
      parsed.search.includes(".m3u8")
    );
  } catch {
    return urlStr.includes(".m3u8");
  }
}

/**
 * Преобразование ссылок внутри M3U8 плейлистов
 */
function resolveM3u8Urls(m3u8Text, baseUrlStr) {
  const baseUrl = new URL(baseUrlStr);
  const lines = m3u8Text.split("\n");

  const resolvedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Замена URI="..." в тегах #EXT-X-MEDIA, #EXT-X-I-FRAME, #EXT-X-KEY и т.д.
    if (trimmed.startsWith("#")) {
      return line.replace(/URI=["']([^"']+)["']/g, (match, relativeUri) => {
        try {
          const absoluteUri = new URL(relativeUri, baseUrl).toString();
          const endpoint = isM3u8Url(absoluteUri)
            ? "/proxy-m3u8"
            : "/proxy-segment";
          return `URI="${endpoint}?url=${encodeURIComponent(absoluteUri)}"`;
        } catch {
          return match;
        }
      });
    }

    // Замена прямых ссылок на потоки или сегменты
    try {
      const absoluteUri = new URL(trimmed, baseUrl).toString();
      const endpoint = isM3u8Url(absoluteUri)
        ? "/proxy-m3u8"
        : "/proxy-segment";
      return `${endpoint}?url=${encodeURIComponent(absoluteUri)}`;
    } catch {
      return line;
    }
  });

  return resolvedLines.join("\n");
}

async function handleM3u8Fetch(targetUrl) {
  const headers = getHeadersForUrl(targetUrl);
  const res = await fetch(targetUrl, { headers });

  if (!res.ok) {
    throw new Error(`Ошибка загрузки M3U8: status ${res.status}`);
  }

  const rawM3u8 = await res.text();
  return resolveM3u8Urls(rawM3u8, targetUrl);
}

// Сервер HTTP
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

    // 1. Маршрут для проксирования вложенных M3U8 плейлистов (Master / Variant Playlists)
    if (url.pathname === "/proxy-m3u8") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        response.writeHead(400, corsHeaders());
        response.end("Missing url parameter");
        return;
      }

      try {
        const processedM3u8 = await handleM3u8Fetch(targetUrl);
        response.writeHead(200, {
          ...corsHeaders(),
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        });
        response.end(processedM3u8);
      } catch (e) {
        m3u8Cache.clear();
        configCache.expiresAt = 0;
        response.writeHead(503, corsHeaders());
        response.end("M3U8 fetch failed");
      }
      return;
    }

    // 2. Маршрут для проксирования видеосегментов (.ts, .m4s, ключей и т.д.)
    if (url.pathname === "/proxy-segment") {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        response.writeHead(400, corsHeaders());
        response.end("Missing url parameter");
        return;
      }

      const segmentHeaders = getHeadersForUrl(targetUrl);

      // Пробрасываем Range заголовок плеера для поддержки 206 Partial Content
      if (request.headers["range"]) {
        segmentHeaders["Range"] = request.headers["range"];
      }

      try {
        const segmentRes = await fetch(targetUrl, { headers: segmentHeaders });

        if (!segmentRes.ok && segmentRes.status !== 206) {
          response.writeHead(503, corsHeaders());
          response.end("Segment request failed");
          return;
        }

        const arrayBuffer = await segmentRes.arrayBuffer();
        const responseHeaders = {
          ...corsHeaders(),
          "Content-Type":
            segmentRes.headers.get("content-type") || "video/mp2t",
          "Content-Length": arrayBuffer.byteLength,
        };

        if (segmentRes.headers.get("content-range")) {
          responseHeaders["Content-Range"] =
            segmentRes.headers.get("content-range");
        }

        if (segmentRes.headers.get("accept-ranges")) {
          responseHeaders["Accept-Ranges"] =
            segmentRes.headers.get("accept-ranges");
        }

        response.writeHead(segmentRes.status, responseHeaders);
        response.end(Buffer.from(arrayBuffer));
      } catch (e) {
        response.writeHead(502, corsHeaders());
        response.end("Gateway Error");
      }
      return;
    }

    // 3. Запрос M3U8 плейлиста по названию канала
    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");

    if (!path) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("IPTV Multi-Proxy (Lime + Wink) is active.");
      return;
    }

    const now = Date.now();

    // Проверка кэша готового плейлиста
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

    const configs = await fetchConfigs();

    // Раздельный поиск ссылки на канал:
    // Поддерживаются префиксы "lime_ch" или "wink_ch", а также обычный запрос "ch"
    let streamUrl = null;

    if (path.startsWith("lime_")) {
      const realPath = path.replace(/^lime_/, "");
      streamUrl = configs.lime[realPath];
    } else if (path.startsWith("wink_")) {
      const realPath = path.replace(/^wink_/, "");
      streamUrl = configs.wink[realPath];
    } else {
      // При обычном запросе проверяем сначала Lime, затем Wink
      streamUrl = configs.lime[path] || configs.wink[path];
    }

    if (!streamUrl) {
      response.writeHead(404, corsHeaders());
      response.end("Channel not found in Lime or Wink configs");
      return;
    }

    try {
      const processedM3u8 = await handleM3u8Fetch(streamUrl);

      // Кэшируем результат на 2 секунды для снижения нагрузки
      m3u8Cache.set(path, {
        content: processedM3u8,
        expiresAt: now + 2000,
      });

      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      });
      response.end(processedM3u8);
    } catch (e) {
      m3u8Cache.clear();
      configCache.expiresAt = 0;
      response.writeHead(503, corsHeaders());
      response.end("Stream fetch failed");
    }
  } catch (error) {
    response.writeHead(500, corsHeaders());
    response.end("Internal Server Error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`IPTV Multi-Proxy (Lime & Wink) running on port ${PORT}`);
});
