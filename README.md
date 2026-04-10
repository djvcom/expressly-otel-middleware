# expressly-otel-middleware

OpenTelemetry tracing and metrics middleware for [Fastly Compute](https://www.fastly.com/products/compute) applications using [`@fastly/expressly`](https://github.com/fastly/expressly).

Captures HTTP server spans with [OTel semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/), propagates W3C trace context, instruments backend fetch calls, and records request duration metrics.

## Features

- HTTP server span per request with semantic convention attributes
- W3C `traceparent` context propagation (incoming and outgoing)
- Automatic `http.route` capture via `TracedRouter` (prevents span cardinality explosion)
- Backend fetch instrumentation (including AWS SDK calls)
- Request duration histogram and active request counter metrics
- Configurable path exclusions, custom attributes, and sampling
- Error middleware with exception recording and typed `error.type` attributes

## Quick Start

```typescript
import './telemetry.js'; // must be imported first — see initTelemetry below

import { allowDynamicBackends } from 'fastly:experimental';
import {
  createTracedRouter,
  createTracingMiddleware,
  createMetricsMiddleware,
  createErrorMiddleware,
} from 'expressly-otel-middleware';

allowDynamicBackends(true);

const router = createTracedRouter();

router.use(createTracingMiddleware());
router.use(createMetricsMiddleware());

router.get('/api/users/:id', async (req, res) => {
  const user = await fetchUser(req.params.id);
  return res.json(user);
});

router.use(createErrorMiddleware());
router.listen();
```

Where `telemetry.ts` sets up the SDK:

```typescript
import { initTelemetry } from 'expressly-otel-middleware';

await initTelemetry({
  serviceName: 'my-edge-app',
  collectorBackend: 'otlp-collector',
});
```

## Configuration

### `initTelemetry(config)`

| Option | Type | Required | Description |
|---|---|---|---|
| `serviceName` | `string` | Yes | Service name in traces and metrics |
| `collectorBackend` | `string` | Yes | Fastly backend name for the OTLP collector |
| `sampler` | `Sampler` | No | Trace sampler (Fastly SDK defaults to AlwaysOn) |
| `resourceAttributes` | `Record<string, string>` | No | Extra resource attributes |
| `instrumentations` | `object[]` | No | Extra OTel instrumentations |
| `backendFetchAttributes` | `Function` | No | Callback to add attributes to backend fetch spans |
| `metrics` | `MetricsConfig` | No | Metrics config (omit to disable) |

### `createTracingMiddleware(config?)`

| Option | Type | Description |
|---|---|---|
| `ignorePaths` | `string[]` | Paths to skip tracing for (e.g. `/health`) |
| `additionalAttributes` | `SpanAttributes` | Static attributes added to every span |
| `requestAttributes` | `(req: ERequest) => SpanAttributes` | Dynamic attributes extracted per request |

## TracedRouter

`createTracedRouter()` wraps `@fastly/expressly`'s `Router` to capture the matched route pattern (e.g. `/user/:id` rather than `/user/123`). This sets the `http.route` attribute and updates the span name, preventing cardinality explosion in trace backends.

Use `createTracedRouter()` as a drop-in replacement for `new Router()` — the API is identical.

## Metrics

When `metrics` is provided to `initTelemetry`, the metrics middleware records:

- `http.server.request.duration` — histogram in seconds
- `http.server.active_requests` — up/down counter of in-flight requests

Both include `http.request.method`, `http.response.status_code`, and `http.route` (when using `TracedRouter`) as attributes.

## Compatibility

- `@fastly/expressly` ^2.4.0
- `@fastly/js-compute` ^3.41.1
- `@fastly/compute-js-opentelemetry` ^0.4.4
- `@opentelemetry/api` ^1.9.0

## Local Development

```shell
# Install dependencies
yarn

# Type check
yarn typecheck

# Lint
yarn lint

# Run tests
yarn test

# Run the example app locally
cd examples/basic
fastly compute serve
```

## Licence

[MIT](./LICENSE)
