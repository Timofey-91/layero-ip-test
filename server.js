import http from "node:http";
import { URL } from "node:url";
import { Readable } from "node:stream";

const PORT = process.env.PORT || 3000;

// URL секретного файла Gist читается из переменных окружения Layero
const DEVICES_CONFIG_URL = process.env.DEVICES_CONFIG_URL;

// Множество разрешенных ключей устройств
let ALLOWED_DEVICES = new Set();

// Конфиг Wink (оставляем без изменений)
const WINK_CONFIG_URL =
  "https://gitverse.ru/api/repos/Timofey91/mediavitrina-proxy/raw/branch/master/wink.json";

// Параметры Lime каналов для авто-генерации свежих ссылок на лету
const LIME_CHANNELS = {
  "tvc_plus2": { id: 129, region: 66, tz: 5 },
  "tvc_plus4": { id: 129, region: 54, tz: 7 },
  "tvc_plus6": { id: 129, region: 25, tz: 10 },
};

const LHD_AGENT = JSON.stringify({
  version_name: "1.0.24.155",
  version_code: "155",
  platform: "web",
  device_id: "448182.66555409547-1790167864304",
  app: "limehd.tv",
  generation: "1",
});

let winkConfigCache = { data: null, expiresAt: 0 };
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
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
  };
}

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

// Подгрузка списка разрешенных ключей устройств из Secret Gist
async function fetchAllowedDevices() {
  if (!DEVICES_CONFIG_URL) {
    return;
  }

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
  } catch (e) {}
}

// Загрузка конфига Wink
async function fetchWinkConfig(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && winkConfigCache.data && now < winkConfigCache.expiresAt) {
    return winkConfigCache.data;
  }

  try {
    const res = await fetchWithRetry(
      WINK_CONFIG_URL,
      { headers: { "Cache-Control": "no-cache, no-store", "User-Agent": "Mozilla/5.0" } },
      2,
      3000
    );
    if (res.ok) {
      const data = await res.json();
      winkConfigCache = {
        data,
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
      return data;
    }
  } catch (e) {}
  return winkConfigCache.data || {};
}

// Обновление конфигов Wink раз в 4 минуты
setInterval(() => {
  fetchWinkConfig(true).catch(() => {});
}, 4 * 60 * 1000);

// Авто-обновление ключей устройств из Secret Gist каждые 5 минут
setInterval(() => {
  fetchAllowedDevices().catch(() => {});
}, 5 * 60 * 1000);

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

// Превращаем относительные пути сегментов в абсолютные прямые URL на CDN (чтобы плеер качал напрямую)
function resolveAbsoluteUrls(m3u8Text, baseUrlStr, devKey = "") {
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
          if (isWinkUrl(absoluteUri)) {
            const endpoint = isM3u8Url(absoluteUri) ? "/proxy-m3u8" : "/proxy-segment";
            return `URI="${endpoint}?url=${encodeURIComponent(absoluteUri)}${devParam}"`;
          }
          return `URI="${absoluteUri}"`;
        } catch {
          return match;
        }
      });
    }

    try {
      const absoluteUri = new URL(trimmed, baseUrl).toString();
      // Для Wink оставляем проксирование через Layero, для Lime — отдаем прямую абсолютную ссылку на CDNVideo
      if (isWinkUrl(absoluteUri)) {
        const endpoint = isM3u8Url(absoluteUri) ? "/proxy-m3u8" : "/proxy-segment";
        return `${endpoint}?url=${encodeURIComponent(absoluteUri)}${devParam}`;
      }
      return absoluteUri;
    } catch {
      return line;
    }
  });

  return resolvedLines.join("\n");
}

// Помощник для извлечения мастер-ссылки из Lime API
function extractMasterUrl(obj) {
  let found = null;
  function search(target) {
    if (found) return;
    if (typeof target === "string" && target.startsWith("http") && target.includes("index.m3u8")) {
      found = target;
      return;
    }
    if (typeof target === "object" && target !== null) {
      for (const val of Object.values(target)) search(val);
    }
  }
  search(obj);
  return found;
}

// Выбор потока 480p (или ближайшего доступного)
function selectStreamUrl(masterM3u8Text, masterBaseUrl) {
  const lines = masterM3u8Text.split(/\r?\n/);
  const streams = [];
  let currentInf = null;

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      currentInf = line;
      continue;
    }
    if (currentInf && line && !line.startsWith("#")) {
      const bwMatch = currentInf.match(/BANDWIDTH=(\d+)/);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      streams.push({ bandwidth: bw, url: new URL(line, masterBaseUrl).toString() });
      currentInf = null;
    }
  }

  if (streams.length === 0) return masterBaseUrl;
  streams.sort((a, b) => b.bandwidth - a.bandwidth);
  return streams.length >= 3 ? streams[2].url : streams[streams.length - 1].url;
}

