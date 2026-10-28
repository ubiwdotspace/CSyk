/** Keeps the access and refresh tokens in memory. */
export class TokenStore {
  private access?: string;
  private refresh?: string;

  get accessToken(): string | undefined {
    return this.access;
  }

  save(access: string, refresh: string): void {
    this.access = access;
    this.refresh = refresh;
  }

  clear(): void {
    this.access = undefined;
    this.refresh = undefined;
  }

  get refreshToken(): string | undefined {
    return this.refresh;
  }
}

export async function refreshAccessToken(
  store: TokenStore,
  exchange: (refresh: string) => Promise<string>,
): Promise<string> {
  const refresh = store.refreshToken;
  if (!refresh) {
    store.clear();
    throw new Error('Session expired, please sign in again');
  }
  const access = await exchange(refresh);
  store.save(access, refresh);
  return access;
}
