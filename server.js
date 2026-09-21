import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

// Рабочий конфиг
const LIME_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/config.json";

// Конфиг Винка
const WINK_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/mediavitrina-proxy/raw/branch/master/wink.json";

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

/**
 * Проверка, принадлежит ли URL к CDN Wink/Ростелеком
 */
function isWinkUrl(targetUrl) {
  const u = targetUrl.toLowerCase();
  return (
    u.includes("wink") ||
    u.includes("rt.ru") ||
    u.includes("mediavitrina") ||
    u.includes("ngenix") ||
    u.includes("cdntv") ||
    u.includes("zabava")
  );
}

/**
 * Подстановка заголовков:
 * - Если Wink -> заголовки Wink.
 * - В остальных случаях -> 100% ТОЧНЫЕ заголовки из вашего рабочего скрипта Лама.
 */
function getHeaders(targetUrl) {
  if (isWinkUrl(targetUrl)) {
    return {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://wink.ru/",
      "Origin": "https://wink.ru",
      "Accept": "*/*",
      "Connection": "keep-alive",
    };
  }

  // Заголовки строго из моего рабочего кода
  return {
    "User-Agent": "Mozilla/5.0",
    "X-LHD-Agent": LHD_AGENT,
    "Referer": "https://limehd.tv/",
    "Origin": "https://limehd.tv",
    "Accept": "*/*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
  };
}

/**
 * Загрузка и объединение конфигов Лама и Винка
 */
async function fetchConfig(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && configCache.data && now < configCache.expiresAt) {
    return configCache.data;
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
      console.error("Lime config parse error:", e);
    }
  }

  if (winkRes.status === "fulfilled" && winkRes.value.ok) {
    try {
      winkData = await winkRes.value.json();
    } catch (e) {
      console.error("Wink config parse error:", e);
    }
  }

  // Лайм в приоритете
  const combinedData = { ...winkData, ...limeData };

  configCache = {
    data: combinedData,
    expiresAt: now + 30 * 1000,
  };

  return combinedData;
}

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
 * Парсинг M3U8 (точно по вашей рабочей логике с добавлением /proxy-m3u8 для Wink-плейлистов)
 */
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
          const endpoint = isM3u8Url(absoluteUri)
            ? "/proxy-m3u8"
            : "/proxy-segment";
          return `URI="${endpoint}?url=${encodeURIComponent(absoluteUri)}"`;
        } catch {
          return match;
        }
      });
    }

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

    // 1. Проксирование вложенных M3U8 плейлистов (Master-плейлисты для Wink)
    if (url.pathname === "/proxy-m3u8") {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        response.writeHead(400, corsHeaders());
        response.end();
        return;
      }

      try {
        const subRes = await fetch(targetUrl, {
          headers: getHeaders(targetUrl),
        });

        if (!subRes.ok) {
          response.writeHead(subRes.status, corsHeaders());
          response.end();
          return;
        }

        const rawM3u8 = await subRes.text();
        const processedM3u8 = resolveM3u8Urls(rawM3u8, targetUrl);

        response.writeHead(200, {
          ...corsHeaders(),
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        });
        response.end(processedM3u8);
      } catch (e) {
        response.writeHead(503, corsHeaders());
        response.end();
      }
      return;
    }

    // 2. Проксирование сегментов
    if (url.pathname === "/proxy-segment") {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        response.writeHead(400, corsHeaders());
        response.end();
        return;
      }

      const isWink = isWinkUrl(targetUrl);
      const reqHeaders = getHeaders(targetUrl);

      // Передаем Range только если это Wink (нужно для плееров на Wink CDN)
      if (isWink && request.headers["range"]) {
        reqHeaders["Range"] = request.headers["range"];
      }

      const segmentRes = await fetch(targetUrl, { headers: reqHeaders });

      const isOk = segmentRes.ok || (isWink && segmentRes.status === 206);

      if (!isOk) {
        m3u8Cache.clear();
        configCache.data = null;

        response.writeHead(503, corsHeaders());
        response.end();
        return;
      }

      const arrayBuffer = await segmentRes.arrayBuffer();

      const resHeaders = {
        ...corsHeaders(),
        "Content-Type":
          segmentRes.headers.get("content-type") || "video/mp2t",
        "Content-Length": arrayBuffer.byteLength,
      };

      if (isWink && segmentRes.headers.get("content-range")) {
        resHeaders["Content-Range"] = segmentRes.headers.get("content-range");
      }

      response.writeHead(segmentRes.status, resHeaders);
      response.end(Buffer.from(arrayBuffer));
      return;
    }

    // 3. Запрос M3U8 плейлиста
    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");

    if (!path) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Lime & Wink TV Proxy is running.");
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
    const streamUrl = config[path];

    if (!streamUrl) {
      response.writeHead(404, corsHeaders());
      response.end("Channel not found");
      return;
    }

    const streamResponse = await fetch(streamUrl, {
      headers: getHeaders(streamUrl),
    });

    if (!streamResponse.ok) {
      response.writeHead(streamResponse.status, corsHeaders());
      response.end();
      return;
    }

    const rawM3u8 = await streamResponse.text();
    const processedM3u8 = resolveM3u8Urls(rawM3u8, streamUrl);

    m3u8Cache.set(path, {
      content: processedM3u8,
      expiresAt: now + 2000,
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
  console.log(`Lime & Wink Proxy listening on port ${PORT}`);
});
