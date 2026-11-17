const http = require('node:http');

const serverName = 'driver-server-3';
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');

  if (request.url === '/healthz') {
    response.writeHead(200);
    response.end(JSON.stringify({ status: 'ok', server: serverName }));
    return;
  }

  if (request.url.startsWith('/api/drivers')) {
    response.writeHead(200);
    response.end(JSON.stringify({
      status: 'ok',
      server: serverName,
      method: request.method,
      path: request.url,
    }));
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ status: 'not_found', server: serverName }));
});

server.listen(port, host, () => {
  console.log(`[${serverName}] listening on ${host}:${port}`);
});
