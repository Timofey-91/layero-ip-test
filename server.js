import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

// ======================================================
// PEERSTV CONFIG
// ======================================================
const USER_AGENT = "Dalvik/2.1.0 (Linux; U; Android 8.0.1 tints)";
const REFERER = "https://peers.tv";

const PRIMARY_CONFIG_URL =
  "https://raw.githubusercontent.com/Timofey-91/iptv-proxy/refs/heads/main/config.json";

const BACKUP_CONFIG_URL =
  "https://raw.githubusercontent.com/Timofey-91/iptv-proxy-2/refs/heads/main/config.json";

// Переменные для кэширования успешного источника в памяти
let lastWorkingSource = null; // "primary" или "backup"
let sourceCacheExpiresAt = 0; // Время жизни кэша источника

// ======================================================
// CORS & HEADERS
// ======================================================
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function sendError(response, status, message) {
  response.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(message);
}

// ======================================================
// REWRITE M3U8 TO ABSOLUTE URLS
// ======================================================
function rewritePlaylist(text, targetUrl) {
  let baseUrl;
  try {
    baseUrl = new URL(targetUrl);
  } catch {
    return text;
  }

  // 1. Применяем ваши регулярки для PeersTV
  let processedText = text.replace(/^#BYTEFOG-INF.*\n?/gm, "");
  processedText = processedText.replace(/\/tvc_plus\d+\//g, "");

  // 2. Делаем пути абсолютными (чтобы клиент качал видео сам)
  const lines = processedText.split(/\r?\n/);
  
  return lines.map(line => {
    const trimmed = line.trim();

    if (!trimmed) {
      return line;
    }

    // Если это служебный тег с URI="..." (например #EXT-X-KEY)
    if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        try {
          const absolute = new URL(uri, baseUrl).toString();
          return `URI="${absolute}"`;
        } catch {
          return match;
        }
      });
    }

    // Если это путь к сегменту (.ts) или вложенному плейлисту
    if (!trimmed.startsWith("#")) {
      try {
        return new URL(trimmed, baseUrl).toString();
      } catch {
        return line;
      }
    }

    return line;
  }).join("\n");
}

// ======================================================
// FETCH HELPERS
// ======================================================
async function fetchConfig(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
  return await r.json();
}

async function fetchStream(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": REFERER,
    },
  });
  if (!r.ok) throw new Error(`Stream fetch failed: ${r.status}`);
  return r;
}

// ======================================================
// SERVER
// ======================================================
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );

    // OPTIONS (CORS)
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    // Допускаем только GET и HEAD
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendError(response, 405, "Method Not Allowed");
    }

    // Получаем имя канала из пути (убираем слэши и .m3u8)
    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");

    if (!path) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("PeersTV Proxy is working.\n\nExamples:\n/1tv\n/russia1");
      return;
    }

    let config = null;
    let targetUrl = null;
    let resp = null;

    const isCacheValid = lastWorkingSource && Date.now() < sourceCacheExpiresAt;

    // ============================================================
    // ВАРИАНТ А: Если кэш помнит, что работал резервный источник
    // ============================================================
    if (isCacheValid && lastWorkingSource === "backup") {
      try {
        config = await fetchConfig(BACKUP_CONFIG_URL);
        if (path in config) {
          targetUrl = config[path];
          resp = await fetchStream(targetUrl);
        }
      } catch (backupErr) {
        console.log("Кэшированный резерв подвел, сбрасываем кэш...");
        lastWorkingSource = null;
        resp = null;
      }
    }

    // ============================================================
    // ВАРИАНТ Б: Обычная логика — сначала Primary
    // ============================================================
    if (!resp) {
      try {
        config = await fetchConfig(PRIMARY_CONFIG_URL);
        if (path in config) {
          targetUrl = config[path];
          resp = await fetchStream(targetUrl);
          
          lastWorkingSource = "primary";
          sourceCacheExpiresAt = Date.now() + 5 * 60 * 1000;
        }
      } catch (e) {
        console.log("Основной конфиг подвел. Причина:", e.message);
        resp = null;
      }
    }

    // ============================================================
    // ВАРИАНТ В: Экстренный переход на Backup
    // ============================================================
    if (!resp && (!isCacheValid || lastWorkingSource !== "backup")) {
      try {
        config = await fetchConfig(BACKUP_CONFIG_URL);
        
        if (!config || !(path in config)) {
          return sendError(response, 404, "Channel not found in backup config");
        }

        targetUrl = config[path];
        resp = await fetchStream(targetUrl);
        
        lastWorkingSource = "backup";
        sourceCacheExpiresAt = Date.now() + 5 * 60 * 1000;
      } catch (backupError) {
        return sendError(response, 502, `All sources failed. Error: ${backupError.message}`);
      }
    }

    // ============================================================
    // ОБРАБОТКА ПЛЕЙЛИСТА
    // ============================================================
    if (!resp || !resp.ok) {
      return sendError(response, 502, "PeersTV Stream Error from all sources");
    }

    // HEAD запрос возвращаем без скачивания тела
    if (request.method === "HEAD") {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "application/vnd.apple.mpegurl",
      });
      response.end();
      return;
    }

    const body = await resp.text();
    const rewrittenBody = rewritePlaylist(body, targetUrl);

    response.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    
    response.end(rewrittenBody);

  } catch (error) {
    sendError(
      response,
      500,
      "Proxy error: " + (error instanceof Error ? error.message : String(error))
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Layero PeersTV Proxy listening on ${PORT}`);
});
