import { test, expect, LOGGED_OUT_STATE } from "../../fixtures/test";
import { RegisterPage } from "../../pages/register.page";
import { DEMO_USER, STAFF_USER } from "../../utils/env";
import { newUserPayload } from "../../utils/data";
import { DEMO_OTP } from "../../utils/env";

/**
 * Every test here must start signed out, so the whole file overrides the
 * project-level storageState with an empty one.
 */
test.use({ storageState: LOGGED_OUT_STATE });

test.describe("Login", () => {
  test("signs a customer in and lands on the app shell", async ({ page, loginPage }) => {
    await loginPage.goto();
    await loginPage.login(DEMO_USER.email, DEMO_USER.password);

    await page.waitForURL((url) => new URL(url).pathname === "/");
    await expect(page.getByRole("link", { name: /transfer money/i }).first()).toBeVisible();
  });

  test("rejects a wrong password without leaving the page", async ({ page, loginPage }) => {
    await loginPage.goto();
    await loginPage.login(DEMO_USER.email, "definitely-not-the-password");

    await expect(loginPage.error()).toContainText(/invalid email or password/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test("refuses a staff account on the customer gate", async ({ loginPage }) => {
    await loginPage.goto();
    await loginPage.login(STAFF_USER.email, STAFF_USER.password);

    // The app logs the session straight back out and explains why.
    await expect(loginPage.error()).toContainText(/operator console/i);
  });

  test("bounces an anonymous visitor away from a protected page", async ({ page }) => {
    await page.goto("/accounts/cash");
    await page.waitForURL(/\/login/, { timeout: 20_000 });
  });

  test("remember-my-email survives a reload", async ({ page, loginPage }) => {
    await loginPage.goto();
    await loginPage.emailInput.fill(DEMO_USER.email);
    await loginPage.rememberEmailCheckbox.check();
    await loginPage.passwordInput.fill(DEMO_USER.password);
    await loginPage.submitButton.click();
    await page.waitForURL((url) => new URL(url).pathname === "/");

    // Clearing the JWT (not the remembered email) sends us back to the gate.
    await page.evaluate(() => window.localStorage.removeItem("hoanglam-bank-token"));
    await loginPage.goto();

    await expect(loginPage.emailInput).toHaveValue(DEMO_USER.email);
    await expect(loginPage.rememberEmailCheckbox).toBeChecked();
  });

  test("offers a link to registration", async ({ page, loginPage }) => {
    await loginPage.goto();
    await loginPage.createAccountLink.click();
    await expect(page).toHaveURL(/\/register/);
  });
});

test.describe("Registration", () => {
  test("creates a brand-new company and signs it in", async ({ page }) => {
    const registerPage = new RegisterPage(page);
    const payload = newUserPayload(DEMO_OTP);

    await registerPage.goto();
    await registerPage.fillForm(payload);
    await registerPage.continueToOtp();
    await registerPage.submitOtp(DEMO_OTP);

    await page.waitForURL((url) => new URL(url).pathname === "/", { timeout: 30_000 });
    // Registration provisions one USD account, so the shell renders signed in.
    await expect(page.getByRole("link", { name: /transfer money/i }).first()).toBeVisible();
  });

  test("rejects a duplicate email", async ({ page }) => {
    const registerPage = new RegisterPage(page);
    const payload = newUserPayload(DEMO_OTP);

    await registerPage.goto();
    await registerPage.fillForm({ ...payload, email: DEMO_USER.email });
    await registerPage.continueToOtp();
    await registerPage.submitOtp(DEMO_OTP);

    await expect(registerPage.error()).toContainText(/already registered/i);
    await expect(page).toHaveURL(/\/register/);
  });

  test("rejects a wrong OTP", async ({ page }) => {
    const registerPage = new RegisterPage(page);
    const payload = newUserPayload(DEMO_OTP);

    await registerPage.goto();
    await registerPage.fillForm(payload);
    await registerPage.continueToOtp();
    await registerPage.submitOtp("1234");

    await expect(registerPage.error()).toContainText(/invalid otp/i);
  });
});
