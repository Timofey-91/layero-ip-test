import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;

// ==========================================
// 1. ОБРАБОТЧИК И СОРТИРОВКА ВИТРИНЫ (1080p)
// ==========================================
function rewriteVitrinaPlaylist(m3u8Text, targetUrl) {
  let baseUrl;
  try {
    baseUrl = new URL(targetUrl);
  } catch {
    return m3u8Text;
  }

  // Если это Мастер-плейлист с выбором вариантов разрешения (#EXT-X-STREAM-INF)
  if (m3u8Text.includes("#EXT-X-STREAM-INF")) {
    const lines = m3u8Text.split(/\r?\n/);
    const variants = [];
    let currentHeader = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith("#EXT-X-STREAM-INF")) {
        currentHeader = line;
      } else if (currentHeader && !line.startsWith("#")) {
        let absoluteUrl = line;
        try {
          absoluteUrl = new URL(line, baseUrl).toString();
        } catch {}

        // Извлекаем BANDWIDTH для точной сортировки качества
        const bwMatch = currentHeader.match(/BANDWIDTH=(\d+)/);
        const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

        variants.push({
          header: currentHeader.replace(/URI="([^"]+)"/g, (m, uri) => {
            try {
              return `URI="${new URL(uri, baseUrl).toString()}"`;
            } catch {
              return m;
            }
          }),
          url: absoluteUrl,
          bandwidth: bandwidth,
        });
        currentHeader = null;
      }
    }

    if (variants.length > 0) {
      // Сортируем: максимальный битрейт (1080p) идёт ПЕРВЫМ
      variants.sort((a, b) => b.bandwidth - a.bandwidth);

      let result = "#EXTM3U\n";
      // Сохраняем субтитры или системные теги media из начала оригинального файла
      const mediaTags = lines.filter(l => l.startsWith("#EXT-X-MEDIA:"));
      for (const tag of mediaTags) {
        const rewrittenTag = tag.replace(/URI="([^"]+)"/g, (m, uri) => {
          try {
            return `URI="${new URL(uri, baseUrl).toString()}"`;
          } catch {
            return m;
          }
        });
        result += `${rewrittenTag}\n`;
      }

      // Выводим отсортированные видеодорожки
      for (const v of variants) {
        result += `${v.header}\n${v.url}\n`;
      }
      return result;
    }
  }

  // Обычная резолюция ссылок для вложенных плейлистов/дорожек
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

// ==========================================
// 2. ОСНОВНОЙ HTTP СЕРВЕР (Unified Router)
// ==========================================
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  // Health Check
  if (pathname === "/" || pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("OK");
  }

  // Пример обработчика вызова каналов Витрины
  // (Замените на вашу внутреннюю карту маршрутизации каналов Vitrina / Lime / Wink)
  if (pathname.startsWith("/vitrina/")) {
    const channelId = pathname.replace("/vitrina/", "");
    
    try {
      // 1. Получаем оригинальный M3U8 от Витрины (пример вызова источника)
      const targetM3u8Url = `https://cdn.vitrina.tv/hls/${channelId}/master.m3u8`; // Укажите реальный генератор URL Витрины
      const response = await fetch(targetM3u8Url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (!response.ok) {
        res.writeHead(response.status);
        return res.end("Error fetching Vitrina stream");
      }

      const rawM3u8 = await response.text();

      // 2. Переписываем плейлист с сортировкой 1080p НАВЕРХ
      const sortedM3u8 = rewriteVitrinaPlaylist(rawM3u8, targetM3u8Url);

      // 3. Отдаем текстовый плейлист плееру
      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache"
      });
      return res.end(sortedM3u8);

    } catch (err) {
      res.writeHead(500);
      return res.end(`Vitrina error: ${err.message}`);
    }
  }

  // Заглушка для прочих маршрутов
  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`All-in-One Proxy with 1080p Vitrina sorting listening on port ${PORT}`);
});
