import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

// ============================================================
// GITVERSE TRACE
// ============================================================

const TRACE_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/config.json";

const TRACE_CACHE_TIME = 60 * 1000;

let traceCache = null;
let traceExpiresAt = 0;

// ============================================================
// CHANNEL
// ============================================================

const CHANNEL = "tvc_plus2";

// ============================================================
// HEADERS
// ============================================================

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
    Accept: "*/*",
    "Accept-Language":
      "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    Origin: "https://limehd.tv",
    Referer: "https://limehd.tv/",
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
// GITVERSE TRACE
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
        Accept: "application/json",
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

function findChannel(value, name) {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found =
        findChannel(item, name);

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
      name.toLowerCase()
    ) {
      return item;
    }

    const found =
      findChannel(item, name);

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
  if (typeof value === "string") {
    if (
      /\.m3u8(?:\?|$)/i.test(value) &&
      !result.includes(value)
    ) {
      result.push(value);
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
// GET CURRENT MASTER URL
// ============================================================

async function getChannelUrl() {
  const trace =
    await loadTrace();

  const channelData =
    findChannel(
      trace,
      CHANNEL
    );

  if (!channelData) {
    throw new Error(
      `Channel not found: ${CHANNEL}`
    );
  }

  const urls =
    findM3u8(channelData);

  if (!urls.length) {
    throw new Error(
      `No M3U8 found for ${CHANNEL}`
    );
  }

  return urls[0];
}

// ============================================================
// FETCH UPSTREAM FOR DIAGNOSTICS
// ============================================================

async function fetchUpstream(targetUrl) {
  const response =
    await fetch(
      targetUrl,
      {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        headers: limeHeaders(),
      }
    );

  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  const text =
    await response.text();

  return {
    status: response.status,
    statusText: response.statusText,
    contentType,
    finalUrl: response.url,
    bodyLength: text.length,
    body: text,
  };
}

// ============================================================
// REWRITE ONLY FOR DIAGNOSTIC DISPLAY
// ============================================================

function makeAbsoluteUrls(
  text,
  baseUrl
) {
  let base;

  try {
    base = new URL(baseUrl);
  } catch {
    return text;
  }

  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed =
        line.trim();

      if (!trimmed) {
        return line;
      }

      if (
        trimmed.startsWith("#") &&
        trimmed.includes('URI="')
      ) {
        return line.replace(
          /URI="([^"]+)"/g,
          (match, uri) => {
            try {
              return `URI="${new URL(
                uri,
                base
              ).toString()}"`;
            } catch {
              return match;
            }
          }
        );
      }

      if (
        !trimmed.startsWith("#")
      ) {
        try {
          return new URL(
            trimmed,
            base
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
// JSON RESPONSE
// ============================================================

function sendJson(
  response,
  status,
  data
) {
  const body =
    JSON.stringify(
      data,
      null,
      2
    );

  response.writeHead(
    status,
    {
      ...corsHeaders(),
      "Content-Type":
        "application/json; charset=utf-8",
      "Cache-Control":
        "no-store",
    }
  );

  response.end(body);
}

// ============================================================
// TEXT RESPONSE
// ============================================================

function sendText(
  response,
  status,
  body,
  contentType =
    "text/plain; charset=utf-8"
) {
  response.writeHead(
    status,
    {
      ...corsHeaders(),
      "Content-Type":
        contentType,
      "Cache-Control":
        "no-store",
    }
  );

  response.end(body);
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

        // ==================================================
        // OPTIONS
        // ==================================================

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

        // ==================================================
        // METHODS
        // ==================================================

        if (
          request.method !== "GET" &&
          request.method !== "HEAD"
        ) {
          sendText(
            response,
            405,
            "Method Not Allowed"
          );

          return;
        }

        // ==================================================
        // ROOT
        // ==================================================

        if (
          url.pathname === "/"
        ) {
          sendText(
            response,
            200,
            [
              "Layero LimeHD diagnostic",
              "",
              "Endpoints:",
              "/ip",
              "/tvc_plus2",
              "/inspect?url=...",
              "",
              `Source: ${TRACE_URL}`,
            ].join("\n")
          );

          return;
        }

        // ==================================================
        // IP
        // ==================================================

        if (
          url.pathname === "/ip"
        ) {
          try {
            const ipResponse =
              await fetch(
                "https://ipinfo.io/json",
                {
                  headers: {
                    Accept:
                      "application/json",
                    "User-Agent":
                      USER_AGENT,
                  },
                }
              );

            const data =
              await ipResponse.json();

            sendJson(
              response,
              ipResponse.status,
              data
            );
          } catch (error) {
            sendJson(
              response,
              502,
              {
                error:
                  String(error),
              }
            );
          }

          return;
        }

        // ==================================================
        // TVC_PLUS2
        // ==================================================

        if (
          url.pathname ===
          "/tvc_plus2"
        ) {
          try {
            const targetUrl =
              await getChannelUrl();

            const upstream =
              await fetchUpstream(
                targetUrl
              );

            const isM3u8 =
              upstream.body.includes(
                "#EXTM3U"
              );

            const hasBanner =
              /banner_400|lock\/banner/i.test(
                upstream.body
              );

            const result = {
              ok:
                upstream.status >= 200 &&
                upstream.status < 300,

              channel:
                CHANNEL,

              targetUrl,

              upstream: {
                status:
                  upstream.status,

                statusText:
                  upstream.statusText,

                contentType:
                  upstream.contentType,

                finalUrl:
                  upstream.finalUrl,

                bodyLength:
                  upstream.bodyLength,

                isM3u8,

                possibleBanner:
                  hasBanner,
              },

              playlist:
                isM3u8
                  ? makeAbsoluteUrls(
                      upstream.body,
                      targetUrl
                    )
                  : upstream.body.substring(
                      0,
                      5000
                    ),
            };

            sendJson(
              response,
              upstream.status,
              result
            );

          } catch (error) {
            sendJson(
              response,
              502,
              {
                ok: false,
                error:
                  error instanceof Error
                    ? error.message
                    : String(error),
              }
            );
          }

          return;
        }

        // ==================================================
        // INSPECT
        // ==================================================

        if (
          url.pathname ===
          "/inspect"
        ) {
          const targetUrl =
            url.searchParams.get(
              "url"
            );

          if (!targetUrl) {
            sendJson(
              response,
              400,
              {
                error:
                  "Missing url parameter",
              }
            );

            return;
          }

          let parsed;

          try {
            parsed =
              new URL(
                targetUrl
              );
          } catch {
            sendJson(
              response,
              400,
              {
                error:
                  "Invalid URL",
              }
            );

            return;
          }

          // Только диагностируем HTTPS
          // upstream, без произвольного
          // проксирования.

          if (
            parsed.protocol !==
            "https:"
          ) {
            sendJson(
              response,
              400,
              {
                error:
                  "Only HTTPS URLs are allowed",
              }
            );

            return;
          }

          try {
            const upstream =
              await fetchUpstream(
                targetUrl
              );

            const isM3u8 =
              upstream.body.includes(
                "#EXTM3U"
              );

            sendJson(
              response,
              200,
              {
                requestedUrl:
                  targetUrl,

                status:
                  upstream.status,

                statusText:
                  upstream.statusText,

                contentType:
                  upstream.contentType,

                finalUrl:
                  upstream.finalUrl,

                bodyLength:
                  upstream.bodyLength,

                isM3u8,

                possibleBanner:
                  /banner_400|lock\/banner/i.test(
                    upstream.body
                  ),

                preview:
                  upstream.body.substring(
                    0,
                    5000
                  ),

                absolutePlaylist:
                  isM3u8
                    ? makeAbsoluteUrls(
                        upstream.body,
                        targetUrl
                      )
                    : null,
              }
            );

          } catch (error) {
            sendJson(
              response,
              502,
              {
                error:
                  error instanceof Error
                    ? error.message
                    : String(error),
              }
            );
          }

          return;
        }

        // ==================================================
        // NOT FOUND
        // ==================================================

        sendJson(
          response,
          404,
          {
            error:
              "Not found",

            available: [
              "/",
              "/ip",
              "/tvc_plus2",
              "/inspect?url=...",
            ],
          }
        );

      } catch (error) {

        sendJson(
          response,
          500,
          {
            error:
              error instanceof Error
                ? error.message
                : String(error),
          }
        );
      }
    }
  );

// ============================================================
// LISTEN
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Layero LimeHD diagnostic listening on ${PORT}`
    );
  }
);
