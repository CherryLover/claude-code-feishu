import { serve } from '@hono/node-server';
import { app } from './api.js';

const PORT = parseInt(process.env.WEB_API_PORT || '18080', 10);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\n🔌 Web API 服务已启动`);
  console.log(`   地址: http://localhost:${info.port}/api\n`);
});
