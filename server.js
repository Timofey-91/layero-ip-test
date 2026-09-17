import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

// ======================================================
// GITVERSE TRACE CONFIG
// ======================================================

const TRACE_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/config.json";

const TRACE_CACHE_TIME = 60 * 1000;

let traceCache = null;
let traceExpiresAt = 0;


// ======================================================
// LIMEHD HEADERS
// ======================================================

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/153.0.0.0 Safari/537.36";

const DEVICE_ID =
  "576590.7544992064-1789471762048";

const LHD_AGENT = JSON.stringify({
  platform: "web",
  app: "limehd.tv",
  device_id: DEVICE_ID,
});

function limeHeaders() {
  return {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": "https://limehd.tv",
    "Referer": "https://limehd.tv/",
    "X-Device-ID": DEVICE_ID,
    "X-LHD-Agent": LHD_AGENT,
  };
}


// ======================================================
// CORS
// ======================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}


// ======================================================
// RESPONSE ERROR HELPER
// ======================================================

function sendError(response, status, message) {
  response.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(message);
}


// ======================================================
// LOAD TRACE CONFIG
// ======================================================

async function loadTrace() {
  const now = Date.now();

  if (traceCache && now < traceExpiresAt) {
    return traceCache;
  }

  const response = await fetch(TRACE_URL, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`GitVerse trace HTTP ${response.status}`);
  }

  const trace = await response.json();

  if (!trace || typeof trace !== "object") {
    throw new Error("Invalid tvc_trace.json");
  }

  traceCache = trace;
  traceExpiresAt = now + TRACE_CACHE_TIME;

  return trace;
}


// ============================================================
// FIND CHANNEL
// ============================================================

function findChannel(value, name) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findChannel(item, name);
      if (found) return found;
    }
    return null;
  }

  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return item;
    }

    const found = findChannel(item, name);
    if (found) return found;
  }

  return null;
}


// ============================================================
// FIND M3U8
// ============================================================

function findM3u8(value, result = []) {
  if (typeof value === "string") {
    if (/\.m3u8(?:\?|$)/i.test(value) && !result.includes(value)) {
      result.push(value);
    }
    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) findM3u8(item, result);
    return result;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) findM3u8(item, result);
  }

  return result;
}


// ============================================================
// GET CURRENT MASTER URL
// ============================================================

async function getChannelUrl(channelName) {
  const trace = await loadTrace();

  const channelData = findChannel(trace, channelName);

  if (!channelData) {
    throw new Error(`Channel not found: ${channelName}`);
  }

  const urls = findM3u8(channelData);

  if (!urls.length) {
    throw new Error(`No M3U8 found for ${channelName}`);
  }

  return urls[0];
}


// ======================================================
// REWRITE M3U8
// ======================================================

function rewritePlaylist(text, targetUrl) {
  let baseUrl;

  try {
    baseUrl = new URL(targetUrl);
  } catch {
    return text;
  }

  const lines = text.split(/\r?\n/);

  return lines.map(line => {
    const trimmed = line.trim();

    if (!trimmed) {
      return line;
    }

    // ----------------------------------------------
    // URI="..."
    // ----------------------------------------------
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

    // ----------------------------------------------
    // обычные URL / relative URL
    // ----------------------------------------------
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
// PLAYLIST FETCH
// ======================================================

async function fetchPlaylist(targetUrl, serverResponse) {
  let response;

  try {
    response = await fetch(targetUrl, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers: limeHeaders(),
    });
  } catch (error) {
    return sendError(
      serverResponse,
      502,
      "Playlist fetch error: " + (error instanceof Error ? error.message : String(error))
    );
  }

  // ====================================================
  // UPSTREAM ERROR
  // ====================================================
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {}

    return sendError(
      serverResponse,
      502,
      "LimeHD error: " + response.status + "\n\n" + body.substring(0, 1000)
    );
  }

  // ====================================================
  // READ AND REWRITE M3U8
  // ====================================================
  const text = await response.text();
  const rewritten = rewritePlaylist(text, targetUrl);

  // ====================================================
  // RETURN M3U8
  // ====================================================
  serverResponse.writeHead(200, {
    ...corsHeaders(),
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
  });
  
  serverResponse.end(rewritten);
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

    // ==================================================
    // OPTIONS
    // ==================================================
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }


    // ==================================================
    // GET / HEAD ONLY
    // ==================================================
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendError(response, 405, "Method Not Allowed");
    }


    // ==================================================
    // CHANNEL
    // ==================================================
    const channel = url.pathname
      .replace(/^\/+/, "")
      .replace(/\.m3u8$/i, "");


    // ==================================================
    // ROOT
    // ==================================================
    if (!channel) {
      const body = "Layero LimeHD Proxy is working.\n\n" +
                   "Examples:\n" +
                   "/tvc_plus2\n" +
                   "/other_channel\n";
                   
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(body);
      return;
    }


    // ==================================================
    // GET TARGET URL FROM TRACE
    // ==================================================
    let targetUrl;

    try {
      targetUrl = await getChannelUrl(channel);
    } catch (error) {
      const status = error.message.includes("not found") ? 404 : 502;
      return sendError(
        response, 
        status, 
        "Channel error: " + (error instanceof Error ? error.message : String(error))
      );
    }

    if (typeof targetUrl !== "string" || !targetUrl) {
      return sendError(response, 502, "Invalid channel URL");
    }


    // ==================================================
    // HEAD
    // ==================================================
    if (request.method === "HEAD") {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "application/vnd.apple.mpegurl",
      });
      response.end();
      return;
    }


    // ==================================================
    // FETCH PLAYLIST
    // ==================================================
    await fetchPlaylist(targetUrl, response);

  } catch (error) {
    sendError(
      response, 
      500, 
      "Proxy error: " + (error instanceof Error ? error.message : String(error))
    );
  }
});


// ============================================================
// LISTEN
// ============================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Layero LimeHD Proxy listening on ${PORT}`);
});
