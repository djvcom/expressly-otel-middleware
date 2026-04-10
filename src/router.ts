import { type ERequest, type EResponse, Router } from '@fastly/expressly';

/**
 * Stores the matched route pattern for each request, keyed by request object.
 * Read by the tracing middleware to set the http.route attribute.
 */
export const routePatterns = new WeakMap<ERequest, string>();

type HandlerFn = (req: ERequest, res: EResponse) => Promise<unknown>;

const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'delete',
  'head',
  'options',
  'patch',
  'purge',
  'all',
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

function wrapCallback(pattern: string, callback: HandlerFn): HandlerFn {
  return async (req: ERequest, res: EResponse) => {
    routePatterns.set(req, pattern);
    return callback(req, res);
  };
}

export function createTracedRouter(
  config?: ConstructorParameters<typeof Router>[0],
): Router {
  const router = new Router(config);

  for (const method of HTTP_METHODS) {
    const original = router[method].bind(router) as (
      pattern: string,
      callback: HandlerFn,
    ) => void;

    (router as Record<HttpMethod, unknown>)[method] = (
      pattern: string,
      callback: HandlerFn,
    ) => {
      original(pattern, wrapCallback(pattern, callback));
    };
  }

  const originalRoute = router.route.bind(router);
  router.route = (
    methods: Parameters<typeof router.route>[0],
    pattern: string,
    callback: HandlerFn,
  ) => {
    originalRoute(methods, pattern, wrapCallback(pattern, callback));
  };

  return router;
}
