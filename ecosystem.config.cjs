/** PM2: single fork process on PORT (default 3000). Use: pm2 start ecosystem.config.cjs */
module.exports = {
  apps: [
    {
      name: "chatastay",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      max_restarts: 15,
      min_uptime: "5s"
    }
  ]
};
