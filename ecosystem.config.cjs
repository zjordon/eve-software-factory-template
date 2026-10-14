"use strict";
// pm2 process definition for the resident factory (M2).
// Portable: run `pm2 start ecosystem.config.cjs` from the deployment clone's
// root on the resident host (the dedicated Ubuntu box; the original WSL2
// attempt is documented in docs/implement-plan/M2-常驻服务.md).
// Start via `eve start` (the CLI), never `node .output/server/index.mjs`
// directly: the CLI is what loads the clone's `.env.local` into the runtime.
module.exports = {
  apps: [
    {
      args: "exec eve start --host 0.0.0.0 --port 3000",
      interpreter: "none",
      max_restarts: 10,
      name: "foreman-local",
      restart_delay: 5000,
      script: "pnpm",
      time: true,
    },
  ],
};
