/**
 * The utility billers a company can pay from the Payments page. Static
 * catalogue rather than a table — this is a sandbox with no real biller
 * integrations, and the ids are referenced directly by the route's zod enum.
 */
export const UTILITY_PROVIDERS = [
  { id: "evn", name: "EVN - Electricity", category: "Electricity" },
  { id: "sawaco", name: "Sawaco - Water Supply", category: "Water" },
  { id: "fpt", name: "FPT Telecom - Internet", category: "Internet" },
  { id: "tuition", name: "Online Tuition", category: "Tuition" },
  { id: "insurance", name: "Life Insurance", category: "Insurance" },
] as const;

