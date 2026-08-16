# LamBank — feature guide

This is the reference the in-app assistant uses to answer "how do I…" questions.
Keep entries short and point at the exact page/menu name.

## Home
Overview of total cash balance, active cards, and bills due, with quick links into Accounts, Cards, and Bills.

## Accounts
- **Accounts > Cash**: list of cash accounts and balances. Each account has a **type** — Checking (everyday spending), Savings, or Money Market (higher yield, for larger idle balances) — picked when opening the account; a company can hold any mix of these, in any currency.
  - **Interest**: Savings (2% APY) and Money Market (3.5% APY) accounts earn simple daily interest automatically — there's no background worker, so (like Recurring Transfers) it's accrued lazily whenever the account list loads, and posted as its own "Interest earned" transaction. Checking accounts don't earn interest.
  - **Overdraft**: an account Admin can set an **overdraft limit** from Accounts > Cash ("Manage overdraft") — how far that account may go negative before a debit is rejected outright. Crossing from positive into negative charges a flat overdraft fee, posted as its own transaction. Defaults to $0 (no overdraft) for every account.
  - **Monthly statement**: "Monthly statement" on Accounts > Cash opens a printable statement for any month — opening/closing balance, money in/out, and the full transaction list — with a Print / Save as PDF button (browser print, no separate download needed).
- **Accounts > Transactions**: transaction history per account (includes transfers, QR pay, bill payments, drawdowns, and repayments). A transaction that's unusually large relative to that account's recent activity is auto-flagged (⚑) for review — informational only, it's never blocked.

## Payments
- **Transfer**: one page for all outgoing *and* incoming payments. A single row of pills picks the mode — *Internal transfer*, *FX transfer*, *Wire transfer*, or *Receive via QR*:
    - *Internal transfer* — pay another LamBank account, either by typing the recipient's account number or by uploading a photo of their QR code (we decode it automatically). 
    - *FX transfer* — pay a recipient outside the bank in a different currency; shows an estimated converted amount using our mock exchange rates.
    - *Wire transfer* — pay an external bank account via bank name + routing/SWIFT number; carries a flat $25 wire fee.
    - *Receive via QR* — shows your own scannable QR code (with a download button) so someone else can pay you — they upload it on the Internal transfer tab. Optionally request a specific amount + note, which pre-fills automatically for whoever scans it.
    The three "Send" types let you optionally tag the payment with a merchant category (from Settings > Categories) for reporting. Every transfer goes through a **Review** step (confirm the details) and then an **OTP** step before it's sent. The demo OTP code is always `8888`. Only an account Admin (or bank staff) can complete a transfer, and both KYB verification and the account not being frozen are required.
- **Bill Payment**: pay a utility/vendor bill from a cash account. Payments over $1,000 require completed business verification (KYB); smaller ones don't.

## Spend
- **Cards**: virtual or physical cards with a spend limit. Members request a card (needs Admin approval); Admins issue instantly. Admins can freeze/unfreeze or cancel a card. Physical cards require completed KYB. A card's spend limit can't exceed the remaining capacity of the budget it's linked to.
- **Budgets**: a spending limit for a period (monthly/quarterly/annual). Members request a budget (needs Admin approval); Admins create instantly. Admins can **edit the limit** or **freeze/unfreeze** a budget from its detail view — a frozen budget can't have new cards assigned to it. The total of all active/pending budgets can never exceed the cash actually available in the company's accounts (funded via Credit drawdowns).
- **Claims**: expense claims with receipt upload.
  - Upload a receipt (image or PDF) and it's auto-scanned (OCR) to fill in the title and amount — pick the currency from the flag dropdown next to the amount.
  - **Bulk claim** lets you upload up to 20 receipts at once; anything that scans cleanly submits immediately (no manual review step required) — only receipts the scanner couldn't read need you to type in a title/amount.
  - Click the 📎 icon (or the receipt thumbnail while composing) to view the uploaded image full-size.
  - Members' claims go in as a pending request; Admins' claims are approved instantly. Admins (and staff) can approve, reject, or **delete** any claim.
  - The **Receipt library** tab (top of the Claims page) is a reusable library of uploaded receipts — upload once, then pick from it instead of re-uploading when filing a claim.
