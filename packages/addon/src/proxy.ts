import express, { Request, Response, NextFunction } from 'express';
import {
  createProxyMiddleware,
  responseInterceptor,
  Options,
} from 'http-proxy-middleware';
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import { createBasic } from '@easynews/api';
import { Agent as HttpsAgent } from 'https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ClientRequest } from 'http';

const router = express.Router();

interface StreamData {
  url: string;
  username: string;
  password: string;
  timestamp: number;
}

// Create a map to store stream tokens
const streamTokens = new Map<string, StreamData>();

// Clean up expired tokens periodically (1 hour expiry)
const EXPIRY_TIME = +(process.env.STREAM_TOKEN_EXPIRY || 3600000); // 1 hour
const CLEANUP_INTERVAL = Math.min(EXPIRY_TIME / 2, 300000); // Run every 5 minutes or when half the expiry time has passed

// Keep track of token usage
const tokenLastUsed = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [token, data] of streamTokens.entries()) {
    const lastUsed = tokenLastUsed.get(token) || data.timestamp;
    if (now - lastUsed > EXPIRY_TIME) {
      streamTokens.delete(token);
      tokenLastUsed.delete(token);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    console.log('Cleaned up expired tokens:', {
      cleanedCount,
      remaining: streamTokens.size,
      oldestToken: Array.from(streamTokens.entries())[0],
      newestToken: Array.from(streamTokens.entries())[streamTokens.size - 1],
    });
  }
}, CLEANUP_INTERVAL);

// Generate a secure token for a stream
export function generateStreamToken(
  url: string,
  username: string,
  password: string
): string {
  const token =
    Math.random().toString(36).substring(2) + Date.now().toString(36);

  // Store stream data with token
  const streamData = {
    url,
    username,
    password,
    timestamp: Date.now(),
  };

  console.log('Generating stream token:', {
    token,
    url,
    timestamp: new Date().toISOString(),
  });

  streamTokens.set(token, streamData);
  tokenLastUsed.set(token, Date.now());

  // Log current tokens
  console.log('Current tokens:', {
    count: streamTokens.size,
    tokens: Array.from(streamTokens.keys()),
    newest: token,
  });

  return token;
}

// Debug middleware to log all requests
router.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Create SOCKS proxy agent if configured
let proxyAgent: SocksProxyAgent | undefined;
try {
  const proxyUrl = process.env.PROXY_URL;
  if (proxyUrl) {
    // Validate URL format
    new URL(proxyUrl); // This will throw if URL is invalid
    proxyAgent = new SocksProxyAgent(proxyUrl);
    console.log('Initialized proxy agent:', {
      proxyUrl,
      agent: 'SocksProxyAgent',
    });
  } else {
    console.log('No proxy URL configured, running without proxy');
  }
} catch (error) {
  console.error('Failed to initialize proxy agent:', {
    error: error instanceof Error ? error.message : String(error),
    proxyUrl: process.env.PROXY_URL,
  });
}

console.log('Initializing proxy agent:', {
  proxyUrl: process.env.PROXY_URL,
  agent: proxyAgent ? 'SocksProxyAgent' : 'none',
});

