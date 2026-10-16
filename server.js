import http from "node:http";
import { URL } from "node:url";
import { Readable } from "node:stream";
import dns from "node:dns";

// КРИТИЧНО для доступа к российским API с зарубежных/облачных IP
dns.setDefaultResultOrder("ipv4first");

const PORT = process.env.PORT || 8000;
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
let configCache = { data: null, fetchedAt: 0 };
let LIME_DYNAMIC = {}; // { tvc_plus2: "https://...", ... } — свежие ссылки из API Lime
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
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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
      { headers: { "Cache-Control": "no-cache, no-store", "User-Agent": "Mozilla/5.0", "X-LHD-Agent": LHD_AGENT } },
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

  // 1. Статические Lime-ссылки из config.json на GitVerse
  for (const [ch, url] of Object.entries(limeData)) {
    combinedMap[ch] = { url, provider: "lime" };
  }
  // 2. Динамические Lime-ссылки (перекрывают статические — они свежее)
  for (const [ch, url] of Object.entries(LIME_DYNAMIC)) {
    combinedMap[ch] = { url, provider: "lime" };
  }
  // 3. Wink
  for (const [ch, url] of Object.entries(winkData)) {
    combinedMap[ch] = { url, provider: "wink" };
  }
  // 4. Vitrina (высший приоритет)
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
// LIMEHD — АВТООБНОВЛЕНИЕ ССЫЛОК (порт Python-скрипта)
// ======================================================
const LIME_API_TIMEOUT = 20000;

const LIME_TARGET_CHANNELS = [
  { key: "tvc_plus2", id: 129, region: 66, tz: 5 },
  { key: "tvc_plus4", id: 129, region: 54, tz: 7 },
  { key: "tvc_plus6", id: 129, region: 25, tz: 10 },
];

async function limeFetch(url, options = {}, timeoutMs = LIME_API_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

function limeFindMasterUrl(obj) {
  if (!obj) return null;
  if (typeof obj === "string") {
    return (obj.startsWith("http") && obj.includes("index.m3u8")) ? obj : null;
  }
  if (Array.isArray(obj)) {
    for (const it of obj) { const f = limeFindMasterUrl(it); if (f) return f; }
  } else if (typeof obj === "object") {
    for (const v of Object.values(obj)) { const f = limeFindMasterUrl(v); if (f) return f; }
  }
  return null;
}

async function limeGetMaster(chId, region, tz) {
  const apiUrl = `https://pl.iptv2021.com/api/v4/channel?id=${chId}&tz=${tz}&region=${region}`;
  const res = await limeFetch(apiUrl, { headers: getHeaders(apiUrl) });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const data = await res.json();
  const master = limeFindMasterUrl(data);
  if (!master) throw new Error("Master URL не найден в ответе API");
  return master;
}

async function limeGetMasterPlaylist(masterUrl) {
  const res = await limeFetch(masterUrl, { headers: getHeaders(masterUrl) });
  if (!res.ok) throw new Error(`Master HTTP ${res.status}`);
  return { finalUrl: res.url, text: await res.text() };
}

function limeParseVideoStreams(masterUrl, playlist) {
  const lines = playlist.split(/\r?\n/);
  const streams = [];
  let currentInf = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#EXT-X-STREAM-INF:")) { currentInf = t; continue; }
    if (currentInf && !t.startsWith("#")) {
      const resM = currentInf.match(/RESOLUTION=(\d+x\d+)/);
      const bwM = currentInf.match(/BANDWIDTH=(\d+)/);
      streams.push({
        resolution: resM ? resM[1] : "",
        bandwidth: bwM ? parseInt(bwM[1], 10) : 0,
        url: new URL(t, masterUrl).toString(),
      });
      currentInf = null;
    }
  }
  if (!streams.length) throw new Error("Нет VIDEO-потоков в master");
  return streams;
}

function limeChooseStream(streams) {
  const sorted = [...streams].sort((a, b) => b.bandwidth - a.bandwidth);
  // Берём 3-й сверху (обычно 480p) — как в Python-скрипте
  return sorted.length >= 3 ? sorted[2] : sorted[sorted.length - 1];
}

async function limeVerifyPlaylist(stream) {
  const res = await limeFetch(stream.url, { headers: getHeaders(stream.url) });
  if (!res.ok) throw new Error(`Playlist HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes("#EXTM3U")) throw new Error("Не HLS playlist");
  const segs = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (!segs.length) throw new Error("Нет TS-сегментов");

  for (const seg of segs.slice(-3).reverse()) {
    try {
      const segUrl = new URL(seg, res.url).toString();
      const r = await limeFetch(segUrl, { headers: getHeaders(segUrl) }, 10000);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length >= 4 && buf[0] === 0x47) return res.url;
    } catch { /* next */ }
  }
  throw new Error("TS-сегменты не проверились");
}

async function refreshLimeLinks() {
  console.log("[Lime] Обновление ссылок...");
  const result = {};
  for (const ch of LIME_TARGET_CHANNELS) {
    try {
      const master = await limeGetMaster(ch.id, ch.region, ch.tz);
      const { finalUrl, text } = await limeGetMasterPlaylist(master);
      const streams = limeParseVideoStreams(finalUrl, text);
      const selected = limeChooseStream(streams);
      const finalUrl2 = await limeVerifyPlaylist(selected);
      result[ch.key] = finalUrl2;
      console.log(`[Lime] ✅ ${ch.key}: ${selected.resolution}`);
    } catch (e) {
      console.error(`[Lime] ❌ ${ch.key}: ${e.message}${e.cause ? ` | ${e.cause.code || e.cause.message}` : ""}`);
    }
  }
  if (Object.keys(result).length) LIME_DYNAMIC = result;
  return result;
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

    // 🔥 ВРЕМЕННЫЙ ТЕСТОВЫЙ ЭНДПОИНТ — проверьте его ДО всего остального!
    // Открыть: https://ваш-домен.layero.app/test-lime-api
    if (url.pathname === "/test-lime-api") {
      try {
        const r = await fetch("https://pl.iptv2021.com/api/v4/channel?id=129&tz=5&region=66", {
          headers: getHeaders("https://pl.iptv2021.com"),
          signal: AbortSignal.timeout(15000),
        });
        const txt = await r.text();
        response.writeHead(200, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
        response.end(`STATUS: ${r.status}\n\n${txt.slice(0, 2000)}`);
      } catch (e) {
        response.writeHead(200, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
        response.end(`ERROR: ${e.message}\nCause: ${e.cause?.code || e.cause?.message || "n/a"}`);
      }
      return;
    }

    if (url.pathname === "/test-lime-status") {
      response.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ dynamic: LIME_DYNAMIC }, null, 2));
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
      console.error(`Error fetching M3U8 for ${path}:`, error.message, error.cause ? `| Cause: ${error.cause.message || error.cause.code}` : '');
      
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

  // Запускаем обновление Lime-ссылок сразу и каждые 20 минут
  refreshLimeLinks().catch(console.error);
  setInterval(() => refreshLimeLinks().catch(console.error), 20 * 60 * 1000);
});
