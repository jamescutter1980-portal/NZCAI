import { fetchJson, IntegrationHttpError, type OperationContext } from "../framework";

/**
 * fetchJson that treats HTTP 404 as "not found" (data null) whatever the body
 * (soda4LCA and EC3 may answer 404 with HTML), while other errors still throw.
 */
export async function fetchJsonOrNotFound<T>(ctx: OperationContext, url: string, init: RequestInit = {}): Promise<{ data: T | null; status: number }> {
  try {
    const { data, status } = await fetchJson<T>(ctx, url, init, { acceptStatuses: [404] });
    return { data: status === 404 ? null : data, status };
  } catch (e) {
    if (e instanceof IntegrationHttpError && e.status === 404) return { data: null, status: 404 };
    throw e;
  }
}
