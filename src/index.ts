// Entry point: load file-based config and start the HTTP server.

import { config } from "./config.js";
import { createServer } from "./server.js";

const server = createServer(config);
server.listen(config.server.port, config.server.host, () => {
  console.log(
    `[imagegen-service] listening on http://${config.server.host}:${config.server.port} -> ComfyUI ${config.comfyui.url}`,
  );
});
