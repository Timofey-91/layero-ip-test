import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

// ============================================================
// GITVERSE TRACE
// ============================================================

const TRACE_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/tvc_trace.json";

// ============================================================
// CACHE
// ============================================================

// GitVerse trace обновляется отдельно.
// Здесь небольшой cache, чтобы не читать JSON на каждый запрос.

const TRACE_CACHE_TIME = 60 * 1000;

let traceCache = null;
let traceExpiresAt = 0;

// ============================================================
// LIMEHD HEADERS
// ============================================================

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/153.0.0.0 Safari/537.36";

const DEVICE_ID =
  "576590.7544992064-1789471762048";

const LHD_AGENT = JSON.stringify(
  {
    platform: "web",
    app: "limehd.tv",
    device_id: DEVICE_ID,
  }
);

function limeHeaders() {
  return {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language":
      "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": "https://limehd.tv",
    "Referer": "https://limehd.tv/",
    "X-Device-ID": DEVICE_ID,
    "X-LHD-Agent": LHD_AGENT,
  };
}

// ============================================================
// CORS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

// ============================================================
// TRACE
// ============================================================

async function loadTrace() {

  const now = Date.now();

  if (
    traceCache &&
    now < traceExpiresAt
  ) {
    return traceCache;
  }

  const response = await fetch(
    TRACE_URL,
    {
      method: "GET",
      cache: "no-store",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitVerse trace HTTP ${response.status}`
    );
  }

  const trace =
    await response.json();

  if (
    !trace ||
    typeof trace !== "object"
  ) {
    throw new Error(
      "Invalid tvc_trace.json"
    );
  }

  traceCache = trace;
  traceExpiresAt =
    now + TRACE_CACHE_TIME;

  return trace;
}

// ============================================================
// FIND CHANNEL
// ============================================================

function findChannel(
  value,
  channelName
) {

  if (
    !value ||
    typeof value !== "object"
  ) {
    return null;
  }

  if (Array.isArray(value)) {

    for (const item of value) {

      const found =
        findChannel(
          item,
          channelName
        );

      if (found) {
        return found;
      }
    }

    return null;
  }

  for (
    const [key, item]
    of Object.entries(value)
  ) {

    if (
      key.toLowerCase() ===
      channelName.toLowerCase()
    ) {
      return item;
    }

    const found =
      findChannel(
        item,
        channelName
      );

    if (found) {
      return found;
    }
  }

  return null;
}

// ============================================================
// FIND M3U8
// ============================================================

function findM3u8(
  value,
  result = []
) {

  if (
    typeof value === "string"
  ) {

    if (
      /\.m3u8(?:\?|$)/i.test(value)
    ) {

      if (!result.includes(value)) {
        result.push(value);
      }
    }

    return result;
  }

  if (Array.isArray(value)) {

    for (const item of value) {
      findM3u8(item, result);
    }

    return result;
  }

  if (
    value &&
    typeof value === "object"
  ) {

    for (
      const item
      of Object.values(value)
    ) {
      findM3u8(item, result);
    }
  }

  return result;
}

// ============================================================
// GET CHANNEL URL
// ============================================================

async function getChannelUrl(
  channel
) {

  const trace =
    await loadTrace();

  const channelData =
    findChannel(
      trace,
      channel
    );

  if (!channelData) {
    throw new Error(
      `Channel not found: ${channel}`
    );
  }

  const urls =
    findM3u8(channelData);

  if (!urls.length) {
    throw new Error(
      `No M3U8 found for ${channel}`
    );
  }

  /*
   * Обычно первый найденный URL —
   * root/master playlist.
   *
   * При необходимости позже
   * сделаем выбор более точным.
   */

  return urls[0];
}

// ============================================================
// FETCH PLAYLIST
// ============================================================

async function fetchPlaylist(
  targetUrl
) {

  let response;

  try {

    response =
      await fetch(
        targetUrl,
        {
          method: "GET",
          redirect: "follow",
          cache: "no-store",
          headers: limeHeaders(),
        }
      );

  } catch (error) {

    return new Response(
      "Playlist fetch error: " +
      (
        error instanceof Error
          ? error.message
          : String(error)
      ),
      {
        status: 502,
        headers: {
          ...corsHeaders(),
          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }

  // ==========================================================
  // UPSTREAM ERROR
  // ==========================================================

  if (!response.ok) {

    let body = "";

    try {
      body =
        await response.text();
    } catch {}

    return new Response(
      "LimeHD error: " +
      response.status +
      "\n\n" +
      body.substring(0, 2000),
      {
        status: 502,
        headers: {
          ...corsHeaders(),
          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }

  // ==========================================================
  // READ PLAYLIST
  // ==========================================================

  const text =
    await response.text();

  // ==========================================================
  // CHECK BANNER
  // ==========================================================

  if (
    /banner_400|lock\/banner/i.test(
      text
    )
  ) {

    return new Response(
      "LimeHD returned lock/banner playlist.\n\n" +
      text.substring(0, 2000),
      {
        status: 502,
        headers: {
          ...corsHeaders(),
          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }

  // ==========================================================
  // CHECK M3U8
  // ==========================================================

  if (
    !text.includes("#EXTM3U")
  ) {

    return new Response(
      "Upstream response is not M3U8.\n\n" +
      text.substring(0, 2000),
      {
        status: 502,
        headers: {
          ...corsHeaders(),
          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }

  // ==========================================================
  // REWRITE URLS
  // ==========================================================

  const rewritten =
    rewritePlaylist(
      text,
      targetUrl
    );

  // ==========================================================
  // RETURN
  // ==========================================================

  return new Response(
    rewritten,
    {
      status: 200,

      headers: {
        ...corsHeaders(),

        "Content-Type":
          "application/vnd.apple.mpegurl",

        "Cache-Control":
          "no-store, no-cache, must-revalidate",

        "Pragma":
          "no-cache",
      },
    }
  );
}

// ============================================================
// REWRITE M3U8
// ============================================================

function rewritePlaylist(
  text,
  targetUrl
) {

  let baseUrl;

  try {
    baseUrl =
      new URL(targetUrl);

  } catch {
    return text;
  }

  const lines =
    text.split(/\r?\n/);

  return lines
    .map(line => {

      const trimmed =
        line.trim();

      if (!trimmed) {
        return line;
      }

      // ======================================================
      // URI="..."
      //
      // Например:
      //
      // #EXT-X-KEY:METHOD=AES-128,
      // URI="https://drm...."
      // ======================================================

      if (
        trimmed.startsWith("#") &&
        trimmed.includes('URI="')
      ) {

        return line.replace(
          /URI="([^"]+)"/g,
          (match, uri) => {

            try {

              const absolute =
                new URL(
                  uri,
                  baseUrl
                ).toString();

              return `URI="${absolute}"`;

            } catch {

              return match;
            }
          }
        );
      }

      // ======================================================
      // Обычный URL / relative URL
      // ======================================================

      if (
        !trimmed.startsWith("#")
      ) {

        try {

          return new URL(
            trimmed,
            baseUrl
          ).toString();

        } catch {

          return line;
        }
      }

      return line;

    })
    .join("\n");
}

// ============================================================
// ROOT
// ============================================================

function rootResponse() {

  return new Response(
    "Layero LimeHD TVC proxy is working.\n\n" +
    "Channel:\n" +
    "/tvc_plus2\n\n" +
    "Source:\n" +
    TRACE_URL +
    "\n",
    {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type":
          "text/plain; charset=utf-8",
      },
    }
  );
}

// ============================================================
// SERVER
// ============================================================

const server =
  http.createServer(
    async (request, response) => {

      try {

        const url =
          new URL(
            request.url,
            `http://${request.headers.host || "localhost"}`
          );

        // ====================================================
        // OPTIONS
        // ====================================================

        if (
          request.method ===
          "OPTIONS"
        ) {

          response.writeHead(
            204,
            corsHeaders()
          );

          response.end();

          return;
        }

        // ====================================================
        // GET / HEAD ONLY
        // ====================================================

        if (
          request.method !== "GET" &&
          request.method !== "HEAD"
        ) {

          response.writeHead(
            405,
            {
              ...corsHeaders(),
              "Content-Type":
                "text/plain; charset=utf-8",
            }
          );

          response.end(
            "Method Not Allowed"
          );

          return;
        }

        // ====================================================
        // ROOT
        // ====================================================

        if (
          url.pathname === "/"
        ) {

          const result =
            rootResponse();

          response.writeHead(
            result.status,
            Object.fromEntries(
              result.headers.entries()
            )
          );

          if (
            request.method ===
            "HEAD"
          ) {

            response.end();
            return;
          }

          response.end(
            await result.text()
          );

          return;
        }

        // ====================================================
        // CHANNEL
        // ====================================================

        const channel =
          url.pathname
            .replace(/^\/+/, "")
            .replace(
              /\.m3u8$/i,
              ""
            );

        if (
          channel !==
          "tvc_plus2"
        ) {

          response.writeHead(
            404,
            {
              ...corsHeaders(),
              "Content-Type":
                "text/plain; charset=utf-8",
            }
          );

          response.end(
            "Channel not found: " +
            channel
          );

          return;
        }

        // ====================================================
        // GET CURRENT URL FROM GITVERSE
        // ====================================================

        let targetUrl;

        try {

          targetUrl =
            await getChannelUrl(
              channel
            );

        } catch (error) {

          response.writeHead(
            502,
            {
              ...corsHeaders(),
              "Content-Type":
                "text/plain; charset=utf-8",
            }
          );

          response.end(
            "Config/trace error: " +
            (
              error instanceof Error
                ? error.message
                : String(error)
            )
          );

          return;
        }

        console.log(
          `[${new Date().toISOString()}] ` +
          `${channel} -> ${targetUrl}`
        );

        // ====================================================
        // HEAD
        // ====================================================

        if (
          request.method ===
          "HEAD"
        ) {

          response.writeHead(
            200,
            {
              ...corsHeaders(),
              "Content-Type":
                "application/vnd.apple.mpegurl",
            }
          );

          response.end();

          return;
        }

        // ====================================================
        // FETCH UPSTREAM
        // ====================================================

        const result =
          await fetchPlaylist(
            targetUrl
          );

        // ====================================================
        // CONVERT WEB RESPONSE → NODE RESPONSE
        // ====================================================

        const body =
          await result.arrayBuffer();

        const headers =
          Object.fromEntries(
            result.headers.entries()
          );

        response.writeHead(
          result.status,
          headers
        );

        response.end(
          Buffer.from(body)
        );

      } catch (error) {

        response.writeHead(
          502,
          {
            ...corsHeaders(),
            "Content-Type":
              "text/plain; charset=utf-8",
          }
        );

        response.end(
          "Proxy error: " +
          (
            error instanceof Error
              ? error.message
              : String(error)
          )
        );
      }
    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Layero LimeHD proxy listening on ${PORT}`
    );

  }
);
