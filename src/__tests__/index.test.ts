import assert from 'node:assert';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputeApplication } from '@fastly/compute-testing';
import { createMiddleware } from '@mswjs/http-middleware';
import express from 'express';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// OTLP JSON payload types (the @opentelemetry/otlp-transformer package
// no longer exports these, but the wire format is stable)
interface OtlpSpanAttribute {
  key: string;
  value: { stringValue?: string; intValue?: number };
}

interface OtlpSpan {
  name: string;
  kind: number;
  traceId: Uint8Array | string;
  spanId: Uint8Array | string;
  parentSpanId?: Uint8Array | string;
  attributes: OtlpSpanAttribute[];
  status: { code: number; message?: string };
}

interface OtlpTraceExport {
  resourceSpans?: {
    scopeSpans: { spans?: OtlpSpan[] }[];
  }[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = path.resolve(__dirname, '../../examples/basic');
const FASTLY_TOML_PATH = path.join(EXAMPLE_ROOT, 'fastly.toml');

function getSpanAttributes(
  span: OtlpSpan,
): Record<string, string | number | undefined> {
  return span.attributes.reduce(
    (acc: Record<string, string | number | undefined>, attr) => {
      acc[attr.key] =
        attr.value.stringValue ?? attr.value.intValue ?? undefined;
      return acc;
    },
    {},
  );
}

function getAllSpans(requests: OtlpTraceExport[]): OtlpSpan[] {
  return requests.flatMap(req => {
    const resourceSpan = req.resourceSpans?.[0];
    if (!resourceSpan) return [];
    return resourceSpan.scopeSpans.flatMap(
      (ss: { spans?: OtlpSpan[] }) => ss.spans ?? [],
    );
  });
}

function findSpan(spans: OtlpSpan[], name: string): OtlpSpan {
  const span = spans.find(s => s.name === name);
  assert(
    span,
    `Expected span "${name}" not found. Available: ${spans.map(s => s.name).join(', ')}`,
  );
  return span;
}

function writeFastlyToml(otelPort: number) {
  const toml = `
manifest_version = 3
name = "expressly-otel-example"
language = "javascript"
description = "Test fixture"

[local_server]

[local_server.backends]

[local_server.backends.otlp-collector]
  url = "http://127.0.0.1:${otelPort}"

[scripts]
  build = "yarn build"
  post_init = "yarn"
`.trimStart();
  fs.writeFileSync(FASTLY_TOML_PATH, toml);
}

function listenOnFreePort(app: express.Express): Promise<Server> {
  return new Promise<Server>(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function getPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

const SPAN_FLUSH_MS = 200;

interface DynamoDBKey {
  S?: string;
  N?: string;
}

interface DynamoDBRequest {
  TableName?: string;
  Key?: Record<string, DynamoDBKey>;
}

const app = new ComputeApplication();
const receivedTraces: OtlpTraceExport[] = [];
let originalFastlyToml: string;
let otelServer: Server;
let httpbinServer: Server;
let dynamoServer: Server;

beforeAll(async () => {
  originalFastlyToml = fs.readFileSync(FASTLY_TOML_PATH, 'utf-8');

  // Start mock OTLP collector on an OS-allocated port
  const otelApp = express();
  otelApp.use(
    createMiddleware(
      http.post(/\/v1\/traces$/, async ({ request }) => {
        const body = (await request.json()) as OtlpTraceExport;
        receivedTraces.push(body);
        return HttpResponse.json({ partialSuccess: {} });
      }),
    ),
  );
  otelServer = await listenOnFreePort(otelApp);

  // Write fastly.toml with the allocated OTLP port
  writeFastlyToml(getPort(otelServer));

  // Start mock httpbin and DynamoDB on fixed ports
  // (these are hardcoded in the example app source)
  const httpbinApp = express();
  httpbinApp.use(
    createMiddleware(
      http.get('http://localhost:9000/get', () => {
        return HttpResponse.json({ success: true });
      }),
    ),
  );

  const dynamoApp = express();
  dynamoApp.use(
    createMiddleware(
      http.post('http://localhost:8000/', async ({ request }) => {
        const body = (await request.json()) as DynamoDBRequest;

        if (body.TableName === 'users' && body.Key) {
          const userId = body.Key.id?.S;

          if (userId === 'user1') {
            return HttpResponse.json({
              Item: {
                id: { S: 'user1' },
                name: { S: 'Alice' },
              },
            });
          }

          return HttpResponse.json({});
        }

        return HttpResponse.json(
          { __type: 'InternalServerError', message: 'Unknown operation' },
          { status: 500 },
        );
      }),
    ),
  );

  httpbinServer = await new Promise<Server>(resolve => {
    const server = httpbinApp.listen(9000, '127.0.0.1', () => resolve(server));
  });

  dynamoServer = await new Promise<Server>(resolve => {
    const server = dynamoApp.listen(8000, '127.0.0.1', () => resolve(server));
  });

  await app.start({ appRoot: EXAMPLE_ROOT });
});

beforeEach(() => {
  receivedTraces.length = 0;
});

afterAll(async () => {
  await app.shutdown();
  fs.writeFileSync(FASTLY_TOML_PATH, originalFastlyToml);
  await Promise.all([
    new Promise<void>(resolve => otelServer.close(() => resolve())),
    new Promise<void>(resolve => httpbinServer.close(() => resolve())),
    new Promise<void>(resolve => dynamoServer.close(() => resolve())),
  ]);
});

describe('Basic Routing', () => {
  it('should return 200 for existing route', async () => {
    const response = await app.fetch('/');
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toBe('Hello world!');
  });

  it('should return 500 for non-existent route (caught by error middleware)', async () => {
    const response = await app.fetch('/nonexistent');
    expect(response.status).toBe(500);
  });
});

describe('Tracing Middleware', () => {
  it('should create HTTP server spans with semantic conventions', async () => {
    const response = await app.fetch('/');
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    expect(receivedTraces.length).toBeGreaterThan(0);

    const allSpans = getAllSpans(receivedTraces);
    const httpSpan = findSpan(allSpans, 'GET /');

    expect(httpSpan.kind).toBe(2);

    const attributes = getSpanAttributes(httpSpan);

    expect(attributes['http.request.method']).toBe('GET');
    expect(attributes['http.response.status_code']).toBe(200);
    expect(attributes['url.path']).toBe('/');
    expect(attributes['url.scheme']).toBe('http');
    expect(attributes['server.address']).toBe('127.0.0.1');
    expect(attributes['server.port']).toBe(7676);
  });

  it('should not include hardcoded network.protocol.version', async () => {
    await app.fetch('/');
    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    const allSpans = getAllSpans(receivedTraces);
    const httpSpan = findSpan(allSpans, 'GET /');
    const attributes = getSpanAttributes(httpSpan);

    expect(attributes['network.protocol.version']).toBeUndefined();
  });

  it('should set http.route attribute from TracedRouter', async () => {
    const response = await app.fetch('/user/user1');
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    const allSpans = getAllSpans(receivedTraces);
    const routeSpan = findSpan(allSpans, 'GET /user/:id');
    const attributes = getSpanAttributes(routeSpan);

    expect(attributes['http.route']).toBe('/user/:id');
  });

  it('should not mark 4xx responses as errors', async () => {
    const response = await app.fetch('/user/user999');
    expect(response.status).toBe(404);

    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    const allSpans = getAllSpans(receivedTraces);
    const span = findSpan(allSpans, 'GET /user/:id');

    expect(span.status.code).toBe(0);
  });

  it('should handle errors and return 500', async () => {
    const response = await app.fetch('/error');
    expect(response.status).toBe(500);

    const text = await response.text();
    expect(text).toContain('Test error');
  });

  it('should create error spans with exception details', async () => {
    const response = await app.fetch('/error');
    expect(response.status).toBe(500);

    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    const allSpans = getAllSpans(receivedTraces);
    const errorSpan = findSpan(allSpans, 'GET /error');
    const attributes = getSpanAttributes(errorSpan);

    expect(attributes['http.response.status_code']).toBe(500);
    expect(errorSpan.status.code).toBe(2);
  });

  it('should capture user-agent attribute when header is present', async () => {
    await app.fetch('/', {
      headers: { 'user-agent': 'TestClient/1.0' },
    });

    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    const allSpans = getAllSpans(receivedTraces);
    const httpSpan = findSpan(allSpans, 'GET /');
    const attributes = getSpanAttributes(httpSpan);

    expect(attributes['user_agent.original']).toBe('TestClient/1.0');
  });

  it('should propagate trace context from incoming headers', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentSpanId = '00f067aa0ba902b7';
    const traceparent = `00-${traceId}-${parentSpanId}-01`;

    const response = await app.fetch('/', {
      headers: { traceparent },
    });
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    const allSpans = getAllSpans(receivedTraces);
    const propagatedSpan = findSpan(allSpans, 'GET /');
    assert(propagatedSpan.parentSpanId, 'parentSpanId should be defined');

    const spanTraceId = Buffer.from(propagatedSpan.traceId).toString('utf-8');
    const spanParentSpanId = Buffer.from(propagatedSpan.parentSpanId).toString(
      'utf-8',
    );

    expect(spanTraceId).toBe(traceId);
    expect(spanParentSpanId).toBe(parentSpanId);
  });

  it('should create complete span hierarchy: route -> custom -> backend fetch', async () => {
    const response = await app.fetch('/trace');
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    const allSpans = getAllSpans(receivedTraces);

    const routeSpan = findSpan(allSpans, 'GET /trace');
    const customSpan = findSpan(allSpans, 'custom-operation');
    assert(
      customSpan.parentSpanId,
      'customSpan.parentSpanId should be defined',
    );

    const backendFetchSpan = findSpan(allSpans, 'Backend Fetch');
    assert(
      backendFetchSpan.parentSpanId,
      'backendFetchSpan.parentSpanId should be defined',
    );

    const routeSpanId = Buffer.from(routeSpan.spanId).toString('hex');
    const customSpanId = Buffer.from(customSpan.spanId).toString('hex');
    const customParentId = Buffer.from(customSpan.parentSpanId).toString('hex');
    const backendParentId = Buffer.from(backendFetchSpan.parentSpanId).toString(
      'hex',
    );

    expect(customParentId).toBe(routeSpanId);
    expect(backendParentId).toBe(customSpanId);

    const routeTraceId = Buffer.from(routeSpan.traceId).toString('hex');
    const customTraceId = Buffer.from(customSpan.traceId).toString('hex');
    const backendTraceId = Buffer.from(backendFetchSpan.traceId).toString(
      'hex',
    );

    expect(customTraceId).toBe(routeTraceId);
    expect(backendTraceId).toBe(routeTraceId);
  });

  it('should generate distinct trace IDs for sequential requests', async () => {
    await app.fetch('/');
    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));
    const firstTraces = [...receivedTraces];
    receivedTraces.length = 0;

    await app.fetch('/');
    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    const firstSpans = getAllSpans(firstTraces);
    const secondSpans = getAllSpans(receivedTraces);

    const firstSpan = findSpan(firstSpans, 'GET /');
    const secondSpan = findSpan(secondSpans, 'GET /');

    const firstTraceId = Buffer.from(firstSpan.traceId).toString('hex');
    const secondTraceId = Buffer.from(secondSpan.traceId).toString('hex');

    expect(firstTraceId).not.toBe(secondTraceId);
  });
});

describe('DynamoDB Integration', () => {
  it('should fetch user from DynamoDB and return 200', async () => {
    const response = await app.fetch('/user/user1');
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ id: 'user1', name: 'Alice' });
  });

  it('should return 404 when user not found', async () => {
    const response = await app.fetch('/user/user999');
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toEqual({ error: 'User not found' });
  });

  it('should create backend fetch spans for DynamoDB calls', async () => {
    await app.fetch('/user/user1');
    await app.fetch('/user/user999');

    await new Promise(resolve => setTimeout(resolve, SPAN_FLUSH_MS));

    const allSpans = getAllSpans(receivedTraces);
    const backendFetchSpans = allSpans.filter(s => s.name === 'Backend Fetch');

    expect(backendFetchSpans.length).toBeGreaterThanOrEqual(2);
  });
});
