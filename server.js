import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

const PRIMARY_CONFIG_URL =
  "https://raw.githubusercontent.com/Timofey-91/iptv-proxy/refs/heads/main/config.json";

const BACKUP_CONFIG_URL =
  "https://raw.githubusercontent.com/Timofey-91/iptv-proxy-2/refs/heads/main/config.json";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    // Запрещаем плееру кэшировать 302-ответ
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
  };
}

// Качаем конфиг с обходом кэша GitHub и читаем updated_at из JSON
async function fetchConfig(baseUrl) {
  const cacheBusterUrl = `${baseUrl}?t=${Date.now()}`;
  const r = await fetch(cacheBusterUrl, {
    headers: { "Cache-Control": "no-cache, no-store" },
  });

  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);

  const data = await r.json();
  const updatedTime = Number(data.updated_at) || 0;

  return { data, updatedTime };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");

    if (!path) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Smart Time-based Redirector (Node.js JSON-timestamp) Active.");
      return;
    }

    // Загружаем оба конфига параллельно
    const [primaryResult, backupResult] = await Promise.allSettled([
      fetchConfig(PRIMARY_CONFIG_URL),
      fetchConfig(BACKUP_CONFIG_URL),
    ]);

    const primary = primaryResult.status === "fulfilled" ? primaryResult.value : null;
    const backup = backupResult.status === "fulfilled" ? backupResult.value : null;

    let targetUrl = null;

    const primaryTime = primary ? primary.updatedTime : 0;
    const backupTime = backup ? backup.updatedTime : 0;

    // Сравниваем метки времени из самих файлов JSON
    if (primary && backup) {
      if (primaryTime >= backupTime) {
        // Конфиг 1 свежее
        targetUrl = primary.data[path] || backup.data[path];
      } else {
        // Конфиг 2 свежее
        targetUrl = backup.data[path] || primary.data[path];
      }
    } else if (primary) {
      targetUrl = primary.data[path];
    } else if (backup) {
      targetUrl = backup.data[path];
    }

    if (!targetUrl) {
      response.writeHead(404, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Channel not found in configs");
      return;
    }

    // Отправляем 302 Редирект на свежайшую ссылку
    response.writeHead(302, {
      ...corsHeaders(),
      "Location": targetUrl,
    });
    response.end();

  } catch (error) {
    response.writeHead(500, {
      ...corsHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Redirector error: " + error.message);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Node.js Redirector listening on ${PORT}`);
});
