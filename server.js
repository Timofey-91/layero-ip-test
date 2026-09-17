import http from "node:http";

const server = http.createServer(async (req, res) => {
  try {
    const r = await fetch("https://ipinfo.io/json");
    const data = await r.json();

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });

    res.end(JSON.stringify(data, null, 2));
  } catch (e) {
    res.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8"
    });

    res.end(JSON.stringify({
      error: String(e)
    }));
  }
});

const port = process.env.PORT || 3000;

server.listen(port, "0.0.0.0", () => {
  console.log(`Listening on ${port}`);
});
