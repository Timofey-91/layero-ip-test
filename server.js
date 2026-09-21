import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

// Источники конфигов
const LIME_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/config.json";
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

async function fetchConfigs(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && configCache.data && now < configCache.expiresAt) {
    return configCache.data;
  }

  // Загружаем оба конфига параллельно
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

  let combinedConfig = {};

  if (limeRes.status === "fulfilled" && limeRes.value.ok) {
    try {
      const limeData = await limeRes.value.json();
      combinedConfig = { ...combinedConfig, ...limeData };
    } catch (e) {
      console.error("Error parsing Lime config:", e);
    }
  }

  if (winkRes.status === "fulfilled" && winkRes.value.ok) {
    try {
      const winkData = await winkRes.value.json();
      combinedConfig = { ...combinedConfig, ...winkData };
    } catch (e) {
      console.error("Error parsing Wink config:", e);
    }
  }

  configCache = {
    data: combinedConfig,
    expiresAt: now + 30 * 1000, // Кэш конфигов 30 секунд
  };

  return combinedConfig;
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

      // Если поток LimeHD/Telecloud — передаем специфичные заголовки, иначе стандартные
      const isLime =
        targetUrl.includes("lime") || targetUrl.includes("telecloud");

      const segmentHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
        "Connection": "keep-alive",
      };

      if (isLime) {
        segmentHeaders["X-LHD-Agent"] = LHD_AGENT;
        segmentHeaders["Referer"] = "https://limehd.tv/";
        segmentHeaders["Origin"] = "https://limehd.tv";
      }

      const segmentRes = await fetch(targetUrl, { headers: segmentHeaders });

      if (!segmentRes.ok) {
        m3u8Cache.clear();
        configCache.data = null;

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
      response.end("IPTV Multi-Proxy (Lime + Wink) is running.");
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

    const config = await fetchConfigs();
    const streamUrl = config[path];

    if (!streamUrl) {
      response.writeHead(404, corsHeaders());
      response.end("Channel not found");
      return;
    }

    const isLime =
      streamUrl.includes("lime") || streamUrl.includes("telecloud");

    const playlistHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "*/*",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "Connection": "keep-alive",
    };

    if (isLime) {
      playlistHeaders["X-LHD-Agent"] = LHD_AGENT;
      playlistHeaders["Referer"] = "https://limehd.tv/";
      playlistHeaders["Origin"] = "https://limehd.tv";
    }

    const playlistResponse = await fetch(streamUrl, {
      headers: playlistHeaders,
    });

    if (!playlistResponse.ok) {
      response.writeHead(playlistResponse.status, corsHeaders());
      response.end();
      return;
    }

    const rawM3u8 = await playlistResponse.text();
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
  console.log(`IPTV Multi-Proxy listening on port ${PORT}`);
});
