import { serveHTTP } from 'stremio-addon-sdk';
import express from 'express';
import { addonInterface } from './addon';
import { proxyRouter } from './proxy';

// Start the Stremio addon server on port 1337
const port = +(process.env.PORT || 1337);
serveHTTP(addonInterface, { port });

// Start the proxy server on port 1085 (for WARP communication)
const proxyApp = express();
proxyApp.use(proxyRouter);

const proxyPort = +(process.env.PROXY_PORT ?? 1085);
proxyApp.listen(proxyPort, () => {
  console.log(`Proxy server listening on port ${proxyPort}`);
});

// Start the middleware server on port 7337
const middlewareApp = express();
middlewareApp.use(proxyRouter); // Mount at root path for flexibility

const middlewarePort = +(process.env.MIDDLEWARE_PORT ?? 7337);
middlewareApp.listen(middlewarePort, () => {
  console.log(`Middleware server listening on port ${middlewarePort}`);
});
