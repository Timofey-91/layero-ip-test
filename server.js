import http from "node:http";
import { URL } from "node:url";
import { Readable } from "node:stream";

const PORT = process.env.PORT || 3000;
const DEVICES_CONFIG_URL = process.env.DEVICES_CONFIG_URL;

// ======================================================
// CONFIG URLS
// ======================================================
const LIME_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/config.json";

const WINK_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/mediavitrina-proxy/raw/branch/master/wink.json";

const VITRINA_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/mediavitrina-proxy/raw/branch/master/config.json";

// ======================================================
// HEADERS & AGENTS
// ======================================================
const LHD_AGENT = JSON.stringify({
  version_name: "1.0.2.203",
  version_code: "203",
  platform: "win",
  device_id: "00000000",
  app: "tv.limehd.win",
  generation: "2",
});

const VITRINA_USER_AGENT = "Dalvik/2.1.0 (Linux; U; Android 8.0.1;)";
const VITRINA_REFERER = "https://player.mediavitrina.ru/";

let ALLOWED_DEVICES = new Set();
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

function isWinkUrl(targetUrl) {
  const u = targetUrl.toLowerCase();
  return (
    u.includes("wink") ||
    u.includes("rt.ru") ||
    u.includes("ngenix") ||
    u.includes("cdntv") ||
    u.includes("zabava")
  );
}

function getHeaders(targetUrl) {
  const baseHeaders = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  };

  if (isWinkUrl(targetUrl)) {
    return {
      ...baseHeaders,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://wink.ru/",
      "Origin": "https://wink.ru",
      "Accept": "*/*",
      "Connection": "keep-alive",
    };
  }

  return {
    ...baseHeaders,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "X-LHD-Agent": LHD_AGENT,
    "Referer": "https://limehd.tv/",
    "Origin": "https://limehd.tv",
    "Accept": "*/*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
  };
}

function getVitrinaHeaders() {
  return {
    "User-Agent": VITRINA_USER_AGENT,
    "Referer": VITRINA_REFERER,
    "Accept": "*/*",
  };
}

