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
  };
}

function sendError(response, status, message) {
  response.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(message);
}

async function fetchConfig(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
  return await r.json();
}

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

    const path = url.pathname.replace(/^\/+/, "").replace(/\.m3u8$/i, "");

    if (!path) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("PeersTV Redirector is working.");
      return;
    }

    let targetUrl = null;

    // 1. Пробуем получить ссылку из основного конфига с GitHub
    try {
      const config = await fetchConfig(PRIMARY_CONFIG_URL);
      if (path in config) {
        targetUrl = config[path];
      }
    } catch (e) {
      console.log("Основной конфиг не ответил, используем резервный...");
    }

    // 2. Если в основном нет канала или GitHub сбойнул — берем резервный
    if (!targetUrl) {
      try {
        const backupConfig = await fetchConfig(BACKUP_CONFIG_URL);
        if (backupConfig && path in backupConfig) {
          targetUrl = backupConfig[path];
        }
      } catch (backupErr) {
        console.log("Резервный конфиг недоступен");
      }
    }

    if (!targetUrl) {
      return sendError(response, 404, "Channel not found in configs");
    }

    // 3. Отправляем 302 Перенаправление на ваш домашний плеер
    response.writeHead(302, {
      ...corsHeaders(),
      "Location": targetUrl,
    });
    response.end();

  } catch (error) {
    sendError(response, 500, "Redirector error: " + error.message);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Layero Redirector listening on ${PORT}`);
});
