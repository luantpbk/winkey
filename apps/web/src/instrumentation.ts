export async function register() {
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.API_MOCKS === '1' &&
    process.env.NODE_ENV !== 'production'
  ) {
    const { server } = await import('./mocks/server');
    server.listen({ onUnhandledRequest: 'bypass' });
  }
}
