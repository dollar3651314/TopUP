import type { APIRoute } from 'astro';

// 现在全站都是 noindex（第一版不做营销页），站点地图不收录任何页面；以后有可以收录的公开页面再加进来
export const GET: APIRoute = () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>
`;
  return new Response(xml, { headers: { 'content-type': 'application/xml' } });
};