- **Bills**: vendor bills — track due dates and mark as paid.
- **Policies**: company-wide spend rules, set by an Admin at Spend > Policies.
  - **Card spend limit cap** and **budget amount cap** are hard ceilings — a card or budget can't be created above them at all.
  - **Approval threshold** is a soft rule — a card or budget at or above this amount always goes through the approval queue, even for an Admin or staff member who'd normally skip it.
  - **Claim flag limit** doesn't block anything; it flags expense claims at or above that amount for admin attention (defaults to $500).
  Cards, budgets, and claims all enforce these rules automatically once set. An Admin can also **Reset to defaults** at any time to clear both caps and the approval threshold and put the claim flag limit back to $500 in one action.
  - **Fraud & velocity** (bottom of the same page): an Admin can cap how many transactions (transfers, payments, bill pays) an account may make within a rolling time window — exceeding it blocks the next one outright with a "try again shortly" message. Leave blank for no limit. This is separate from the always-on anomaly flag on Accounts > Transactions, which only flags, never blocks.

## Team
Manage who has access to your company at **Settings > Team**.
- Admins can add or remove members, and promote/demote between Admin and Member.
- A company can have at most **4 Admins** total (the original director plus up to 3 more).
- Members create cards/budgets/claims as *requests*; Admins act instantly and approve/reject Member requests right on the same page.

## Business verification (KYB)
At **Settings > Verification**, a company submits its business profile, beneficial owners, and supporting documents for bank staff to review. Until approved: physical cards are blocked, transfers/payments over $1,000 are capped, and Transfer is disabled entirely. An amber banner reminds the account admin to finish verification whenever it isn't approved yet.

## Credit (lending)
Once KYB is approved, an account Admin signs the lending contract at **Credit**, then can **apply for credit** directly from that same page (amount + optional purpose) — no need to wait on a bank contact. Bank staff can also submit a Credit Apply on a company's behalf from the Operation dashboard if the customer doesn't self-serve.

Either way, the request goes through **maker-checker**, now in two review stages:
- **Maker review** (only for customer-submitted requests) — a staff member sees a **risk snapshot** (recent cash flow, any overdue bills, requested amount vs. average inflow — computed from the company's own data, not a real bureau pull) and forwards the request into the checker queue, or rejects it outright.
- **Checker approval** — a *different* staff member than the maker makes the final call, and sets the **offer**: approved amount, interest rate, and loan term. Nobody can approve or reject their own request.

Once approved, the company sees its **credit limit**, **drawn amount**, and **available credit** at Credit, along with the interest rate/term the checker offered.
- **Drawdown**: before drawing down, the app checks a **conditions precedent** checklist — KYB approved, contract signed, credit line approved, no overdue repayments, and at least one unfrozen cash account — shown to the customer and enforced again server-side. Each drawdown records an optional **purpose** (free text, e.g. "inventory purchase"), snapshots a **maturity date** (today + the offered loan term), and charges a small **drawdown fee** (0.5% of the amount) as a separate debit — the fee is netted out of the cash credited to the account but the full amount still counts against the credit line. This immediately reduces available credit.

  Each drawdown also picks a **repayment method**, which decides how it's paid back:
  - **Revolving** (default): no fixed schedule — repay any amount, any time, against the pooled outstanding balance. This is the original behavior.
  - **Amortizing**: an installment schedule of equal monthly payments (principal + interest, standard EMI math), generated the moment funds are drawn.
  - **Interest-only ("bullet")**: interest paid every month; the full principal is due in one lump sum alongside the final interest payment.
  - **Balloon**: smaller monthly payments (partial principal + interest), with a large final payment covering the remaining balance.

  Amortizing/interest-only/balloon drawdowns can also set a **grace period** (0–6 months) before the first installment is due, and can turn on **auto-deduct** to have installments pulled automatically from a chosen account when due — there's no background worker, so this (like Recurring Transfers) is checked lazily whenever the Credit, Drawdown, or Repayment tab loads. An installment that goes unpaid past its due date is marked **overdue** and picks up a one-time **late fee** (2% of what's owed on it).
