import { loadSession } from "./session.js";
import { getStoreContexts, type StoreContext } from "./config.js";

const BASE_URL = "https://www.checkers.co.za";

export class CheckersAPI {
  private cookies: string;
  private storeContexts: StoreContext[];

  constructor() {
    const session = loadSession();
    if (!session) {
      throw new Error(
        "Not logged in. Run `checkers60 login` first."
      );
    }
    this.cookies = session.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    this.storeContexts = getStoreContexts();
  }

  private async fetch(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const url = `${BASE_URL}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Cookie: this.cookies,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Referer: `${BASE_URL}/`,
      Origin: BASE_URL,
      ...(options.headers as Record<string, string>),
    };

    const resp = await fetch(url, {
      ...options,
      headers,
      redirect: "follow",
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new APIError(resp.status, resp.statusText, body, path);
    }

    return resp;
  }

  async searchProducts(
    query: string,
    options: { page?: number; pageSize?: number; sortBy?: string } = {}
  ): Promise<SearchResult> {
    const { page = 1, pageSize = 20, sortBy = "Relevance" } = options;

    if (this.storeContexts.length === 0) {
      throw new Error(
        "No store contexts configured. Run `checkers60 login` to set up your delivery address."
      );
    }

    const resp = await this.fetch("/api/catalogue/get-products-filter", {
      method: "POST",
      body: JSON.stringify({
        storeContexts: this.storeContexts,
        search: query,
        page,
        pageSize,
        sortBy,
      }),
    });

    return resp.json() as Promise<SearchResult>;
  }

  async getFilterOptions(query: string): Promise<unknown> {
    const resp = await this.fetch(
      "/api/catalogue/get-products-filter-options",
      {
        method: "POST",
        body: JSON.stringify({
          productFilterOptions: {
            productListSource: { search: query },
            storeContexts: this.storeContexts,
          },
        }),
      }
    );

    return resp.json();
  }

  async getDeliverySlots(): Promise<unknown> {
    const resp = await this.fetch("/api/stores/get-delivery-slots");
    return resp.json();
  }

  async getFirstDeliverySlot(): Promise<unknown> {
    const resp = await this.fetch("/api/stores/get-first-delivery-slots");
    return resp.json();
  }

  async getPopularSearches(): Promise<unknown> {
    const resp = await this.fetch("/api/catalogue/get-popular-searches");
    return resp.json();
  }

  async getCategoryTree(): Promise<unknown> {
    const resp = await this.fetch("/api/catalogue/get-category-tree");
    return resp.json();
  }
}

export class APIError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string,
    public path: string
  ) {
    super(`API ${status} ${statusText} on ${path}: ${body.slice(0, 200)}`);
    this.name = "APIError";
  }
}

// Types based on observed API responses

export interface SearchResult {
  products?: Product[];
  totalCount?: number;
  page?: number;
  pageSize?: number;
  [key: string]: unknown;
}

export interface Product {
  id: string;
  name: string;
  description?: string;
  price?: number;
  originalPrice?: number;
  imageUrl?: string;
  brand?: string;
  category?: string;
  inStock?: boolean;
  serviceOptionId?: string;
  promotions?: Promotion[];
  isVitality?: boolean;
  [key: string]: unknown;
}

export interface Promotion {
  type: string;
  description: string;
  savings?: number;
  [key: string]: unknown;
}
