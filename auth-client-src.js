// Bundled into public/neon-auth.js by `npm run build` (runs automatically after `npm install`).
// Gives the website a Neon Auth client: window.createNeonAuth(authUrl)
import { createAuthClient } from '@neondatabase/auth';
import { BetterAuthVanillaAdapter } from '@neondatabase/auth/vanilla/adapters';

window.createNeonAuth = (url) =>
  createAuthClient(url, {
    adapter: BetterAuthVanillaAdapter(),
    fetchOptions: { credentials: 'include' },
  });
