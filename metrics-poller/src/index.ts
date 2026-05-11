export default {
  async scheduled(_event: ScheduledEvent, _env: any, _ctx: ExecutionContext) {
    console.log({ source: 'metrics-poller', message: 'tick stub' });
  },
};
