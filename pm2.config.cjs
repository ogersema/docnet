module.exports = {
  apps: [
    {
      name: 'docnet-api',
      script: 'tsx',
      args: 'api_server.ts',
      cwd: '/home/docnet/app',
      user: 'docnet',
      env_file: '/home/docnet/app/.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      error_file: '/var/log/docnet/api-error.log',
      out_file: '/var/log/docnet/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },
    {
      name: 'docnet-worker',
      script: 'tsx',
      args: 'worker/index.ts',
      cwd: '/home/docnet/app',
      user: 'docnet',
      env_file: '/home/docnet/app/.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      error_file: '/var/log/docnet/worker-error.log',
      out_file: '/var/log/docnet/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
    }
  ]
};
