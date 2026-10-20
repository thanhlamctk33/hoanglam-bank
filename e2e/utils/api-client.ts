import { APIRequestContext, request } from "@playwright/test";
import { API_BASE_URL, DEMO_OTP, DEMO_USER } from "./env";
import { newUserPayload } from "./data";

export interface AuthResponse {
  token: string;
  user: { id: string; name: string; email: string; isStaff?: boolean; role?: string };
  company: { id: string; name: string };
}

export interface Account {
  id: string;
  name: string;
  accountNumber: string;
  balance: number;
  currency: string;
  type: string;
}

/**
 * Thin wrapper over Playwright's request context that keeps the JWT and the
 * `/api` prefix in one place. Every method returns parsed JSON and throws with
 * the server's own error body attached, so a failing assertion tells you what
 * the backend actually said instead of just "expected 200, got 422".
 */
export class ApiClient {
  constructor(
    private readonly ctx: APIRequestContext,
    private token: string | null = null
  ) {}

  /** Builds a client with its own request context — for use outside a test. */
  static async create(token?: string): Promise<ApiClient> {
    const ctx = await request.newContext({ baseURL: API_BASE_URL });
    return new ApiClient(ctx, token ?? null);
  }

  /** Logs in and returns a client already carrying the resulting token. */
  static async login(
    credentials: { email: string; password: string } = DEMO_USER
  ): Promise<{ client: ApiClient; auth: AuthResponse }> {
    const client = await ApiClient.create();
    const auth = await client.post<AuthResponse>("/auth/login", credentials);
    client.setToken(auth.token);
    return { client, auth };
  }

  /**
   * Registers a brand-new company and returns a client acting as its owner.
   *
   * Used by the tenancy specs: the resulting caller is a legitimate, fully
   * authenticated ADMIN who simply has no business touching the demo
   * company's data — which is exactly the boundary those specs probe.
   */
  static async registerNewCompany(): Promise<{ client: ApiClient; auth: AuthResponse }> {
    const client = await ApiClient.create();
    const auth = await client.post<AuthResponse>("/auth/register", newUserPayload(DEMO_OTP));
    client.setToken(auth.token);
    return { client, auth };
  }

  /** A client with no token at all — for "this route must 401" assertions. */
  static async anonymous(): Promise<ApiClient> {
    return ApiClient.create();
  }

  setToken(token: string | null) {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  private headers(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private url(path: string): string {
    return path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  }

  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const res = await this.ctx.get(this.url(path), { headers: this.headers(), params });
    return unwrap<T>(res, "GET", path);
  }

  async post<T>(path: string, data?: unknown): Promise<T> {
    const res = await this.ctx.post(this.url(path), { headers: this.headers(), data });
    return unwrap<T>(res, "POST", path);
  }

  async patch<T>(path: string, data?: unknown): Promise<T> {
    const res = await this.ctx.patch(this.url(path), { headers: this.headers(), data });
    return unwrap<T>(res, "PATCH", path);
  }

  /** The compliance wizards (KYB profile, KYC profile/document) are PUTs. */
  async put<T>(path: string, data?: unknown): Promise<T> {
    const res = await this.ctx.put(this.url(path), { headers: this.headers(), data });
    return unwrap<T>(res, "PUT", path);
  }

  async delete<T>(path: string): Promise<T> {
    const res = await this.ctx.delete(this.url(path), { headers: this.headers() });
    return unwrap<T>(res, "DELETE", path);
  }

  /** Escape hatch for negative tests that need the raw response and status. */
  raw() {
    return {
      get: (path: string, params?: Record<string, string | number>) =>
        this.ctx.get(this.url(path), { headers: this.headers(), params }),
      post: (path: string, data?: unknown) =>
        this.ctx.post(this.url(path), { headers: this.headers(), data }),
      patch: (path: string, data?: unknown) =>
        this.ctx.patch(this.url(path), { headers: this.headers(), data }),
      put: (path: string, data?: unknown) =>
        this.ctx.put(this.url(path), { headers: this.headers(), data }),
      delete: (path: string) => this.ctx.delete(this.url(path), { headers: this.headers() }),
    };
  }

  async dispose() {
    await this.ctx.dispose();
  }

  // --- convenience shortcuts used by more than one spec --------------------

  async listAccounts(): Promise<Account[]> {
    const { accounts } = await this.get<{ accounts: Account[] }>("/accounts");
    return accounts;
  }

  /** First account in the given currency — most specs just need "any USD one". */
  async firstAccount(currency = "USD"): Promise<Account> {
    const accounts = await this.listAccounts();
    const match = accounts.find((a) => a.currency === currency) ?? accounts[0];
    if (!match) {
      throw new Error(
        "No accounts returned for the seeded company. Run `npm run seed` in backend/ first."
      );
    }
    return match;
  }
}

async function unwrap<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
  method: string,
  path: string
): Promise<T> {
  if (res.status() === 204) return undefined as T;
  const body = await res.text();
  if (!res.ok()) {
    throw new Error(`${method} ${path} → ${res.status()} ${res.statusText()}\n${body}`);
  }
  return body ? (JSON.parse(body) as T) : (undefined as T);
}
