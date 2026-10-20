import { test, expect } from "../../fixtures/test";
import { uniqueSuffix } from "../../utils/data";

/**
 * /api/categories — the company's own merchant-category list.
 *
 * This list exists because card controls used to read a hardcoded array. It
 * is now the single source of truth behind the blocked-category picker and
 * the simulate-purchase merchant dropdown, so the rules worth pinning are:
 * everyone can read it, only an admin can change it, and it is scoped per
 * company like everything else.
 */

interface Category {
  id: string;
  name: string;
}

const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

test.describe("Reading", () => {
  test("any member of the company may read the list", async ({ memberApi }) => {
    const { categories } = await memberApi.get<{ categories: Category[] }>("/categories");
    expect(Array.isArray(categories)).toBe(true);
  });

  test("an anonymous caller may not", async ({ anonApi }) => {
    const res = await anonApi.raw().get("/categories");
    expect(res.status()).toBe(401);
  });
});

test.describe("Writing is admin-only", () => {
  test("an admin adds a category and it shows up in the list", async ({ fundedCompany }) => {
    const name = `Cat ${uniqueSuffix()}`;

    const { category } = await fundedCompany.api.post<{ category: Category }>("/categories", {
      name,
    });
    expect(category.name).toBe(name);

    const { categories } = await fundedCompany.api.get<{ categories: Category[] }>("/categories");
    expect(categories.map((c) => c.name)).toContain(name);
  });

  test("a MEMBER cannot add one", async ({ memberApi }) => {
    const res = await memberApi.raw().post("/categories", { name: `Cat ${uniqueSuffix()}` });
    expect(res.status()).toBe(403);
  });

  test("a MEMBER cannot delete one", async ({ memberApi }) => {
    const res = await memberApi.raw().delete(`/categories/${ABSENT_ID}`);
    expect(res.status()).toBe(403);
  });

  test("the same name twice is a conflict, not a second row", async ({ fundedCompany }) => {
    const name = `Cat ${uniqueSuffix()}`;
    await fundedCompany.api.post("/categories", { name });

    const res = await fundedCompany.api.raw().post("/categories", { name });
    expect(res.status()).toBe(409);

    const { categories } = await fundedCompany.api.get<{ categories: Category[] }>("/categories");
    expect(categories.filter((c) => c.name === name)).toHaveLength(1);
  });

  test("an empty name is refused, and so is one over 40 characters", async ({ fundedCompany }) => {
    const empty = await fundedCompany.api.raw().post("/categories", { name: "" });
    expect(empty.status()).toBe(400);

    const tooLong = await fundedCompany.api.raw().post("/categories", { name: "x".repeat(41) });
    expect(tooLong.status()).toBe(400);
  });
});

test.describe("Deleting", () => {
  test("an admin removes a category", async ({ fundedCompany }) => {
    const { category } = await fundedCompany.api.post<{ category: Category }>("/categories", {
      name: `Cat ${uniqueSuffix()}`,
    });

    const res = await fundedCompany.api.raw().delete(`/categories/${category.id}`);
    expect(res.status()).toBe(204);

    const { categories } = await fundedCompany.api.get<{ categories: Category[] }>("/categories");
    expect(categories.map((c) => c.id)).not.toContain(category.id);
  });

  test("deleting an id this company never had is a 404", async ({ fundedCompany }) => {
    const res = await fundedCompany.api.raw().delete(`/categories/${ABSENT_ID}`);
    expect(res.status()).toBe(404);
  });
});

test.describe("POST /api/categories/reset", () => {
  test("restores the starter list", async ({ fundedCompany }) => {
    const { categories } = await fundedCompany.api.post<{ categories: Category[] }>(
      "/categories/reset"
    );

    expect(categories.length).toBeGreaterThan(0);

    const { categories: reread } = await fundedCompany.api.get<{ categories: Category[] }>(
      "/categories"
    );
    expect(reread.map((c) => c.name).sort()).toEqual(categories.map((c) => c.name).sort());
  });
});

test.describe("Company boundary", () => {
  test("a category added here is invisible to another company", async ({
    fundedCompany,
    outsiderApi,
  }) => {
    const name = `Cat ${uniqueSuffix()}`;
    await fundedCompany.api.post("/categories", { name });

    const { categories } = await outsiderApi.get<{ categories: Category[] }>("/categories");
    expect(categories.map((c) => c.name)).not.toContain(name);
  });
});
