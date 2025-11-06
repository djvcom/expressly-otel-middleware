import type { ERequest, EResponse } from '@fastly/expressly';
import {
  context,
  defaultTextMapGetter,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  ATTR_CLIENT_ADDRESS,
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_NETWORK_PROTOCOL_VERSION,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';

const tracer = trace.getTracer('fastly-compute-tracer');

export async function tracingMiddleware(req: ERequest, res: EResponse) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  const extractedContext = propagation.extract(
    context.active(),
    Object.fromEntries(req.headers),
    defaultTextMapGetter,
  );

  const span = tracer.startSpan(
    `${req.method} ${pathname}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: req.method,
        [ATTR_URL_PATH]: pathname,
        [ATTR_URL_SCHEME]: url.protocol.replace(':', ''),
        [ATTR_SERVER_ADDRESS]: url.hostname,
        [ATTR_SERVER_PORT]:
          Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
        [ATTR_NETWORK_PROTOCOL_VERSION]: '1.1',
      },
    },
    extractedContext,
  );

  const userAgent = req.headers.get('user-agent');
  if (userAgent) {
    span.setAttribute(ATTR_USER_AGENT_ORIGINAL, userAgent);
  }

  const clientAddress =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip');
  if (clientAddress) {
    span.setAttribute(ATTR_CLIENT_ADDRESS, clientAddress);
  }

  const ctx = trace.setSpan(extractedContext, span);

  return context.with(ctx, () => {
    const originalSend = res.send.bind(res);

    res.send = body => {
      const statusCode = res.status || 200;
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);

      if (statusCode >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
        });
        span.setAttribute(ATTR_ERROR_TYPE, String(statusCode));
      }

      span.end();
      return originalSend(body);
    };
  });
}

export async function errorMiddleware(
  err: Error,
  _req: ERequest,
  res: EResponse,
) {
  const span = trace.getActiveSpan();

  if (span) {
    span.recordException(err);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err.message,
    });
    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, 500);
  }

  res.withStatus(500).send(`Error: ${err.message}`);
}
