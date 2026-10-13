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
  platform: "android",
  app: "limehd.ru.ctvshka",
  version_name: "5.0.8",
  version_code: "430",
  sdk: "34",
  name: "Xiaomi 13 Ultra",
  device_id: "a7f8e9d1c2b3a4f5",
  is_huawei: "0",
});

const VITRINA_USER_AGENT = "Dalvik/2.1.0 (Linux; U; Android 8.0.1;)";
const VITRINA_REFERER = "https://player.mediavitrina.ru/";

let ALLOWED_DEVICES = new Set();
let configCache = { data: null, fetchedAt: 0 };
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
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 14; Xiaomi 13 Ultra Build/UP1A.231005.007)",
    "X-LHD-Agent": LHD_AGENT,
    "Referer": "https://limehd.tv/",
    "Origin": "https://limehd.tv",
    "Accept": "*/*",
    "Accept-Language": "ru-RU,ru;q=0.9",
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
async function fetchWithRetry(url, options = {}, retries = 3, timeoutMs = 5000) {
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
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

// ======================================================
// DEVICE KEYS
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
// CONFIG LOADER (Сброс кэша 2 раза в сутки: в 03:22 и 15:22 по Ташкенту)
// ======================================================
function getLatestResetTimestamp() {
  const now = new Date();
  const tashkentMs = now.getTime() + (5 * 3600 * 1000);
  const tashkentDate = new Date(tashkentMs);
  
  const year = tashkentDate.getUTCFullYear();
  const month = tashkentDate.getUTCMonth();
  const day = tashkentDate.getUTCDate();
  
  const slot1Utc = Date.UTC(year, month, day, 3, 22, 0, 0);
  const slot2Utc = Date.UTC(year, month, day, 15, 22, 0, 0);
  
  let lastResetTashkentUtc;
  if (tashkentMs >= slot2Utc) {
    lastResetTashkentUtc = slot2Utc;
  } else if (tashkentMs >= slot1Utc) {
    lastResetTashkentUtc = slot1Utc;
  } else {
    lastResetTashkentUtc = Date.UTC(year, month, day - 1, 15, 22, 0, 0);
  }
  
  return lastResetTashkentUtc - (5 * 3600 * 1000);
}

async function fetchConfig(forceRefresh = false) {
  const lastResetTime = getLatestResetTimestamp();

  if (!forceRefresh && configCache.data && configCache.fetchedAt >= lastResetTime) {
    return configCache.data;
  }

  const [limeRes, winkRes, vitrinaRes] = await Promise.allSettled([
    fetchWithRetry(
      LIME_CONFIG_URL,
      { headers: { "Cache-Control": "no-cache, no-store", "User-Agent": "Dalvik/2.1.0", "X-LHD-Agent": LHD_AGENT } },
      3,
      5000
    ),
    fetchWithRetry(
      WINK_CONFIG_URL,
      { headers: { "Cache-Control": "no-cache, no-store", "User-Agent": "Mozilla/5.0" } },
      3,
      5000
    ),
    fetchWithRetry(
      VITRINA_CONFIG_URL,
      { headers: { "Cache-Control": "no-cache, no-store", "User-Agent": VITRINA_USER_AGENT } },
      3,
      5000
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

  for (const [ch, url] of Object.entries(limeData)) {
    combinedMap[ch] = { url, provider: "lime" };
  }
  for (const [ch, url] of Object.entries(winkData)) {
    combinedMap[ch] = { url, provider: "wink" };
  }
  for (const [ch, url] of Object.entries(vitrinaData)) {
    combinedMap[ch] = { url, provider: "vitrina" };
  }

  if (Object.keys(combinedMap).length > 0) {
    configCache = {
      data: combinedMap,
      fetchedAt: Date.now(),
    };
  }

  return configCache.data || combinedMap;
}

setInterval(() => fetchAllowedDevices().catch(() => {}), 10 * 60 * 1000);
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

function rewriteVitrinaPlaylist(m3u8Text, targetUrl) {
  let baseUrl;
  try {
    baseUrl = new URL(targetUrl);
  } catch {
    return m3u8Text;
  }

  return m3u8Text
    .split(/\r?\n/)
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

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (url.pathname === "/robots.txt") {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("User-agent: *\nDisallow: /");
      return;
    }

    if (url.pathname === "/" || url.pathname === "") {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("All-in-One TV Proxy (Lime + Wink + Vitrina) is running.");
      return;
    }

    const devKey = url.searchParams.get("dev");
    if (DEVICES_CONFIG_URL && ALLOWED_DEVICES.size > 0) {
      if (!devKey || !ALLOWED_DEVICES.has(devKey)) {
        response.writeHead(403, corsHeaders());
        response.end("Access Denied: Invalid device key");
        return;
      }
    }

    if (url.pathname === "/proxy-m3u8") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        response.writeHead(400, corsHeaders());
        response.end();
        return;
      }

      try {
        const subRes = await fetchWithRetry(targetUrl, { headers: getHeaders(targetUrl) });
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
        "Content-Type": segmentRes.headers.get("content-type") || "video/mp2t",
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
        const streamResponse = await fetchWithRetry(
          channelInfo.url,
          { headers: getVitrinaHeaders() },
          3,
          5000
        );

        if (!streamResponse.ok) {
          throw new Error(`Vitrina status ${streamResponse.status}`);
        }

        const rawM3u8 = await streamResponse.text();
        processedM3u8 = rewriteVitrinaPlaylist(rawM3u8, channelInfo.url);
      } else {
        const streamResponse = await fetchWithRetry(
          channelInfo.url, 
          { headers: getHeaders(channelInfo.url) },
          3,
          5000
        );

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
