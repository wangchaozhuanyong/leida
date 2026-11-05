export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerLocalOwnerSetup } = await import('./server/local-setup');
    registerLocalOwnerSetup();
  }
}
