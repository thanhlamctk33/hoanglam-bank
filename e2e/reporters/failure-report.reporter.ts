import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import fs from "node:fs";
import path from "node:path";

/**
 * Writes a machine-readable and a human-readable account of every failure to
 * `heal/`, for the healing loop (`npm run heal`) to start from.
 *
 * WHY THIS EXISTS. The stock way to hand a failure to an agent is to paste
 * terminal output, which mixes the useful part (which locator, which status
 * code, which assertion) with a hundred lines of stack. Worse, it loses the
 * one thing that decides what a fix should look like: WHAT KIND of failure it
 * is. A stale locator wants a page-object edit; a 402 wants a fresh
 * `fundedCompany`; a failed sign-in usually wants `npm run seed`, not a code
 * change at all.
 *
 * So each failure is classified, and each class carries the rule that applies
 * to it. The agent reads a verdict, not a transcript.
 *
 * It is opt-in: `playwright.config.ts` is untouched, and a normal `npm test`
 * behaves exactly as before.
 */

type FailureKind =
  | "SETUP"
  | "LOCATOR"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "PLAN_LIMIT"
  | "MONEY"
  | "ASSERTION";

interface Failure {
  title: string;
  file: string;
  line: number;
  project: string;
  kind: FailureKind;
  message: string;
  /** The locator the error blamed, when the message named one. */
  locator: string | null;
  /** Files Playwright kept: trace, screenshots, video. */
  artifacts: string[];
  retries: number;
}

const OUT_DIR = "heal";

/** Rules that apply to each kind of failure, in the agent's own terms. */
const GUIDANCE: Record<FailureKind, string> = {
  SETUP:
    "A fixture could not be built. This is almost never a spec bug. Check the backend is up and that the database is seeded (`cd ../backend && npm run seed`) BEFORE editing anything. If several tests fail this way at once, that is the whole diagnosis.",
  LOCATOR:
    "A locator did not resolve. Fix it in `pages/`, never inline in the spec, and keep it user-facing: getByRole → getByLabel → getByPlaceholder, in that order. Do NOT reach for a Tailwind class or an nth-child chain. If the accessible name genuinely disappeared from the app, that is an accessibility regression worth reporting, not routing around.",
  TIMEOUT:
    "Something never arrived. Prefer waiting on the specific thing (`waitForApi`, an expect on the element that proves the page is ready) over raising the timeout. Never wait for networkidle.",
  HTTP_STATUS:
    "The API answered with a status the spec did not expect. Decide which one is wrong before touching either: the backend route, or the expectation. Do not widen the expectation to a list of statuses just to get green.",
  PLAN_LIMIT:
    "A 402 means a subscription plan quota was hit (FREE: 3 active cards, 2 active budgets, 5 claims/month). If the spec is not ABOUT the cap, it is running against a company that already has objects — move it to the `fundedCompany` fixture, which starts every test at zero. Do not raise the company's plan to make it pass.",
  MONEY:
    "A balance, fee, or ledger assertion failed. Treat the app as the suspect, not the test. Do NOT relax the expected value, widen a tolerance, or delete the assertion. If you believe the test is right and the app is wrong, mark it `test.fail()` with a comment naming the suspected bug — never `test.fixme()`, which hides it.",
  ASSERTION:
    "An expectation did not hold. Read what the app actually produced before deciding the expectation was wrong.",
};

const MONEY_HINTS =
  /balance|debit|credit|amount|spent|fee|ledger|transaction|toBeCloseTo|overdraft/i;

function classify(message: string, testFile: string): FailureKind {
  if (/Could not build the ".*" fixture|npm run seed|ECONNREFUSED/i.test(message)) return "SETUP";
  if (/expected 402|received 402|\b402\b/.test(message)) return "PLAN_LIMIT";
  if (/waiting for (locator|getBy)|strict mode violation|resolved to 0 elements/i.test(message))
    return "LOCATOR";
  if (/Test timeout|exceeded while|Timeout .* exceeded/i.test(message)) return "TIMEOUT";
  if (/expected \d{3}|status\(\)|toBe\(\d{3}\)/.test(message)) return "HTTP_STATUS";
  if (MONEY_HINTS.test(message) || /money|transfer|payment|bills|cards/.test(testFile))
    return "MONEY";
  return "ASSERTION";
}

