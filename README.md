# LearnFi Wealth (prototype)

A static wealth-management prototype that turns the core ideas from Khan Academy's free Financial Literacy course into an interactive dashboard. You enter your income, budget, assets, debts and goals, and a built-in advisor ranks what to do next.

## Run it

No build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly also works in most browsers. Everything is stored in your browser's `localStorage`. **Reset sample** restores the demo data.

## What's inside

| Tab | Course concepts |
| --- | --- |
| **Overview** | Net worth, take-home income, savings rate, emergency-fund months, total debt, estimated mortgage, credit score, the 50/30/20 check and the top advice |
| **Monthly Budget** | Copies the paper worksheet: *Month of*, Income, Needs (50%), Wants (30%), Savings (20%) and a Monthly summary, with live targets |
| **Net Worth & Debt** | Assets − liabilities, debt payoff by avalanche or snowball (month-by-month simulation), credit score bands and utilization, and the five score factors |
| **Mortgage** | Payment calculator (P&I, tax, insurance, PMI warning, share of take-home) and the course's year-one rent-vs-buy comparison |
| **Goals & Advisor** | SMART goals with presets (emergency fund, laptop, college, home, retirement, pay off a card), the money-personality quiz, advice filtered by short / medium / long term, and the Miguel vs Jasmine compound-interest chart |

### The advisor

`advise()` in `app.js` is a deterministic rules engine that follows the course's priority order:

1. A working budget (spending ≤ income, 50/30/20 gaps, unassigned dollars)
2. An emergency fund of 3–6 months of needs
3. High-interest and payday debt first, using the avalanche method
4. Credit utilization and score
5. Each SMART goal: the monthly amount required, whether it's feasible within current savings, and where that money should live (cash/HYSA for short term, HYSA/CDs/bonds for medium, diversified index funds in a 401(k)/IRA for long). Each goal type gets its own tips: college cost and financial aid, home affordability, the 401(k) match for retirement, and so on.
6. Investing readiness, inflation drag, insurance and scam awareness, plus a tip matched to your money personality

### Optional: Claude-generated plan

On the Goals & Advisor tab, **Ask Claude** sends an anonymized JSON snapshot of the numbers (no names or account numbers) to the Claude API (`claude-opus-5-5`, streamed) and renders a short personalized plan. It uses the user's own API key, held only in `sessionStorage` for that tab. Calling the API straight from the browser is fine for a prototype. In production, route the call through a backend so the key never reaches the client.

## Files

- `index.html`: layout and tabs
- `styles.css`: bank-style navy/blue theme, worksheet styling, responsive layout
- `app.js`: state, calculations, advisor rules, charts, Claude call

Educational prototype only. Not financial advice.
