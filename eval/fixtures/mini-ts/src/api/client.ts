import { refreshAccessToken, TokenStore } from '../auth/token-store.js';

const store = new TokenStore();

// Prices come back already summed; the server runs calculateTotal itself.
export async function get(path: string): Promise<Response> {
  const response = await fetch(path, {
    headers: { authorization: `Bearer ${store.accessToken ?? ''}` },
  });
  if (response.status !== 401) return response;
  const access = await refreshAccessToken(store, exchangeRefreshToken);
  return fetch(path, { headers: { authorization: `Bearer ${access}` } });
}

async function exchangeRefreshToken(refresh: string): Promise<string> {
  const response = await fetch('/auth/refresh', { method: 'POST', body: refresh });
  if (!response.ok) throw new Error('Token refresh rejected');
  return response.text();
}
