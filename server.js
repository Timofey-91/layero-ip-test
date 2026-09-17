import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

const TRACE_URL =
  "https://gitverse.ru/api/repos/Timofey91/peer_test/raw/branch/master/tvc_trace.json";

const CHANNEL_KEY = "tvc_plus2";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/153.0.0.0 Safari/537.36";

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  res.end(body);
}

function safeUrl(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    const u = new URL(value);

    return {
      full: value,
      protocol: u.protocol,
      host: u.host,
      pathname: u.pathname,
      search: u.search,
    };
  } catch {
    return null;
  }
}

function findUrls(value, result = []) {
  if (typeof value === "string") {
    const matches = value.match(/https?:\/\/[^\s"'<>]+/g);

    if (matches) {
      for (const url of matches) {
        if (!result.includes(url)) {
          result.push(url);
        }
      }
    }

    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findUrls(item, result);
    }

    return result;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      findUrls(item, result);
    }
  }

  return result;
}

async function getTrace() {
  const started = Date.now();

  const response = await fetch(TRACE_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": UA,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitVerse returned HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("GitVerse response is not valid JSON");
  }

  return {
    json,
    status: response.status,
    elapsed: `${Date.now() - started} ms`,
    bodyLength: text.length,
  };
}

function findChannel(trace) {
  /*
   * Сначала пытаемся найти объект tvc_plus2
   * по ключу в любом месте JSON.
   */

  function recursive(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = recursive(item);

        if (found) {
          return found;
        }
      }

      return null;
    }

    if (Object.prototype.hasOwnProperty.call(value, CHANNEL_KEY)) {
      return value[CHANNEL_KEY];
    }

    for (const [key, item] of Object.entries(value)) {
      if (
        key.toLowerCase() === CHANNEL_KEY.toLowerCase()
      ) {
        return item;
      }

      const found = recursive(item);

      if (found) {
        return found;
      }
    }

    return null;
  }

  return recursive(trace);
}

function collectStreamUrls(channelData) {
  const allUrls = findUrls(channelData);

  const m3u8 = allUrls.filter((url) =>
    /\.m3u8(?:\?|$)/i.test(url)
  );

  const tvc = allUrls.filter((url) =>
    /tvc|tvcplus2/i.test(url)
  );

  return {
    all: [...new Set(allUrls)],
    m3u8: [...new Set(m3u8)],
    tvc: [...new Set(tvc)],
  };
}

async function loadChannel() {
  const trace = await getTrace();

  const channel = findChannel(trace.json);

  if (!channel) {
    return {
      ok: false,
      error: `Channel ${CHANNEL_KEY} was not found`,
      trace: {
        status: trace.status,
        elapsed: trace.elapsed,
        bodyLength: trace.bodyLength,
      },
      topLevelKeys:
        trace.json && typeof trace.json === "object"
          ? Object.keys(trace.json)
          : [],
    };
  }

  const urls = collectStreamUrls(channel);

  return {
    ok: true,

    source: {
      type: "GitVerse",
      url: TRACE_URL,
      status: trace.status,
      elapsed: trace.elapsed,
      bodyLength: trace.bodyLength,
    },

    channel: CHANNEL_KEY,

    urls: {
      total: urls.all.length,
      m3u8: urls.m3u8.map(safeUrl).filter(Boolean),
      tvc: urls.tvc.map(safeUrl).filter(Boolean),
      all: urls.all.map(safeUrl).filter(Boolean),
    },

    rawChannel: channel,
  };
}

async function getPublicIp() {
  try {
    const response = await fetch("https://ipinfo.io/json", {
      headers: {
        Accept: "application/json",
        "User-Agent": UA,
      },
    });

    return await response.json();
  } catch (error) {
    return {
      error: String(error),
    };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  // Главная
  if (url.pathname === "/") {
    return sendJson(res, 200, {
      service: "Layero GitVerse TVC resolver",
      channel: CHANNEL_KEY,

      endpoints: {
        root: "/",
        trace: "/trace",
        channel: "/tvc_plus2",
        ip: "/ip",
      },

      source: TRACE_URL,
    });
  }

  // Проверка IP самого Layero
  if (url.pathname === "/ip") {
    const ip = await getPublicIp();

    return sendJson(res, 200, {
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },

      outboundIp: ip,
    });
  }

  // Отдать сам trace
  if (url.pathname === "/trace") {
    try {
      const trace = await getTrace();

      return sendJson(res, 200, {
        source: TRACE_URL,
        status: trace.status,
        elapsed: trace.elapsed,
        bodyLength: trace.bodyLength,
        data: trace.json,
      });
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        error: String(error),
        source: TRACE_URL,
      });
    }
  }

  // Найти tvc_plus2
  if (url.pathname === "/tvc_plus2") {
    try {
      const result = await loadChannel();

      return sendJson(
        res,
        result.ok ? 200 : 404,
        result
      );
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        error: String(error),
        source: TRACE_URL,
      });
    }
  }

  return sendJson(res, 404, {
    error: "Not found",
    available: [
      "/",
      "/ip",
      "/trace",
      "/tvc_plus2",
    ],
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Layero GitVerse TVC resolver listening on ${PORT}`
  );
});
