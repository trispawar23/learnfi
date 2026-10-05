# LearnFi Wealth (prototype)

Money-management features for a consumer banking app, built on the core ideas from Khan Academy's free Financial Literacy course. Balances and transactions come from the customer's accounts; the app turns them into a budget, net worth, debt plan, goals and ranked advice, with an AI assistant on top.

## Run it

No build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly also works in most browsers. The customer's edits (category changes, manual lines, goals) are stored in `localStorage`. **Reset demo** clears them.

## How it plugs into a banking app

Everything starts from the bank's own data. `data.js` stands in for the bank's account and transaction APIs and returns:

- **accounts**: checking, savings buckets, credit card (limit, APR, minimum), loans, investment and retirement accounts, each with a balance
- **transactions**: date, merchant, amount, account and the bank's category (or none)
- **holdings** for investment and retirement accounts (fund, asset class, value, expense ratio) and the 401(k) contribution and match
- **credit score** and a basic **profile** (age, gross salary)

Swap `LearnFiBank.load()` for real API calls and the rest of the app works unchanged. Users can override a merchant's category and add cash lines; those edits are stored on top of the feed.

## What's inside

| Tab | What the customer gets |
| --- | --- |
| **Overview** | All charts: **Budget check** with Penny the piggy-bank mascot (happy / worried / alarmed) flagging every category that's over its limit or on pace to go over, net worth (own vs owe), monthly income vs needs/wants/savings, 50/30/20 donut, top spending categories, emergency-fund ring, credit-score gauge with utilization, checking balance until payday, investment mix with 401(k) match meter, goal rings, debt payoff bars, and the biggest opportunities in dollars |
| **Activity** | Transactions with editable categories (applies to every charge from that merchant), auto-detected bills and subscriptions with price-increase alerts, spending by category, **AI categorization** for merchants the bank couldn't categorize |
| **Budget** | The paper worksheet (Income, Needs 50%, Wants 30%, Savings 20%, Monthly summary), filled automatically from categorized transactions for any month, with over-limit rows flagged. Editable monthly **spending limits** per category, showing this month and last month against each. Click a row to see its transactions; add cash items by hand |
| **Net Worth & Debt** | Linked assets and liabilities plus manual items (car, debts held elsewhere), avalanche vs snowball payoff using real APRs and minimums, credit score and utilization |
| **Invest** | Holdings from the IRA and 401(k) with expense ratios and yearly cost, current vs target allocation for a suggested risk profile (from years to retirement and money personality) with rebalancing steps, 401(k) match check, retirement projection with and without the full match, high-fee and single-stock concentration flags, and the compound-growth story |
| **Mortgage** | Payment calculator and the course's rent-vs-buy comparison, using the rent detected in checking |
| **Goals & Advisor** | SMART goals linked to savings accounts (progress updates with the balance), presets for emergency fund, laptop, college, home, retirement and card payoff, the money-personality quiz, and ranked advice filtered by short, medium or long term |
| **Advisors** | "Do you need an advisor?" recommendation built from the accounts, advice types and costs (DIY, robo, hybrid, fee-only, AUM, commission), a fee-drag calculator, questions to ask any advisor, and a demo booking flow with consent to share a summary plus **AI meeting-prep notes** |
| **Assistant** | AI chat that reads balances, ~3 months of transactions, budget, bills and goals, and answers questions like "Which subscriptions should I cut?" or "Can I afford a $2,000 laptop by March?" |

### The advisor (rules)

`advise()` in `app.js` follows the course's priority order using real account data: cash flow (overspending, low checking before payday), categories over their limits this month and last, emergency fund (with ETA from the actual savings transfer), high-interest debt and card interest actually paid, credit utilization and score, the 50/30/20 split, spending trends versus the prior two months, subscription price increases, uncategorized spending, goal feasibility and where each goal's money should live, investing readiness, 401(k) match, fund fees, concentration and allocation drift, when to consider an advisor, insurance and scam awareness. Many items have a one-click follow-up that opens the right tab or asks the assistant.

### AI

`aiComplete()` is the single AI entry point, used by the Assistant, AI categorization and advisor meeting prep. Inside claude.ai the published page uses the platform's built-in Claude access. Run locally, it calls the Claude API with the `@anthropic-ai/sdk` package and a key the user pastes on the Assistant tab. That is fine for a prototype; in production the bank's backend makes this call so no key reaches the browser.

## Files

- `index.html`: layout and tabs
- `styles.css`: bank-style navy/blue theme, worksheet styling, responsive layout
- `data.js`: demo bank feed (accounts and ~3 months of transactions)
- `app.js`: categorization, budget, recurring-bill detection, advisor rules, charts, AI assistant

Educational prototype only. Not financial advice.
