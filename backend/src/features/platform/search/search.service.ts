import * as searchRepo from "./search.repository";

/**
 * Cross-entity search over data that already exists — no new table. Each
 * page (Cards, Budgets, ...) still has its own local filter via the shared
 * search query; this additionally powers a global "jump to" dropdown in the
 * Topbar so a query can surface results outside the page you're currently
 * on.
 */

/** Per-entity cap — the dropdown shows a handful from each, not a full result set. */
const RESULT_LIMIT = 5;

/** Below this, a query matches too much to be useful (and costs five table scans). */
const MIN_QUERY_LENGTH = 2;

const EMPTY_RESULTS = { transactions: [], cards: [], budgets: [], bills: [], claims: [] };

export async function searchAll(companyId: string, rawQuery: string) {
  const trimmedQuery = rawQuery.trim();
  if (trimmedQuery.length < MIN_QUERY_LENGTH) {
    return EMPTY_RESULTS;
  }

  const contains = searchRepo.containsFilter(trimmedQuery);

  const [transactions, cards, budgets, bills, claims] = await Promise.all([
    searchRepo.searchTransactions(companyId, contains, RESULT_LIMIT),
    searchRepo.searchCards(companyId, contains, RESULT_LIMIT),
    searchRepo.searchBudgets(companyId, contains, RESULT_LIMIT),
    searchRepo.searchBills(companyId, contains, RESULT_LIMIT),
    searchRepo.searchClaims(companyId, contains, RESULT_LIMIT),
  ]);

  return { transactions, cards, budgets, bills, claims };
}
