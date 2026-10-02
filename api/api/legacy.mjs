import { app } from './shared/http.mjs';

// Retained only to explain recovery to old open tabs. No storage or templates.
export const retiredRoutes = {
  GET: ['app', 'lists/all', 'lists/editDefaults', 'lists/quickAddForm', 'lists/defaultOptions',
    'items/byList', 'items/filterByStatus', 'settings/edit'],
  POST: ['lists/create', 'lists/updateDefaults', 'lists/resetDefaults', 'items/create',
    'items/toggleComplete', 'settings/ensure', 'settings/update', 'settings/reset']
};
for (const [method, paths] of Object.entries(retiredRoutes)) {
  for (const route of paths) app.http(`retired-${method}-${route.replaceAll('/', '-')}`, {
    route, methods: [method], authLevel: 'anonymous',
    handler: async () => new Response('This workspace has moved to the durable inbox at /. Keep a copy of your entered text, then reload the page.', {
      status: method === 'POST' ? 409 : 410, headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
  });
}