/** Pulls the locator out of a Playwright error message, when it named one. */
function extractLocator(message: string): string | null {
  const match = message.match(/(getBy\w+\([^)]*\)(?:\.\w+\([^)]*\))*)|locator\('[^']*'\)/);
  return match ? match[0] : null;
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\[[0-9;]*m/g, "");
}

export default class FailureReportReporter implements Reporter {
  private failures: Failure[] = [];
  private rootDir = process.cwd();

  onBegin(config: FullConfig) {
    this.rootDir = config.rootDir ?? process.cwd();
  }

  onTestEnd(test: TestCase, result: TestResult) {
    // Only the verdict matters, not every retry: a test that passed on retry
    // is flaky, which is worth reporting once, not three times.
    if (test.outcome() !== "unexpected" && test.outcome() !== "flaky") return;
    if (result.status === "passed" || result.status === "skipped") return;
    if (this.failures.some((f) => f.title === test.titlePath().join(" › "))) return;

    const message = stripAnsi(result.errors.map((e) => e.message ?? "").join("\n\n")).trim();
    const file = path.relative(this.rootDir, test.location.file);

    this.failures.push({
      title: test.titlePath().filter(Boolean).join(" › "),
      file,
      line: test.location.line,
      project: test.parent.project()?.name ?? "unknown",
      kind: classify(message, file),
      message: message.split("\n").slice(0, 24).join("\n"),
      locator: extractLocator(message),
      artifacts: result.attachments
        .map((a) => a.path)
        .filter((p): p is string => !!p)
        .map((p) => path.relative(this.rootDir, p)),
      retries: result.retry,
    });
  }

  async onEnd(result: FullResult) {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    fs.writeFileSync(
      path.join(OUT_DIR, "failures.json"),
      JSON.stringify(
        { status: result.status, generatedAt: new Date().toISOString(), failures: this.failures },
        null,
        2
      )
    );
    fs.writeFileSync(path.join(OUT_DIR, "FAILURES.md"), this.markdown(result));

    if (this.failures.length > 0) {
      const counts = new Map<FailureKind, number>();
      for (const f of this.failures) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
      const summary = [...counts].map(([k, n]) => `${n} ${k}`).join(", ");
      console.log(`\n${this.failures.length} failure(s) — ${summary}`);
      console.log(`Written to ${OUT_DIR}/FAILURES.md — start there, not from this output.\n`);
    }
  }

  private markdown(result: FullResult): string {
    if (this.failures.length === 0) {
      return `# Failures\n\nNone. Run finished \`${result.status}\`.\n`;
    }

    const kinds = [...new Set(this.failures.map((f) => f.kind))];

    const lines = [
      "# Failures",
      "",
      `Run finished \`${result.status}\` with ${this.failures.length} failure(s).`,
      "",
      "Read the rule for each kind before editing anything. Several of these",
      "say the correct fix is *not* a code change.",
      "",
      "| # | Test | Kind | Where |",
      "| --- | --- | --- | --- |",
      ...this.failures.map(
        (f, i) => `| ${i + 1} | ${f.title} | \`${f.kind}\` | \`${f.file}:${f.line}\` (${f.project}) |`
      ),
      "",
      "## Rules that apply to this run",
      "",
      ...kinds.flatMap((k) => [`### ${k}`, "", GUIDANCE[k], ""]),
      "## Detail",
      "",
    ];

    for (const [i, f] of this.failures.entries()) {
      lines.push(
        `### ${i + 1}. ${f.title}`,
        "",
        `- **Kind**: \`${f.kind}\``,
        `- **Location**: \`${f.file}:${f.line}\` — project \`${f.project}\`${
          f.retries > 0 ? `, failed after ${f.retries} retry/retries` : ""
        }`,
        ...(f.locator ? [`- **Locator blamed**: \`${f.locator}\``] : []),
        ...(f.artifacts.length
          ? [`- **Artifacts**: ${f.artifacts.map((a) => `\`${a}\``).join(", ")}`]
          : []),
        "",
        "```",
        f.message,
        "```",
        ""
      );
    }

    return lines.join("\n");
  }
}
