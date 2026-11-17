const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway, parseServiceUri, RoundRobinPool } = require('../src/gateway');

test('api service URIs resolve to HTTP DNS service names', () => {
  assert.deepEqual(parseServiceUri('api://drivers-server'), {
    hostname: 'drivers-server',
    port: 80,
    protocol: 'http:',
    basePath: '',
  });
});

test('service URI paths and HTTPS defaults are preserved', () => {
  assert.deepEqual(parseServiceUri('https://drivers.internal/api'), {
    hostname: 'drivers.internal',
    port: 443,
    protocol: 'https:',
    basePath: '/api',
  });
});

test('round-robin pool cycles through discovered addresses and deduplicates them', () => {
  const pool = new RoundRobinPool();
  const first = { address: '10.0.0.1', family: 4 };
  const second = { address: '10.0.0.2', family: 4 };
  pool.update([first, second, first]);

  assert.equal(pool.size(), 2);
  assert.deepEqual([pool.next(), pool.next(), pool.next()], [first, second, first]);
});

test('round-robin pool remains empty when service discovery has no addresses', () => {
  const pool = new RoundRobinPool();
  pool.update([]);

  assert.equal(pool.size(), 0);
  assert.equal(pool.next(), null);
});

test('empty service discovery removes previously discovered instances', () => {
  const pool = new RoundRobinPool();
  pool.update([{ address: '10.0.0.1', family: 4 }]);
  pool.update([]);

  assert.equal(pool.size(), 0);
});

test('gateway forwards GET requests and reports discovery health', async (context) => {
  const driver = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      backend: request.socket.localAddress,
      method: request.method,
      url: request.url,
    }));
  });
  await new Promise((resolve) => driver.listen(0, '0.0.0.0', resolve));
  context.after(() => new Promise((resolve) => driver.close(resolve)));

  const backends = ['127.0.0.1', '127.0.0.2', '127.0.0.3'];
  const gateway = createGateway({
    serviceUri: `api://drivers-server:${driver.address().port}`,
    port: 0,
    resolver: async () => backends.map((address) => ({ address, family: 4 })),
    logger: { info() {}, error() {} },
  });
  await gateway.start();
  context.after(() => gateway.close());

  const baseUrl = `http://127.0.0.1:${gateway.server.address().port}`;
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: 'ok',
    service: 'drivers-server',
    instances: 3,
    healthyInstances: 3,
  });

  const statusResponse = await fetch(`${baseUrl}/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.status, 'ok');
  assert.equal(status.healthyInstances, 3);
  assert.deepEqual(status.instances.map((instance) => instance.status), [
    'healthy',
    'healthy',
    'healthy',
  ]);
  assert.ok(status.instances.every((instance) => instance.httpStatus === 200));

  const responses = [];
  for (let index = 0; index < backends.length; index += 1) {
    const response = await fetch(`${baseUrl}/api/drivers?active=true`);
    responses.push(await response.json());
  }
  assert.deepEqual(responses.map((response) => response.backend), backends);
  assert.ok(responses.every((response) => response.url === '/api/drivers?active=true'));
});

test('gateway reports unhealthy driver responses and does not route to them', async (context) => {
  const driver = http.createServer((request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('maintenance');
  });
  await new Promise((resolve) => driver.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => driver.close(resolve)));

  const gateway = createGateway({
    serviceUri: `api://drivers-server:${driver.address().port}`,
    port: 0,
    resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    logger: { info() {}, error() {} },
  });
  await gateway.start();
  context.after(() => gateway.close());

  const baseUrl = `http://127.0.0.1:${gateway.server.address().port}`;
  const response = await fetch(`${baseUrl}/status`);
  assert.equal(response.status, 503);
  const status = await response.json();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.instances[0].status, 'unhealthy');
  assert.equal(status.instances[0].httpStatus, 503);
  assert.equal(status.instances[0].response, 'maintenance');

  const unavailable = await fetch(`${baseUrl}/api/drivers`);
  assert.equal(unavailable.status, 503);
});