- **Repayment**: pay back the outstanding balance from a cash account. For a Revolving drawdown (or when no specific loan is chosen), the whole amount reduces the pooled balance, same as before. For a scheduled drawdown, a repayment can target that specific loan and is applied **waterfall-style** to its unpaid installments, oldest due date first: any late fee owed, then interest, then principal — the resulting fee/interest/principal split is shown back to whoever made the payment. Overpaying a schedule prepays future installments' principal early.
- **Monitoring**: once anything is drawn down, Credit shows a next-payment-due date and flags it as overdue if it's passed with an outstanding balance — visible to the company on their Credit page (which also lets you expand a drawdown to see its full installment schedule) and to staff on the customer's detail page in the Operation dashboard.
Only an account Admin can apply for credit, drawdown, or repay.

## Subscription
Free / Pro / Business plans cap active cards, active budgets, and monthly claims, and give a discount on utility bill payments. Change plans at **Settings > Subscription**.

## Operation dashboard (bank staff only)
Reachable at `/dashboard` via "Admin console" in the top bar for staff accounts.
- **Customers**: every business on the platform; click **Manage** on one to see its full profile, KYB/contract status, credit line, cards, budgets, and claims in one place.
- **Approvals**: review pending card/budget requests and claims across all companies.
- **Business verification**: approve/reject/request more info on KYB submissions.
- **Credit Applications**: create Credit Apply requests (maker) and approve/reject them (checker).
- **Interbank Lending**: LamBank's own treasury/money-market desk — the bank lending its own capital to *other banks*, the reverse direction from Credit (which lends to customer companies). No customer company is involved on either side. Also reachable outside the Operation dashboard, at **Interbank Lending** in the main sidebar (any company Admin, not just staff) — same feature, same global data either way, at `/lending`, split into 3 sub-tabs (Loans / Counterparties / Treasury) just like Credit's Credit/Drawdown/Repayment. On a fresh, empty database, a **Seed demo data (for testing)** button books a handful of sample counterparties and loans (active, settled, defaulted) so there's something to look at.
  - **Counterparties**: a registry of other banks LamBank has a lending relationship with (name, SWIFT code, and a credit limit capping how much can be outstanding to that one bank at a time).
  - **Loans**: book a loan against a counterparty as **Unsecured** (plain call/term money) or **Repo** (also records the collateral held against it, which must cover at least the principal). Standard money-market tenors (overnight through 1 year); interest is simple (ACT/365). A new loan is blocked if it would exceed the counterparty's credit limit or exceed LamBank's own treasury capital.
  - **Settle**: staff manually confirm a counterparty has repaid — there's no auto-settlement (unlike customer auto-deduct), since LamBank can't unilaterally pull money from another bank. Settling before maturity prorates the interest earned to the days actually held; settling on/after maturity earns the full quoted interest.
  - **Mark defaulted**: if a counterparty fails to repay, the loan is written off — the principal doesn't return to the treasury (a realized credit loss).
  - **Treasury**: the bank's own capital book (separate from every customer Account), showing its current balance, total outstanding to counterparties, and a ledger of every loan booked/settled against it.
- **Audit log**: a searchable record of every sensitive action taken across the platform.

## Alerts
At **Settings > Alerts**, an Admin can set custom **Low balance** or **Large transaction** thresholds, per account or across all accounts. Triggered alerts show up in the notification bell alongside the built-in bill/approval reminders — low-balance checks the current balance snapshot, large-transaction checks debits from the last 24 hours. Alerts can be paused or deleted without losing the threshold.

## Developer API
At **Settings > Developer**, a company can integrate with LamBank programmatically:
- **API keys**: create a key (shown once, in full, at creation) to call the public API (`/api/v1/...`) with an `x-api-key` header — currently exposes read-only account and transaction data. Keys can be revoked at any time.
- **Webhooks**: register a URL plus which events to receive (e.g. `transaction.created`, `transfer.completed`, `bill.paid`); each webhook gets its own signing secret (shown once, HMAC-SHA256 over the payload). **Send test** fires a real HTTP request at the endpoint and records the result under **Deliveries** — status code, success/failure, and any error.
Only an account Admin (or staff) can create or revoke keys/webhooks; any team member can view them (masked).

## Not implemented yet
Receivables, Payroll, EOR, Invoices, Payment links, and Customer portal are shown at **More products** (sidebar) as "coming soon" placeholders.
