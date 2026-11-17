const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream');

const DEFAULT_SERVICE_URI = 'api://drivers-server';
const DEFAULT_PORT = 3000;
const DEFAULT_REFRESH_MS = 5000;
const DEFAULT_HEALTH_PATH = '/healthz';

function parseServiceUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid driver service URI: ${value}`);
  }

  if (!['api:', 'http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error(`Unsupported driver service URI: ${value}`);
  }

  return {
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    protocol: url.protocol === 'https:' ? 'https:' : 'http:',
    basePath: url.pathname.replace(/\/+$/, ''),
  };
}

class RoundRobinPool {
  constructor() {
    this.addresses = [];
    this.healthyAddresses = [];
    this.nextIndex = 0;
  }

  update(addresses) {
    const unique = [...new Map(addresses.map((address) => [
      `${address.address}:${address.family}`,
      address,
    ])).values()];
    this.addresses = unique;
    this.healthyAddresses = unique;
    this.nextIndex = unique.length === 0 ? 0 : this.nextIndex % unique.length;
  }

  setHealthy(addresses) {
    const healthyKeys = new Set(addresses.map((address) => `${address.address}:${address.family}`));
    this.healthyAddresses = this.addresses.filter((address) =>
      healthyKeys.has(`${address.address}:${address.family}`));
    this.nextIndex = this.healthyAddresses.length === 0
      ? 0
      : this.nextIndex % this.healthyAddresses.length;
  }

  next() {
    if (this.healthyAddresses.length === 0) return null;
    const address = this.healthyAddresses[this.nextIndex];
    this.nextIndex = (this.nextIndex + 1) % this.healthyAddresses.length;
    return address;
  }

  size() {
    return this.addresses.length;
  }

  healthySize() {
    return this.healthyAddresses.length;
  }
}

async function discoverAddresses(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function createGateway({ serviceUri = DEFAULT_SERVICE_URI, port = DEFAULT_PORT,
  refreshMs = DEFAULT_REFRESH_MS, resolver = discoverAddresses,
  healthPath = DEFAULT_HEALTH_PATH, logger = console } = {}) {
  const service = parseServiceUri(serviceUri);
  if (!healthPath.startsWith('/') || healthPath.startsWith('//')) {
    throw new Error('Driver health path must be an absolute path');
  }
  const pool = new RoundRobinPool();
  let refreshInProgress = false;

  function checkBackend(address) {
    const transport = service.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const request = transport.request({
        protocol: service.protocol,
        hostname: address.address,
        family: address.family,
        port: service.port,
        method: 'GET',
        path: `${service.basePath}${healthPath}`,
        headers: { host: service.hostname },
        servername: service.protocol === 'https:' ? service.hostname : undefined,
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < 2048) body += chunk.slice(0, 2048 - body.length);
        });
        response.on('end', () => {
          const httpStatus = response.statusCode || 502;
          resolve({
            address: address.address,
            status: httpStatus >= 200 && httpStatus < 300 ? 'healthy' : 'unhealthy',
            httpStatus,
            latencyMs: Date.now() - startedAt,
            response: body,
          });
        });
      });

      request.setTimeout(3000, () => request.destroy(new Error('Health check timed out')));
      request.on('error', (error) => resolve({
        address: address.address,
        status: 'unhealthy',
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        error: error.message,
      }));
      request.end();
    });
  }

  async function checkAllBackends() {
    const results = await Promise.all(pool.addresses.map(checkBackend));
    pool.setHealthy(results
      .filter((result) => result.status === 'healthy')
      .map((result) => pool.addresses.find((address) => address.address === result.address)));
    return results;
  }

  async function refreshPool() {
    if (refreshInProgress) return;
    refreshInProgress = true;
    try {
      const addresses = await resolver(service.hostname);
      pool.update(addresses);
      pool.setHealthy([]);
      logger.info(`[gateway] discovered ${pool.size()} driver instance(s)`);
      await checkAllBackends();
    } catch (error) {
      logger.error(`[gateway] driver service discovery failed: ${error.message}`);
    } finally {
      refreshInProgress = false;
    }
  }

  const server = http.createServer((request, response) => {
    if (request.url === '/healthz') {
      const healthy = pool.healthySize() > 0;
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: healthy ? 'ok' : 'unavailable',
        service: service.hostname,
        instances: pool.size(),
        healthyInstances: pool.healthySize(),
      }));
      return;
    }

    if (request.url === '/status') {
      checkAllBackends().then((instances) => {
        const healthyInstances = instances.filter((instance) => instance.status === 'healthy').length;
        const status = healthyInstances === 0
          ? 'unavailable'
          : healthyInstances === instances.length ? 'ok' : 'degraded';
        response.writeHead(healthyInstances > 0 ? 200 : 503, {
          'content-type': 'application/json',
        });
        response.end(JSON.stringify({
          status,
          service: service.hostname,
          instances,
          healthyInstances,
          totalInstances: instances.length,
        }));
      }).catch((error) => {
        logger.error(`[gateway] status check failed: ${error.message}`);
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'error', error: 'Driver status check failed' }));
      });
      return;
    }

    const address = pool.next();
    if (!address) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Driver service has no discovered instances' }));
      return;
    }

    const transport = service.protocol === 'https:' ? https : http;
    const upstreamPath = `${service.basePath}${request.url || '/'}`;
    const upstream = transport.request({
      protocol: service.protocol,
      hostname: address.address,
      family: address.family,
      port: service.port,
      method: request.method,
      path: upstreamPath,
      headers: {
        ...request.headers,
        host: service.hostname,
        'x-forwarded-host': request.headers.host || '',
        'x-forwarded-proto': 'http',
        'x-forwarded-for': [
          request.headers['x-forwarded-for'],
          request.socket.remoteAddress,
        ].filter(Boolean).join(', '),
      },
      servername: service.protocol === 'https:' ? service.hostname : undefined,
    }, (upstreamResponse) => {
      logger.info(`[gateway] ${request.method} ${request.url} -> ${address.address}`);
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      pipeline(upstreamResponse, response, (error) => {
        if (error) logger.error(`[gateway] response forwarding failed: ${error.message}`);
      });
    });

    upstream.setTimeout(30000, () => {
      upstream.destroy(new Error('Driver service request timed out'));
    });
    upstream.on('error', (error) => {
      logger.error(`[gateway] driver request failed: ${error.message}`);
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Driver service request failed' }));
      } else {
        response.destroy(error);
      }
    });
    pipeline(request, upstream, (error) => {
      if (error && !upstream.destroyed) upstream.destroy(error);
    });
  });

  let refreshTimer;
  return {
    server,
    async start() {
      await refreshPool();
      refreshTimer = setInterval(refreshPool, refreshMs);
      refreshTimer.unref();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      logger.info(`[gateway] listening on 0.0.0.0:${server.address().port}`);
    },
    async close() {
      clearInterval(refreshTimer);
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    },
    pool,
  };
}

if (require.main === module) {
  const gateway = createGateway({
    serviceUri: process.env.DRIVERS_SERVICE_URI || DEFAULT_SERVICE_URI,
    port: Number(process.env.PORT) || DEFAULT_PORT,
    refreshMs: Number(process.env.DNS_REFRESH_MS) || DEFAULT_REFRESH_MS,
    healthPath: process.env.DRIVER_HEALTH_PATH || DEFAULT_HEALTH_PATH,
  });

  gateway.start().catch((error) => {
    console.error(`[gateway] startup failed: ${error.message}`);
    process.exitCode = 1;
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      gateway.close().then(() => process.exit(0)).catch((error) => {
        console.error(`[gateway] shutdown failed: ${error.message}`);
        process.exitCode = 1;
      });
    });
  }
}

module.exports = { createGateway, discoverAddresses, parseServiceUri, RoundRobinPool };