// ======================================================
// FETCH WITH RETRY
// ======================================================
async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 2500) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok || res.status === 206 || res.status === 404) return res;
      lastError = new Error(`HTTP status ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    if (i < retries - 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

// ======================================================
// DEVICE KEYS (Фоновая загрузка без блокировок)
// ======================================================
async function fetchAllowedDevices() {
  if (!DEVICES_CONFIG_URL) return;

  try {
    const res = await fetchWithRetry(
      DEVICES_CONFIG_URL,
      { headers: { "Cache-Control": "no-cache, no-store" } },
      2,
      3000
    );

    if (res.ok) {
      const devicesArray = await res.json();
      if (Array.isArray(devicesArray)) {
        ALLOWED_DEVICES = new Set(devicesArray.map((d) => String(d).trim()));
      }
    }
  } catch (e) {
    console.error("[Devices] Ошибка загрузки ключей из Gist:", e.message);
  }
}

// ======================================================
// CONFIG LOADER (Lime + Wink + Vitrina)
// ======================================================
async function fetchConfig(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && configCache.data && now < configCache.expiresAt) {
    return configCache.data;
  }

  const refreshInBackground = async () => {
    const [limeRes, winkRes, vitrinaRes] = await Promise.allSettled([
      fetchWithRetry(
        LIME_CONFIG_URL,
        {
          headers: {
            "Cache-Control": "no-cache, no-store",
            "User-Agent": "Mozilla/5.0",
            "X-LHD-Agent": LHD_AGENT,
          },
        },
        2,
        3000
      ),
      fetchWithRetry(
        WINK_CONFIG_URL,
        {
          headers: {
            "Cache-Control": "no-cache, no-store",
            "User-Agent": "Mozilla/5.0",
          },
        },
        2,
        3000
      ),
      fetchWithRetry(
        VITRINA_CONFIG_URL,
        {
          headers: {
            "Cache-Control": "no-cache, no-store",
            "User-Agent": VITRINA_USER_AGENT,
          },
        },
        2,
        3000
      ),
    ]);

    let limeData = {};
    let winkData = {};
    let vitrinaData = {};

    if (limeRes.status === "fulfilled" && limeRes.value.ok) {
      try { limeData = await limeRes.value.json(); } catch (e) {}
    }
    if (winkRes.status === "fulfilled" && winkRes.value.ok) {
      try { winkData = await winkRes.value.json(); } catch (e) {}
    }
    if (vitrinaRes.status === "fulfilled" && vitrinaRes.value.ok) {
      try { vitrinaData = await vitrinaRes.value.json(); } catch (e) {}
    }

    const combinedMap = {};

    // 1. Lime
    for (const [ch, url] of Object.entries(limeData)) {
      combinedMap[ch] = { url, provider: "lime" };
    }
    // 2. Wink
    for (const [ch, url] of Object.entries(winkData)) {
      combinedMap[ch] = { url, provider: "wink" };
    }
    // 3. MediaVitrina (Приоритет)
    for (const [ch, url] of Object.entries(vitrinaData)) {
      combinedMap[ch] = { url, provider: "vitrina" };
    }

    if (Object.keys(combinedMap).length > 0) {
      configCache = {
        data: { ...(configCache.data || {}), ...combinedMap },
        expiresAt: Date.now() + 2 * 60 * 1000,
      };
    }
    return configCache.data || combinedMap;
  };

  if (configCache.data && Object.keys(configCache.data).length > 0) {
    refreshInBackground().catch(() => {});
    return configCache.data;
  }

  return await refreshInBackground();
}

// Автоматические интервалы обновления данных
setInterval(() => fetchConfig(true).catch(() => {}), 4 * 60 * 1000);
setInterval(() => fetchAllowedDevices().catch(() => {}), 5 * 60 * 1000);

// Защита от накопительного роста памяти: сброс микрокэша m3u8 раз в час
setInterval(() => {
  m3u8Cache.clear();
}, 60 * 60 * 1000);

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

// ======================================================
// REWRITERS
// ======================================================

// Lime и Wink (Перенаправление сегментов на /proxy-segment)
function resolveM3u8Urls(m3u8Text, baseUrlStr, devKey = "") {
  const baseUrl = new URL(baseUrlStr);
  const lines = m3u8Text.split("\n");
  const devParam = devKey ? `&dev=${encodeURIComponent(devKey)}` : "";

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
          return `URI="${endpoint}?url=${encodeURIComponent(absoluteUri)}${devParam}"`;
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
      return `${endpoint}?url=${encodeURIComponent(absoluteUri)}${devParam}`;
    } catch {
      return line;
    }
  });

  return resolvedLines.join("\n");
}

// MediaVitrina (Сортировка 1080p на 1 место + Спуфинг битрейта для прохождения лимитов ExoPlayer)
function rewriteVitrinaPlaylist(m3u8Text, targetUrl) {
  let baseUrl;
  try {
    baseUrl = new URL(targetUrl);
  } catch {
    return m3u8Text;
  }

  const lines = m3u8Text.split(/\r?\n/);

  // Если это Master M3U8 с несколькими качествами (#EXT-X-STREAM-INF)
  if (m3u8Text.includes("#EXT-X-STREAM-INF")) {
    const variants = [];
    const mediaTags = [];
    let currentHeader = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith("#EXT-X-MEDIA:")) {
        const rewrittenTag = line.replace(/URI="([^"]+)"/g, (match, uri) => {
          try {
            return `URI="${new URL(uri, baseUrl).toString()}"`;
          } catch {
            return match;
          }
        });
        mediaTags.push(rewrittenTag);
      } else if (line.startsWith("#EXT-X-STREAM-INF")) {
        currentHeader = line;
      } else if (currentHeader && !line.startsWith("#")) {
        let absoluteUrl = line;
        try {
          absoluteUrl = new URL(line, baseUrl).toString();
        } catch {}

        const bwMatch = currentHeader.match(/BANDWIDTH=(\d+)/);
        const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

        const rewrittenHeader = currentHeader.replace(/URI="([^"]+)"/g, (match, uri) => {
          try {
            return `URI="${new URL(uri, baseUrl).toString()}"`;
          } catch {
            return match;
          }
        });

        variants.push({
          header: rewrittenHeader,
          url: absoluteUrl,
          bandwidth: bandwidth,
        });
        currentHeader = null;
      }
    }

    if (variants.length > 0) {
      // 1. Сортируем: наибольший реальный битрейт (1080p) встаёт на 1 место
      variants.sort((a, b) => b.bandwidth - a.bandwidth);

      // 2. Спуфинг: занижаем запрашиваемый битрейт 1080p до 2.5 Мбит/с,
      // чтобы ExoPlayer сразу подхватывал его при старте даже на скорости 10 Мбит/с
      variants[0].header = variants[0].header
        .replace(/BANDWIDTH=\d+/, "BANDWIDTH=2500000")
        .replace(/AVERAGE-BANDWIDTH=\d+/, "AVERAGE-BANDWIDTH=2000000");

      let result = "#EXTM3U\n";
      for (const tag of mediaTags) {
        result += `${tag}\n`;
      }
      for (const v of variants) {
        result += `${v.header}\n${v.url}\n`;
      }
      return result;
    }
  }

  // Для моно-плейлистов просто приводим пути к абсолютным
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (match, uri) => {
          try {
            return `URI="${new URL(uri, baseUrl).toString()}"`;
          } catch {
            return match;
          }
        });
      }

      if (!trimmed.startsWith("#")) {
        try {
          return new URL(trimmed, baseUrl).toString();
        } catch {
          return line;
        }
      }

      return line;
    })
    .join("\n");
}

// ======================================================
// SERVER
// ======================================================
const server = http.createServer(async (request, response) => {
  try {
    const hostHeader = request.headers.host || "localhost";
    const url = new URL(request.url, `http://${hostHeader}`);

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    // 2. Robots.txt
    if (url.pathname === "/robots.txt") {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("User-agent: *\nDisallow: /");
      return;
    }

    // 3. Health Check (Корень / открыт для зеленого статуса в Layero)
    if (url.pathname === "/" || url.pathname === "") {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("All-in-One TV Proxy (Lime + Wink + Vitrina) is running.");
      return;
    }

    // 4. Проверка ключа устройства
    const devKey = url.searchParams.get("dev");
    if (DEVICES_CONFIG_URL && ALLOWED_DEVICES.size > 0) {
      if (!devKey || !ALLOWED_DEVICES.has(devKey)) {
        response.writeHead(403, corsHeaders());
        response.end("Access Denied: Invalid device key");
        return;
      }
    }

    // 5. Проксирование вложенных M3U8 (Lime/Wink)
    if (url.pathname === "/proxy-m3u8") {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        response.writeHead(400, corsHeaders());
        response.end();
        return;
      }

      try {
        const subRes = await fetchWithRetry(targetUrl, {
          headers: getHeaders(targetUrl),
        });

        if (!subRes.ok) {
          response.writeHead(subRes.status, corsHeaders());
          response.end();
          return;
        }

        const rawM3u8 = await subRes.text();
        const processedM3u8 = resolveM3u8Urls(rawM3u8, targetUrl, devKey);

        response.writeHead(200, {
          ...corsHeaders(),
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        });
        response.end(processedM3u8);
      } catch (e) {
        console.error("Error proxying m3u8:", e.message);
        response.writeHead(503, corsHeaders());
        response.end();
      }
      return;
    }

    // 6. Проксирование видеосегментов (Lime/Wink)
    if (url.pathname === "/proxy-segment") {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        response.writeHead(400, corsHeaders());
        response.end();
        return;
      }

      const isWink = isWinkUrl(targetUrl);
      const reqHeaders = getHeaders(targetUrl);

      if (isWink && request.headers["range"]) {
        reqHeaders["Range"] = request.headers["range"];
      }

      let segmentRes;
      try {
        segmentRes = await fetchWithRetry(targetUrl, { headers: reqHeaders });
      } catch (e) {
        console.error("Error proxying segment:", e.message);
        response.writeHead(503, corsHeaders());
        response.end();
        return;
      }

      const isOk = segmentRes.ok || (isWink && segmentRes.status === 206);

      if (!isOk) {
        response.writeHead(segmentRes.status || 503, corsHeaders());
        response.end();
        return;
      }

      const resHeaders = {
        ...corsHeaders(),
        "Content-Type":
          segmentRes.headers.get("content-type") || "video/mp2t",
      };

      const contentLength = segmentRes.headers.get("content-length");
      if (contentLength) resHeaders["Content-Length"] = contentLength;

      if (isWink && segmentRes.headers.get("content-range")) {
        resHeaders["Content-Range"] = segmentRes.headers.get("content-range");
      }

      response.writeHead(segmentRes.status, resHeaders);

      if (segmentRes.body) {
        const stream = Readable.fromWeb(segmentRes.body);
        stream.on("error", () => {});
        response.on("close", () => stream.destroy());
        stream.pipe(response);
      } else {
        response.end();
      }
      return;
    }

    // 7. Обработка прямых запросов каналов (например /tvc, /tvc.m3u8, /1tv, /ctc)
    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");

    const now = Date.now();
    const cachedKey = `${path}_${devKey}`;
    const cached = m3u8Cache.get(cachedKey);

    if (cached && now < cached.expiresAt) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      });
      response.end(cached.content);
      return;
    }

    try {
      const config = await fetchConfig();
      const channelInfo = config[path];

      if (!channelInfo || !channelInfo.url) {
        if (cached && cached.content) {
          response.writeHead(200, {
            ...corsHeaders(),
            "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
          });
          response.end(cached.content);
          return;
        }

        response.writeHead(503, corsHeaders());
        response.end();
        return;
      }

      let processedM3u8 = "";

      if (channelInfo.provider === "vitrina") {
        // Запрос к Витрине (беспроксирующий режим)
        const streamResponse = await fetchWithRetry(
          channelInfo.url,
          { headers: getVitrinaHeaders() },
          2,
          4000
        );

        if (!streamResponse.ok) {
          throw new Error(`Vitrina status ${streamResponse.status}`);
        }

        const rawM3u8 = await streamResponse.text();
        processedM3u8 = rewriteVitrinaPlaylist(rawM3u8, channelInfo.url);
      } else {
        // Запрос к Lime / Wink (режим подмены заголовков)
        const streamResponse = await fetchWithRetry(channelInfo.url, {
          headers: getHeaders(channelInfo.url),
        });

        if (!streamResponse.ok) {
          throw new Error(`CDN status ${streamResponse.status}`);
        }

        const rawM3u8 = await streamResponse.text();
        processedM3u8 = resolveM3u8Urls(rawM3u8, channelInfo.url, devKey);
      }

      m3u8Cache.set(cachedKey, {
        content: processedM3u8,
        expiresAt: now + 1000,
      });

      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      });
      response.end(processedM3u8);
    } catch (error) {
      console.error(`Error fetching M3U8 for ${path}:`, error.message);

      if (cached && cached.content) {
        response.writeHead(200, {
          ...corsHeaders(),
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        });
        response.end(cached.content);
        return;
      }

      response.writeHead(503, corsHeaders());
      response.end();
    }
  } catch (error) {
    console.error("Unhandled Server Error:", error);
    response.writeHead(500, corsHeaders());
    response.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`All-in-One Proxy listening on port ${PORT}`);
  fetchConfig().catch(() => {});
  fetchAllowedDevices().catch(() => {});
});
