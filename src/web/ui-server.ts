import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

const app = new Hono();
const PORT = parseInt(process.env.WEB_UI_PORT || '18081', 10);

app.use('/*', serveStatic({ root: './src/web/public' }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\n🌐 Web UI 已启动`);
  console.log(`   地址: http://localhost:${info.port}\n`);
});