// Генерация общего M3U плейлиста
async function generatePlaylist(host, devKey = "") {
  const winkConfig = await fetchWinkConfig();
  const lines = ["#EXTM3U"];
  const devParam = devKey ? `?dev=${encodeURIComponent(devKey)}` : "";

  // Добавляем Lime каналы
  for (const channelId of Object.keys(LIME_CHANNELS)) {
    lines.push(`#EXTINF:-1 tvg-id="${channelId}" tvg-name="${channelId}",${channelId}`);
    lines.push(`http://${host}/${channelId}.m3u8${devParam}`);
  }

  // Добавляем Wink каналы
  for (const channelId of Object.keys(winkConfig)) {
    if (!LIME_CHANNELS[channelId]) {
      lines.push(`#EXTINF:-1 tvg-id="${channelId}" tvg-name="${channelId}",${channelId}`);
      lines.push(`http://${host}/${channelId}.m3u8${devParam}`);
    }
  }

  return lines.join("\n");
}

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

    // 2. Отбивка поисковых ботов
    if (url.pathname === "/robots.txt") {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("User-agent: *\nDisallow: /");
      return;
    }

    // 3. Корень / - Пинг
    if (url.pathname === "/" || url.pathname === "") {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Lime & Wink TV Proxy is running.");
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

    // 5. Выгрузка M3U плейлиста
    if (
      url.pathname === "/playlist.m3u" ||
      url.pathname === "/playlist.m3u8" ||
      url.pathname === "/m3u"
    ) {
      const playlistContent = await generatePlaylist(hostHeader, devKey);
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "application/x-mpegurl; charset=utf-8",
      });
      response.end(playlistContent);
      return;
    }

    // 6. Проксирование вложенных M3U8 (для Wink)
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
        const processedM3u8 = resolveAbsoluteUrls(rawM3u8, targetUrl, devKey);

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

    // 7. Проксирование сегментов (для Wink)
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

    // 8. Запрос M3U8 плейлиста конкретного канала
    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");
    const now = Date.now();
    const cachedKey = `${path}_${devKey || ""}`;
    const cached = m3u8Cache.get(cachedKey);

    if (cached && now < cached.expiresAt) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      });
      response.end(cached.content);
      return;
    }

    let processedM3u8 = "";

    try {
      // Если это Lime канал — генерируем свежую ссылку на лету с заголовками Lime
      if (LIME_CHANNELS[path]) {
        const ch = LIME_CHANNELS[path];
        const apiUrl = `https://pl.iptv2021.com/api/v4/channel?id=${ch.id}&tz=${ch.tz}&region=${ch.region}`;
        
        const apiRes = await fetchWithRetry(apiUrl, { headers: getHeaders(apiUrl) }, 2, 3500);
        if (!apiRes.ok) throw new Error(`Lime API status ${apiRes.status}`);
        
        const apiData = await apiRes.json();
        const masterUrl = extractMasterUrl(apiData);
        if (!masterUrl) throw new Error("Master URL not found");

        const masterRes = await fetchWithRetry(masterUrl, { headers: getHeaders(masterUrl) }, 2, 3500);
        if (!masterRes.ok) throw new Error(`Master playlist status ${masterRes.status}`);

        const finalMasterUrl = masterRes.url || masterUrl;
        const masterText = await masterRes.text();
        const selectedStreamUrl = selectStreamUrl(masterText, finalMasterUrl);

        const streamRes = await fetchWithRetry(selectedStreamUrl, { headers: getHeaders(selectedStreamUrl) }, 2, 3500);
        if (!streamRes.ok) throw new Error(`Stream playlist status ${streamRes.status}`);

        const finalStreamUrl = streamRes.url || selectedStreamUrl;
        const rawM3u8 = await streamRes.text();

        processedM3u8 = resolveAbsoluteUrls(rawM3u8, finalStreamUrl, devKey);

        // Кэшируем плейлист на 50 минут (токены CDNVideo живут долго)
        m3u8Cache.set(cachedKey, {
          content: processedM3u8,
          expiresAt: now + 50 * 60 * 1000,
        });

      } else {
        // Обычные каналы (Wink и другие из конфига)
        const winkConfig = await fetchWinkConfig();
        const streamUrl = winkConfig[path];

        if (!streamUrl) {
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

        const streamResponse = await fetchWithRetry(streamUrl, {
          headers: getHeaders(streamUrl),
        });

        if (!streamResponse.ok) {
          throw new Error(`Wink CDN status ${streamResponse.status}`);
        }

        const rawM3u8 = await streamResponse.text();
        processedM3u8 = resolveAbsoluteUrls(rawM3u8, streamUrl, devKey);

        m3u8Cache.set(cachedKey, {
          content: processedM3u8,
          expiresAt: now + 2 * 60 * 1000, // Кэш для Wink на 2 минуты
        });
      }

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
          "Content-Type": "application/vnd.apple.mpegurl; channels=1; charset=utf-8",
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
  console.log(`Proxy listening on port ${PORT}`);
  fetchWinkConfig().catch(() => {});
  fetchAllowedDevices().catch(() => {});
});
