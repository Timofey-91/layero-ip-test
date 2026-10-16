import http from "node:http";
import { URL } from "node:url";
import { Readable } from "node:stream";

const PORT = process.env.PORT || 3000;
const DEVICES_CONFIG_URL = process.env.DEVICES_CONFIG_URL;

let ALLOWED_DEVICES = new Set();

const LIME_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/config.json";

const WINK_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/mediavitrina-proxy/raw/branch/master/wink.json";

const LHD_AGENT = JSON.stringify({
  version_name: "1.0.24.155",
  version_code: "155",
  platform: "web",
  device_id: "448182.66555409547-1790167864304",
  app: "limehd.tv",
  generation: "1",
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
    "User-Agent": "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    "X-LHD-Agent": LHD_AGENT,
    "Referer": "https://limehd.tv/",
    "Origin": "https://limehd.tv",
    "Accept": "*/*",
    "Connection": "keep-alive",
  };
}

async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 2500) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok || res.status === 206 || res.status === 404) return res;
      lastError = new Error(`HTTP status ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, 100));
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function fetchAllowedDevices() {
  if (!DEVICES_CONFIG_URL) return;
  try {
    const res = await fetchWithRetry(DEVICES_CONFIG_URL, { headers: { "Cache-Control": "no-cache" } }, 2, 3000);
    if (res.ok) {
      const devicesArray = await res.json();
      if (Array.isArray(devicesArray)) {
        ALLOWED_DEVICES = new Set(devicesArray.map((d) => String(d).trim()));
      }
    }
  } catch (e) {}
}

async function fetchConfig(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && configCache.data && now < configCache.expiresAt) {
    return configCache.data;
  }

  const [limeRes, winkRes] = await Promise.allSettled([
    fetchWithRetry(LIME_CONFIG_URL, { headers: { "Cache-Control": "no-cache", "User-Agent": "Mozilla/5.0", "X-LHD-Agent": LHD_AGENT } }, 2, 3000),
    fetchWithRetry(WINK_CONFIG_URL, { headers: { "Cache-Control": "no-cache", "User-Agent": "Mozilla/5.0" } }, 2, 3000),
  ]);

  let limeData = {};
  let winkData = {};

  if (limeRes.status === "fulfilled" && limeRes.value.ok) {
    try { limeData = await limeRes.value.json(); } catch (e) {}
  }
  if (winkRes.status === "fulfilled" && winkRes.value.ok) {
    try { winkData = await winkRes.value.json(); } catch (e) {}
  }

  const combinedData = { ...winkData, ...limeData };
  if (Object.keys(combinedData).length > 0) {
    configCache = {
      data: combinedData,
      expiresAt: Date.now() + 60 * 1000,
    };
  }
  return configCache.data || combinedData;
}

setInterval(() => fetchConfig(true).catch(() => {}), 4 * 60 * 1000);
setInterval(() => fetchAllowedDevices().catch(() => {}), 5 * 60 * 1000);

function isM3u8Url(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.pathname.endsWith(".m3u8") || parsed.pathname.includes(".m3u8") || parsed.search.includes(".m3u8");
  } catch {
    return urlStr.includes(".m3u8");
  }
}

function resolveM3u8Urls(m3u8Text, baseUrlStr, devKey = "") {
  const baseUrl = new URL(baseUrlStr);
  const lines = m3u8Text.split("\n");
  const devParam = devKey ? `&dev=${encodeURIComponent(devKey)}` : "";

  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      return line.replace(/URI=["']([^"']+)["']/g, (match, relativeUri) => {
        try {
          const absoluteUri = new URL(relativeUri, baseUrl).toString();
          // Для Lime (cdnvideo.ru) отдаем чистую абсолютную ссылку, для Wink — через прокси
          if (!isWinkUrl(absoluteUri)) return `URI="${absoluteUri}"`;
          const endpoint = isM3u8Url(absoluteUri) ? "/proxy-m3u8" : "/proxy-segment";
          return `URI="${endpoint}?url=${encodeURIComponent(absoluteUri)}${devParam}"`;
        } catch {
          return match;
        }
      });
    }

    try {
      const absoluteUri = new URL(trimmed, baseUrl).toString();
      if (!isWinkUrl(absoluteUri)) {
        // Прямая ссылка на CDNVideo — клиент качает видео напрямую, обходя блокировки Layero
        return absoluteUri;
      }
      const endpoint = isM3u8Url(absoluteUri) ? "/proxy-m3u8" : "/proxy-segment";
      return `${endpoint}?url=${encodeURIComponent(absoluteUri)}${devParam}`;
    } catch {
      return line;
    }
  }).join("\n");
}

function generatePlaylist(config, host, devKey = "") {
  const lines = ["#EXTM3U"];
  const devParam = devKey ? `?dev=${encodeURIComponent(devKey)}` : "";

  for (const channelId of Object.keys(config)) {
    lines.push(`#EXTINF:-1 tvg-id="${channelId}" tvg-name="${channelId}",${channelId}`);
    lines.push(`http://${host}/${channelId}.m3u8${devParam}`);
  }

  return lines.join("\n");
}

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
      response.writeHead(200, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
      response.end("User-agent: *\nDisallow: /");
      return;
    }

    if (url.pathname === "/" || url.pathname === "") {
      response.writeHead(200, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
      response.end("Proxy is running.");
      return;
    }

    const devKey = url.searchParams.get("dev");
    if (DEVICES_CONFIG_URL && ALLOWED_DEVICES.size > 0) {
      if (!devKey || !ALLOWED_DEVICES.has(devKey)) {
        response.writeHead(403, corsHeaders());
        response.end("Access Denied");
        return;
      }
    }

    if (url.pathname === "/playlist.m3u" || url.pathname === "/playlist.m3u8" || url.pathname === "/m3u") {
      const config = await fetchConfig();
      const playlistContent = generatePlaylist(config, hostHeader, devKey);
      response.writeHead(200, { ...corsHeaders(), "Content-Type": "application/x-mpegurl; charset=utf-8" });
      response.end(playlistContent);
      return;
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

        response.writeHead(200, { ...corsHeaders(), "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" });
        response.end(processedM3u8);
      } catch (e) {
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
      if (isWink && request.headers["range"]) reqHeaders["Range"] = request.headers["range"];

      let segmentRes;
      try {
        segmentRes = await fetchWithRetry(targetUrl, { headers: reqHeaders });
      } catch (e) {
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
    const cachedKey = `${path}_${devKey || ""}`;
    const cached = m3u8Cache.get(cachedKey);

    if (cached && now < cached.expiresAt) {
      response.writeHead(200, { ...corsHeaders(), "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" });
      response.end(cached.content);
      return;
    }

    try {
      const config = await fetchConfig();
      const streamUrl = config[path];

      if (!streamUrl) {
        if (cached && cached.content) {
          response.writeHead(200, { ...corsHeaders(), "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" });
          response.end(cached.content);
          return;
        }
        response.writeHead(503, corsHeaders());
        response.end();
        return;
      }

      const streamResponse = await fetchWithRetry(streamUrl, { headers: getHeaders(streamUrl) });
      if (!streamResponse.ok) throw new Error(`CDN status ${streamResponse.status}`);

      const rawM3u8 = await streamResponse.text();
      const processedM3u8 = resolveM3u8Urls(rawM3u8, streamUrl, devKey);

      // Короткий кэш плейлиста для быстрого обновления сегментов
      m3u8Cache.set(cachedKey, {
        content: processedM3u8,
        expiresAt: now + 1000,
      });

      response.writeHead(200, { ...corsHeaders(), "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" });
      response.end(processedM3u8);
    } catch (error) {
      if (cached && cached.content) {
        response.writeHead(200, { ...corsHeaders(), "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" });
        response.end(cached.content);
        return;
      }
      response.writeHead(503, corsHeaders());
      response.end();
    }
  } catch (error) {
    response.writeHead(500, corsHeaders());
    response.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on port ${PORT}`);
  fetchConfig().catch(() => {});
  fetchAllowedDevices().catch(() => {});
});
