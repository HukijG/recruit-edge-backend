export default {
  async scheduled(event, env, ctx) {
    console.log('[sync] tail tick stub — implementation in plan task 8');
  },
  async fetch(request, env, ctx) {
    return new Response('not implemented', { status: 501 });
  },
};
