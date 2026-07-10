// Entry point: load file-based config and start the HTTP server.

import { config } from "./config.js";
import { createServer } from "./server.js";

// Fail-closed guard is silent otherwise: warn if auth is on but no token was configured.
if (config.auth.enabled && config.auth.token === "") {
  console.warn(
    "[imagegen-service] auth.enabled is true but auth.token is empty — all /generate and /styles requests will be rejected with 401. Set a token in config.json.",
  );
}

const server = createServer(config);
server.listen(config.server.port, config.server.host, () => {
  const authState = config.auth.enabled ? "token-gated" : "open (no auth)";
  console.log(
    `[imagegen-service] listening on http://${config.server.host}:${config.server.port} -> ComfyUI ${config.comfyui.url} [${authState}]`,
  );
});
