# Drivers round-robin API gateway

This dependency-free Node.js gateway proxies incoming requests to the driver service. By default it uses `api://drivers-server`; the `api://` scheme is an HTTP service-discovery alias, and the hostname is resolved through DNS. For three backends, configure `drivers-server` in your service discovery/DNS to return all three server addresses. DNS is refreshed periodically, so changing the service's discovered addresses does not require editing a server list or restarting the gateway. Requests are distributed round-robin across healthy discovered addresses.

The gateway must run in a network where `drivers-server` resolves to the current driver instances (for example, a container or cluster service-discovery network). The driver instances must answer `GET /healthz` with a 2xx response to be considered healthy. A single DNS address can only provide one gateway backend; configure the service-discovery layer to return all instance addresses when gateway-level balancing is required.

## Run

Requires Docker Desktop with Docker Compose.

Start the gateway and the three separate driver servers:

```powershell
docker compose up --build
```

The three server implementations are [server-1.js](./servers/server-1.js), [server-2.js](./servers/server-2.js), and [server-3.js](./servers/server-3.js). Each responds to `GET /healthz` with its own server name and serves `GET /api/drivers`. Docker's shared `drivers-server` network alias lets the gateway discover all three instances without a hard-coded backend list. The gateway is available at `http://localhost:3000`.

Configuration:

| Variable | Default | Description |
| --- | --- | --- |
| `DRIVERS_SERVICE_URI` | `api://drivers-server` | Driver service URI (`api://`, `http://`, or `https://`) |
| `PORT` | `3000` | Gateway listen port |
| `DNS_REFRESH_MS` | `5000` | Service discovery refresh interval |
| `DRIVER_HEALTH_PATH` | `/healthz` | Driver endpoint used to check each server |

All paths, query strings, methods, and request bodies are forwarded. `GET /status` actively probes every discovered instance and returns each address, health status, HTTP status code, response body, and latency. It returns `200` when at least one instance is healthy, `503` when none are healthy, and `degraded` in the response body when only some are healthy. `GET /healthz` returns a quick gateway health summary. Requests that cannot be forwarded receive `502`; when no driver instances are healthy, normal API requests receive `503`.

## Verify from a console

With Docker Compose running, request the driver's endpoint through the gateway:

```powershell
1..6 | ForEach-Object { Invoke-RestMethod http://localhost:3000/api/drivers }
Invoke-RestMethod http://localhost:3000/status | ConvertTo-Json -Depth 5
Invoke-RestMethod http://localhost:3000/healthz
```

The first command should show responses from `driver-server-1`, `driver-server-2`, and `driver-server-3` in rotation. `/status` shows each discovered server, its health response, HTTP status, and latency. To stop the demo, run `docker compose down`.

Run the unit tests with `npm test`.