// Proxy stream endpoint - handle both /{token}/video and /stream/{token}/video paths
router.get(
  ['/:token/video', '/stream/:token/video'],
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.params.token;
      console.log('Received stream request:', {
        token,
        url: req.url,
        path: req.path,
        method: req.method,
        params: req.params,
        query: req.query,
        headers: req.headers,
      });

      const streamData = streamTokens.get(token);
      if (!streamData) {
        console.error('Invalid or expired token:', {
          token,
          availableTokens: Array.from(streamTokens.keys()),
          tokenCount: streamTokens.size,
          requestTime: new Date().toISOString(),
        });
        res.status(403).send('Invalid or expired stream token');
        return;
      }

      // Update last used time
      tokenLastUsed.set(token, Date.now());

      // Extract the target URL from streamData
      const targetUrl = new URL(streamData.url);
      console.log('Proxying stream request:', {
        token,
        url: targetUrl.toString(),
        timestamp: new Date(streamData.timestamp).toISOString(),
        age: Date.now() - streamData.timestamp + 'ms',
        headers: {
          'user-agent': req.headers['user-agent'],
          range: req.headers.range,
        },
      });

      // Create proxy middleware
      const proxyOptions: Options = {
        target: `${targetUrl.protocol}//${targetUrl.host}`,
        changeOrigin: true,
        secure: true,
        followRedirects: true,
        agent: proxyAgent,
        xfwd: false,
        pathRewrite: (path) => {
          // Just use the target URL's pathname, ignore our /stream/token/video path
          console.log('Path rewrite:', {
            from: path,
            to: targetUrl.pathname,
            fullUrl: `${targetUrl.protocol}//${targetUrl.host}${targetUrl.pathname}`,
          });
          return targetUrl.pathname + targetUrl.search;
        },
        headers: {
          Authorization: createBasic(streamData.username, streamData.password),
          'User-Agent': req.headers['user-agent'] || 'Stremio',
          'Accept-Ranges': 'bytes',
          Accept: '*/*',
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
        proxyTimeout: 60000, // 1 minute timeout
        timeout: 60000,
        selfHandleResponse: true,
        on: {
          proxyReq: (proxyReq: ClientRequest, req: IncomingMessage) => {
            // Log headers safely
            const headers: Record<
              string,
              string | number | string[] | undefined
            > = {};
            const headerNames = proxyReq.getHeaderNames?.() || [];
            for (const name of headerNames) {
              headers[name] = proxyReq.getHeader(name);
            }

            console.log('Outgoing proxy request:', {
              method: proxyReq.method,
              host: proxyReq.getHeader('host'),
              path: proxyReq.path,
              headers,
            });
          },

          proxyRes: (
            proxyRes: IncomingMessage,
            req: IncomingMessage,
            res: ServerResponse
          ) => {
            // Log response info
            console.log('Proxy response:', {
              status: proxyRes.statusCode,
              headers: proxyRes.headers,
              url: req.url,
              targetUrl: `${targetUrl.protocol}//${targetUrl.host}${targetUrl.pathname}${targetUrl.search}`,
            });

            // Set response headers before sending any data
            res.statusCode = proxyRes.statusCode || 200;

            // Copy all headers from proxy response
            Object.entries(proxyRes.headers).forEach(([key, value]) => {
              if (value !== undefined) {
                res.setHeader(key, value);
              }
            });

            // Set content type based on file extension
            const ext = targetUrl.pathname.split('.').pop()?.toLowerCase();
            if (ext) {
              const contentType = {
                mp4: 'video/mp4',
                mkv: 'video/x-matroska',
                avi: 'video/x-msvideo',
                mov: 'video/quicktime',
                wmv: 'video/x-ms-wmv',
                m4v: 'video/x-m4v',
                flv: 'video/x-flv',
                webm: 'video/webm',
              }[ext];

              if (contentType) {
                res.setHeader('content-type', contentType);
              }
            } else if (!res.getHeader('content-type')) {
              // Fallback content type if no extension found
              res.setHeader('content-type', 'video/mp4');
            }

            // Stream the response
            proxyRes.pipe(res);
          },

          error: (
            err: Error,
            req: IncomingMessage,
            res: ServerResponse | Socket,
            target?: unknown
          ) => {
            console.error('Proxy error:', {
              message: err.message,
              stack: err.stack,
              name: err.name,
              target: target ? String(target) : undefined,
              code: (err as NodeJS.ErrnoException).code,
              statusCode: (res as ServerResponse).statusCode,
              url: req.url,
              method: req.method,
            });

            // Only send error response if we have a proper ServerResponse and headers haven't been sent
            if (res instanceof ServerResponse && !res.headersSent) {
              try {
                res.writeHead(502, {
                  'Content-Type': 'text/plain',
                  'Cache-Control': 'no-cache, no-store, must-revalidate',
                });
                res.end(`Proxy error: ${err.message}`);
              } catch (writeError) {
                console.error('Error sending error response:', writeError);
              }
            }
          },
        },
      };

      const proxy = createProxyMiddleware(proxyOptions);
      return proxy(req, res, next);
    } catch (error: unknown) {
      console.error(
        'Unexpected error:',
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
            }
          : error
      );
      if (!res.headersSent) {
        res
          .status(500)
          .send(
            'Internal server error: ' +
              (error instanceof Error ? error.message : 'Unknown error')
          );
      }
    }
  }
);

export const proxyRouter = router;
