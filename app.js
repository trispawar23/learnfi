// LearnFi Wealth: a static prototype. All state lives in this browser (localStorage).
// The advisor is a deterministic rules engine built from the course's framework;
// "Ask Claude" is an optional, user-keyed call for a narrative plan.

const STORE_KEY = "learnfi.v1";
const SAVINGS_GROWTH = { short: 0.0, medium: 0.04, long: 0.07 }; // cash, HYSA/CD, diversified index
const INFLATION = 0.03;

// ---------------------------------------------------------------- sample data
// Budget numbers match the course's worked example ($3,000 take-home: needs 59%, wants 27%, savings 14%).
const uid = () => Math.random().toString(36).slice(2, 9);
const line = (name, amount) => ({ id: uid(), name, amount });

function sampleState() {
  const now = new Date();
  return {
    name: "Alex",
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    budget: {
      income: [line("Paycheck", 2700), line("Side income", 300)],
      needs: [
        line("Rent", 1100), line("Utilities", 120), line("Cell phone", 60), line("Home internet", 60),
        line("Car payment", 250), line("Car insurance", 90), line("Groceries", 100),
      ],
      wants: [
        line("Eating out", 300), line("Streaming", 45), line("Movies & events", 150),
        line("Shopping", 200), line("Gym", 100),
      ],
      savings: [line("Emergency fund", 200), line("Retirement (401k)", 150), line("New laptop", 75)],
    },
    assets: [
      { id: uid(), name: "Checking account", type: "cash", value: 2500 },
      { id: uid(), name: "High-yield savings (emergency)", type: "emergency", value: 3000 },
      { id: uid(), name: "401(k)", type: "retirement", value: 12000 },
      { id: uid(), name: "Car", type: "vehicle", value: 14000 },
    ],
    debts: [
      { id: uid(), name: "Credit card", type: "card", balance: 2400, apr: 24.99, min: 75 },
      { id: uid(), name: "Car loan", type: "auto", balance: 9000, apr: 7.5, min: 250 },
      { id: uid(), name: "Student loan", type: "student", balance: 18000, apr: 5.5, min: 200 },
    ],
    payoffMethod: "avalanche",
    extraDebt: 100,
    credit: { score: 680, limit: 6000 },
    home: { price: 400000, down: 100000, rate: 6, term: 30, taxPct: 1, upkeep: 2000, insurance: 1200, marginal: 33, rent: 1500, altReturn: 2 },
    goals: [
      { id: uid(), name: "Emergency fund: 3 months of needs", kind: "emergency", target: 5340, saved: 3000, years: 1 },
      { id: uid(), name: "New laptop", kind: "purchase", target: 2000, saved: 300, years: 0.25 },
    ],
    quiz: {},
    horizon: "all",
  };
}

let state = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...sampleState(), ...JSON.parse(raw) };
  } catch { /* storage unavailable: fall through to sample */ }
  return sampleState();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money = (n) => usd.format(Math.round(n || 0));
const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const pct = (n, d = 0) => `${(n * 100).toFixed(d)}%`;
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const sum = (arr, key = "amount") => arr.reduce((a, x) => a + num(x[key]), 0);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const horizonOf = (years) => (years <= 1 ? "short" : years <= 5 ? "medium" : "long");

const ASSET_TYPES = { cash: "Cash & checking", emergency: "Emergency savings", investment: "Investments", retirement: "Retirement", property: "Home / property", vehicle: "Vehicle", other: "Other" };
const DEBT_TYPES = { card: "Credit card", student: "Student loan", auto: "Car loan", mortgage: "Mortgage", personal: "Personal loan", payday: "Payday loan", other: "Other" };

// ---------------------------------------------------------------- calculations
function totals() {
  const b = state.budget;
  const income = sum(b.income), needs = sum(b.needs), wants = sum(b.wants), savings = sum(b.savings);
  return { income, needs, wants, savings, left: income - needs - wants - savings };
}

function balanceSheet() {
  const assets = sum(state.assets, "value");
  const debts = sum(state.debts, "balance");
  const emergency = state.assets.filter((a) => a.type === "emergency").reduce((s, a) => s + num(a.value), 0);
  const cash = state.assets.filter((a) => a.type === "cash").reduce((s, a) => s + num(a.value), 0);
  const cardDebt = state.debts.filter((d) => d.type === "card").reduce((s, d) => s + num(d.balance), 0);
  return { assets, debts, net: assets - debts, emergency, cash, cardDebt };
}

function amortPayment(principal, annualRate, years) {
  const r = annualRate / 100 / 12, n = years * 12;
  if (principal <= 0) return 0;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

function mortgage() {
  const h = state.home;
  const loan = Math.max(0, num(h.price) - num(h.down));
  const pmt = amortPayment(loan, num(h.rate), num(h.term));
  // first-year interest from the actual amortization schedule
  let bal = loan, interest = 0;
  const r = num(h.rate) / 100 / 12;
  for (let m = 0; m < 12 && bal > 0; m++) { const i = bal * r; interest += i; bal -= pmt - i; }
  const propTax = (num(h.price) * num(h.taxPct)) / 100;
  const monthlyAll = pmt + (propTax + num(h.insurance)) / 12;
  const totalInterest = pmt * num(h.term) * 12 - loan;
  const downPct = num(h.price) > 0 ? num(h.down) / num(h.price) : 0;
  // rent vs buy (year one, unrecoverable costs only, as in the course example)
  const interestAfterTax = interest * (1 - num(h.marginal) / 100);
  const buyCost = interestAfterTax + propTax + num(h.upkeep) + num(h.insurance);
  const forgone = (num(h.down) * num(h.altReturn)) / 100;
  const rentCost = num(h.rent) * 12 - forgone;
  return { loan, pmt, interest, interestAfterTax, propTax, monthlyAll, totalInterest, downPct, buyCost, rentCost, forgone };
}

// Month-by-month payoff simulation; mortgages are excluded (long-term, low-rate, tax-advantaged).
function payoffPlan(method = state.payoffMethod, extra = num(state.extraDebt)) {
  const debts = state.debts.filter((d) => d.type !== "mortgage" && num(d.balance) > 0)
    .map((d) => ({ ...d, bal: num(d.balance), r: num(d.apr) / 100 / 12, min: Math.max(num(d.min), 1) }));
  if (!debts.length) return null;
  const order = [...debts].sort((a, b) => method === "avalanche" ? b.apr - a.apr || a.bal - b.bal : a.bal - b.bal || b.apr - a.apr);
  const budget = debts.reduce((s, d) => s + d.min, 0) + extra;
  let month = 0, interestPaid = 0;
  const paidOff = [];
  while (debts.some((d) => d.bal > 0.005) && month < 600) {
    month++;
    debts.forEach((d) => { if (d.bal > 0) { const i = d.bal * d.r; d.bal += i; interestPaid += i; } });
    let pool = budget;
    debts.forEach((d) => { if (d.bal > 0) { const p = Math.min(d.min, d.bal); d.bal -= p; pool -= p; } });
    for (const t of order) {
      const d = debts.find((x) => x.id === t.id);
      if (d.bal > 0 && pool > 0) { const p = Math.min(pool, d.bal); d.bal -= p; pool -= p; }
    }
    debts.forEach((d) => { if (d.bal <= 0.005 && !paidOff.find((p) => p.id === d.id)) { d.bal = 0; paidOff.push({ id: d.id, name: d.name, month }); } });
  }
  const stuck = month >= 600;
  return { months: month, interestPaid, order: order.map((d) => d.name), paidOff, budget, stuck };
}

function futureValue(monthly, years, rate, start = 0) {
  const r = rate / 12, n = Math.round(years * 12);
  if (r === 0) return start + monthly * n;
  return start * Math.pow(1 + r, n) + monthly * ((Math.pow(1 + r, n) - 1) / r);
}
function requiredMonthly(target, saved, years, rate) {
  const n = Math.max(1, Math.round(years * 12)), r = rate / 12;
  const gap = target - saved * Math.pow(1 + r, n);
  if (gap <= 0) return 0;
  return r === 0 ? gap / n : (gap * r) / (Math.pow(1 + r, n) - 1);
}

// ---------------------------------------------------------------- money personality quiz
const QUIZ = [
  { q: "You get an unexpected $500. You…", a: ["Spend it on something fun right away", "Save most of it, treat yourself a little", "Put all of it in savings", "Invest it to grow"] },
  { q: "How do you feel about tracking your spending?", a: ["I rarely do it", "I check in now and then", "I track every dollar", "I track it to find money to invest"] },
  { q: "A friend pitches a new investment opportunity. You…", a: ["Join in if it sounds exciting", "Research it carefully, then maybe", "Pass, too risky", "Jump in if the upside is big"] },
  { q: "Your approach to big purchases:", a: ["Buy now, figure it out later", "Plan and save for a while first", "Avoid them as much as possible", "Only if it grows in value"] },
  { q: "When you think about the future, you feel…", a: ["I'd rather enjoy today", "A bit anxious, but planning", "Secure, because I've saved a lot", "Excited about growing wealth"] },
];
// Answers run spender -> balancer -> saver -> investor; points land each pure profile in the course's score bands.
const QUIZ_POINTS = [1, 2, 3, 5];
const PERSONALITIES = [
  { min: 5, max: 9, key: "spender", name: "Spender", desc: "You enjoy money in the moment. Watch for impulse buys and debt.", tips: ["Automate savings on payday, before you can spend it", "Use a 48-hour rule for non-essential purchases", "Track wants weekly against your 30%"] },
  { min: 10, max: 14, key: "balancer", name: "Balancer", desc: "You manage money well but can get stuck being cautious or indecisive.", tips: ["Treat yourself occasionally; it's in the plan", "Stay open to new money-making opportunities", "Seek advice, but trust your instincts"] },
  { min: 15, max: 19, key: "saver", name: "Saver", desc: "You're excellent at saving, but you can be too frugal or rigid.", tips: ["Budget guilt-free money for wants", "Cash above 6 months of needs loses value to inflation; put it to work", "Celebrate your progress"] },
  { min: 20, max: 25, key: "investor", name: "Investor", desc: "You're strategic and risk-tolerant, but you can be over-optimistic and skip the basics.", tips: ["Keep the emergency fund topped up before taking risk", "Diversify; don't concentrate in single stocks or crypto", "Review risk annually"] },
];
function personality() {
  const answers = Object.values(state.quiz);
  if (answers.length < QUIZ.length) return null;
  const score = answers.reduce((s, i) => s + QUIZ_POINTS[i], 0);
  return { score, ...PERSONALITIES.find((p) => score >= p.min && score <= p.max) };
}

// ---------------------------------------------------------------- advisor (rules engine)
// Each item: { title, body, why, priority: "high"|"med"|"low"|"good", horizons: [...], tag }
function advise() {
  const t = totals(), bs = balanceSheet(), m = mortgage(), out = [];
  const add = (o) => out.push({ horizons: ["short", "medium", "long"], ...o });
  const persona = personality();

  if (t.income <= 0) {
    add({ priority: "high", tag: "Budget", title: "Start with your income", body: "Enter your after-tax paychecks and side income on the Monthly Budget tab. Every other recommendation depends on it." , why: "A budget is the foundation; investing comes after." });
    return rank(out);
  }

  const spent = t.needs + t.wants;
  if (spent > t.income) {
    add({ priority: "high", tag: "Budget", title: `You're spending ${money(spent - t.income)} more than you earn each month`, body: "Cut wants first, then look at needs (see below). Overspending usually ends up on a credit card at 20–30% APR.", why: "Spending more than you earn is how bad debt starts." });
  }

  const payday = state.debts.filter((d) => d.type === "payday" && num(d.balance) > 0);
  if (payday.length) {
    add({ priority: "high", tag: "Debt", title: "Get out of payday loans first", body: "Payday loans can run 300–800% APR. Ask a credit union about a small personal loan to refinance, and stop rolling it over.", why: "This is the most expensive debt there is." });
  }

  // Emergency fund: 3–6 months of needs
  const monthsCovered = t.needs > 0 ? bs.emergency / t.needs : 0;
  const efGoal3 = t.needs * 3, efGoal6 = t.needs * 6;
  if (monthsCovered < 1) {
    add({ priority: "high", tag: "Emergency fund", horizons: ["short"], title: "Build a starter emergency fund", body: `Aim for 1 month of needs (${money(t.needs)}) as fast as you can, then grow it to 3 months (${money(efGoal3)}). Keep it in a separate high-yield savings account and don't touch it.`, why: "Layoffs, medical bills and car repairs happen. Without a buffer they go on a credit card." });
  } else if (monthsCovered < 3) {
    const gap = efGoal3 - bs.emergency;
    const perMonth = Math.max(0, num(state.budget.savings.find((s) => /emergency/i.test(s.name))?.amount));
    const eta = perMonth > 0 ? ` At ${money(perMonth)}/mo you'll get there in about ${Math.ceil(gap / perMonth)} months.` : "";
    add({ priority: "med", tag: "Emergency fund", horizons: ["short"], title: `Emergency fund covers ${monthsCovered.toFixed(1)} months; target is 3–6`, body: `You need ${money(gap)} more to reach 3 months (${money(efGoal3)}).${eta}`, why: "The course puts the emergency fund first in the savings order." });
  } else if (monthsCovered <= 6.5) {
    add({ priority: "good", tag: "Emergency fund", horizons: ["short"], title: `Emergency fund is solid at ${monthsCovered.toFixed(1)} months`, body: "You can now point more of your savings at goals and investing.", why: "You're inside the recommended 3–6 month range." });
  } else {
    add({ priority: "low", tag: "Inflation", horizons: ["medium", "long"], title: `${money(bs.emergency - efGoal6)} above a 6-month cushion is losing to inflation`, body: `At ~${pct(INFLATION)} inflation, cash earning less than that shrinks in real terms. Consider CDs for medium-term goals or diversified index funds for long-term ones.`, why: "Doing nothing with money means slowly losing it." });
  }

  // High-interest debt
  const hi = state.debts.filter((d) => d.type !== "mortgage" && num(d.apr) >= 10 && num(d.balance) > 0).sort((a, b) => b.apr - a.apr);
  if (hi.length) {
    const plan = payoffPlan("avalanche");
    const snow = payoffPlan("snowball");
    const saved = snow && plan ? snow.interestPaid - plan.interestPaid : 0;
    add({ priority: "high", tag: "Debt", horizons: ["short", "medium"], title: `Pay down ${hi[0].name} (${num(hi[0].apr)}% APR) aggressively`, body: plan && !plan.stuck
      ? `Paying ${money(plan.budget)}/mo using the avalanche method clears all non-mortgage debt in ${fmtMonths(plan.months)} with ${money(plan.interestPaid)} in interest${saved > 1 ? `, ${money(saved)} less than snowball` : ""}. Pay credit cards in full each month after that.`
      : "Your current payments don't cover the interest. Raise the monthly amount on the Net Worth & Debt tab.", why: "Paying off a 25% APR card is a guaranteed 25% return, which no investment matches." });
  }

  // Credit
  const limit = num(state.credit.limit), score = num(state.credit.score);
  const util = limit > 0 ? bs.cardDebt / limit : 0;
  if (limit > 0 && util > 0.3) {
    add({ priority: "med", tag: "Credit", horizons: ["short"], title: `Credit utilization is ${pct(util)}; get it under 30%, ideally under 10%`, body: `Paying cards down to ${money(limit * 0.3)} or less helps fastest. Utilization is 30% of your score.`, why: "It's the second-biggest score factor after payment history." });
  } else if (limit > 0 && util > 0.1) {
    add({ priority: "low", tag: "Credit", horizons: ["short"], title: `Utilization at ${pct(util)}: good, under 10% is better`, body: "Paying the statement balance in full before the due date keeps reported utilization low.", why: "Utilization is 30% of your score." });
  }
  if (score && score < 600) {
    add({ priority: "high", tag: "Credit", horizons: ["short", "medium"], title: `Credit score ${score} will make loans expensive or impossible`, body: "Set every bill to autopay (payment history is 35% of your score), keep balances low, and avoid opening several cards at once (hard inquiries).", why: "Below 600 often means denial or very high rates." });
  } else if (score && score < 700) {
    add({ priority: "low", tag: "Credit", horizons: ["medium"], title: `Push your ${score} score into the 700s before a big loan`, body: "On-time payments, low utilization and keeping old accounts open make the difference. A car loan or mortgage in the high 700s costs much less.", why: "600–700 is decent but means higher interest rates." });
  }

  // 50/30/20
  const needsPct = t.needs / t.income, wantsPct = t.wants / t.income, savePct = t.savings / t.income;
  if (needsPct > 0.5) {
    const biggest = [...state.budget.needs].sort((a, b) => num(b.amount) - num(a.amount)).slice(0, 2).map((x) => x.name).join(" and ");
    add({ priority: "med", tag: "Budget", horizons: ["short"], title: `Needs are ${pct(needsPct)} of income (target 50%)`, body: `Trim ${money(t.needs - t.income * 0.5)}/mo. Your biggest needs are ${biggest}. Call your phone, internet and utility providers and ask for a cheaper plan (they'd rather keep you), compare grocery prices per unit, and consider a smaller place when your lease ends.`, why: "Lower fixed costs free money for every goal." });
  }
  if (wantsPct > 0.3) {
    add({ priority: "med", tag: "Budget", horizons: ["short"], title: `Wants are ${pct(wantsPct)} of income (target 30%)`, body: `Bringing them to ${money(t.income * 0.3)} frees ${money(t.wants - t.income * 0.3)}/mo for savings.`, why: "The 50/30/20 rule is a starting point you can adjust to your situation." });
  }
  if (savePct < 0.2) {
    add({ priority: "med", tag: "Savings", horizons: ["short", "medium", "long"], title: `Saving ${pct(savePct, 1)} of income; target is 20% (${money(t.income * 0.2)})`, body: `Close the ${money(t.income * 0.2 - t.savings)}/mo gap. Automate a transfer on payday and open separate savings "buckets" for each goal.`, why: "Savings fund your emergency cushion, big purchases and retirement." });
  } else {
    add({ priority: "good", tag: "Savings", title: `You're saving ${pct(savePct, 1)} of income`, body: "That meets the 20% target. Make sure each dollar has a goal attached below.", why: "Savings rate matters most early on." });
  }
  if (t.left > 1) {
    add({ priority: "low", tag: "Budget", horizons: ["short"], title: `${money(t.left)}/mo is unassigned`, body: "Give every dollar a job: put it toward a goal, extra debt payments, or the emergency fund.", why: "Money without a plan tends to get spent." });
  }

  // Goals
  const monthlySavingsPool = t.savings;
  let goalNeed = 0;
  for (const g of state.goals) {
    const h = horizonOf(num(g.years));
    const rate = g.kind === "emergency" ? 0 : SAVINGS_GROWTH[h];
    const need = requiredMonthly(num(g.target), num(g.saved), num(g.years), rate);
    goalNeed += need;
    add(goalAdvice(g, h, need, rate, t, m, monthsCovered));
  }
  if (state.goals.length && goalNeed > monthlySavingsPool + Math.max(0, t.left)) {
    add({ priority: "high", tag: "Goals", horizons: ["short", "medium", "long"], title: `Your goals need ${money(goalNeed)}/mo but you're saving ${money(monthlySavingsPool)}`, body: "Something has to give: extend a deadline, lower a target, or free up money from wants. Rank goals by order: emergency fund, high-interest debt, then everything else.", why: "A SMART goal must be achievable and realistic." });
  }

  // Investing readiness
  if (!hi.length && monthsCovered >= 3) {
    add({ priority: "low", tag: "Investing", horizons: ["long"], title: "You're ready to invest for the long term", body: "Diversify, for example with a broad index fund like the S&P 500, which has historically returned ~10%/yr (6–7% after inflation). Use tax-advantaged accounts first: get the full 401(k) match, then an IRA or Roth IRA.", why: "Basics are covered: budget, emergency fund, no high-interest debt." });
  } else {
    add({ priority: "low", tag: "Investing", horizons: ["long"], title: "Hold off on risky investing until the basics are done", body: "Finish the emergency fund and pay off high-interest debt first, but still take any employer 401(k) match because it's free money.", why: "Investing without a foundation is like building a house on sand." });
  }

  // Mortgage affordability, if they hold a mortgage
  const mortgageDebt = state.debts.find((d) => d.type === "mortgage" && num(d.balance) > 0);
  if (mortgageDebt && num(mortgageDebt.min) / t.income > 0.35) {
    add({ priority: "med", tag: "Home", horizons: ["medium", "long"], title: `Mortgage payment is ${pct(num(mortgageDebt.min) / t.income)} of take-home pay`, body: "Above ~35% leaves little room for saving. Consider refinancing if rates have dropped, but count the fees.", why: "Housing is usually the largest need." });
  }

  // Personality nudge
  if (persona) {
    add({ priority: "low", tag: `${persona.name} tip`, title: persona.tips[0], body: persona.desc, why: `From your money-personality score of ${persona.score}.` });
  }

  add({ priority: "low", tag: "Protection", horizons: ["short", "long"], title: "Check your insurance before you need it", body: "Health, renters or home, auto and, if anyone depends on you, life insurance move big risks off your balance sheet. Know your deductibles and co-pays.", why: "The best time to buy insurance is before something happens." });
  add({ priority: "low", tag: "Scams", horizons: ["short", "medium", "long"], title: "If it sounds too good to be true, it is", body: "Guaranteed high returns, urgency and requests for your SSN or passwords are red flags. Slow down and ask questions before moving money.", why: "Scammers target emotion, and AI makes them more convincing." });

  return rank(out);
}

function goalAdvice(g, h, need, rate, t, m, efMonths) {
  const label = { short: "short-term", medium: "medium-term", long: "long-term" }[h];
  const vehicle = {
    short: "a high-yield savings account (keep it liquid and safe)",
    medium: "a high-yield savings account or CDs with fixed terms, plus some bonds for the later years",
    long: "diversified, low-cost index funds in tax-advantaged accounts",
  }[h];
  const share = t.savings > 0 ? need / t.savings : Infinity;
  const priority = need === 0 ? "good" : share > 1 ? "high" : share > 0.6 ? "med" : "low";
  const base = need === 0
    ? `You're on track: what you've saved already covers ${money(num(g.target))}.`
    : `Set aside ${money(need)}/mo for ${fmtMonths(Math.round(num(g.years) * 12))}${rate ? ` (assuming ~${pct(rate)}/yr growth)` : ""}. That's ${Number.isFinite(share) ? pct(share) : "more than all"} of your current monthly savings.`;
  const extra = {
    emergency: " Keep it in a separate account you don't see every day.",
    purchase: " Open a dedicated savings bucket and automate the transfer on payday. Don't finance it on a credit card.",
    college: ` Look at the full cost (tuition, books, fees, housing, transport), not just the sticker price. Apply for grants and scholarships before taking loans, and talk to graduates of the program about real job outcomes. For grad school, count the salary you won't earn while studying.${h !== "short" ? " In the US, a 529 plan grows tax-free for education." : ""}`,
    home: ` On the Mortgage tab, this price means about ${money(m.monthlyAll)}/mo with taxes and insurance${t.income ? ` (${pct(m.monthlyAll / t.income)} of take-home)` : ""}. Run rent vs buy before you commit. 20% down avoids PMI.`,
    retirement: " Start now; time matters more than the amount. Take the full employer 401(k) match first, then consider an IRA or Roth IRA. Raise contributions by 1% each year.",
    debt: " Use the avalanche method on the Net Worth & Debt tab and pay cards in full afterward.",
  }[g.kind] || "";
  const efWarn = g.kind !== "emergency" && efMonths < 3 && h !== "long" ? " Fund your emergency cushion alongside this one." : "";
  return {
    priority, tag: `${label} goal`, horizons: [h],
    title: `${g.name}: ${money(num(g.target))} in ${fmtYears(num(g.years))}`,
    body: base + extra + efWarn,
    why: `Best home for ${label} money: ${vehicle}.`,
  };
}

const PRIORITY_ORDER = { high: 0, med: 1, low: 2, good: 3 };
function rank(list) { return list.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]); }
function fmtMonths(n) { if (n < 12) return `${n} month${n === 1 ? "" : "s"}`; const y = Math.floor(n / 12), r = n % 12; return `${y} yr${y > 1 ? "s" : ""}${r ? ` ${r} mo` : ""}`; }
function fmtYears(y) { return y < 1 ? fmtMonths(Math.round(y * 12)) : `${+y.toFixed(2)} yr${y === 1 ? "" : "s"}`; }

function renderAdvice(el, items, limit) {
  const list = limit ? items.slice(0, limit) : items;
  const pClass = { high: "p-high", med: "p-med", low: "", good: "p-good" };
  const pText = { high: "Act now", med: "Next", low: "Tip", good: "On track" };
  el.innerHTML = list.map((a) => `
    <li class="${pClass[a.priority]}">
      <div>
        <h3>${esc(a.title)} <span class="pill">${esc(a.tag)}</span> <span class="status ${a.priority === "high" ? "bad" : a.priority === "med" ? "warn" : a.priority === "good" ? "good" : ""}">${pText[a.priority]}</span></h3>
        <p>${esc(a.body)}</p>
        <p class="why">Why: ${esc(a.why)}</p>
      </div>
    </li>`).join("") || `<li><div><p>Nothing to flag. Add goals to get tailored steps.</p></div></li>`;
}

// ---------------------------------------------------------------- tooltip
const tip = $("#tooltip");
function showTip(html, x, y) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
  tip.style.top = `${Math.max(8, y - h - 12)}px`;
}
function hideTip() { tip.hidden = true; }

// ---------------------------------------------------------------- charts
function renderSplitChart() {
  const t = totals(), el = $("#splitChart");
  const rows = [
    { key: "needs", label: "Needs", color: "var(--s-needs)", v: t.needs, target: 0.5 },
    { key: "wants", label: "Wants", color: "var(--s-wants)", v: t.wants, target: 0.3 },
    { key: "savings", label: "Savings", color: "var(--s-savings)", v: t.savings, target: 0.2 },
  ];
  const W = 520, rowH = 44, padL = 70, padR = 110, H = rows.length * rowH + 26;
  const maxPct = Math.max(0.6, ...rows.map((r) => (t.income ? r.v / t.income : 0))) * 1.05;
  const x = (p) => padL + (p / maxPct) * (W - padL - padR);
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].filter((p) => p <= maxPct);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Needs, wants and savings as a share of income compared with 50/30/20 targets">`;
  ticks.forEach((p) => { svg += `<line class="grid-line" x1="${x(p)}" x2="${x(p)}" y1="0" y2="${H - 22}"/><text class="axis-label" x="${x(p)}" y="${H - 6}" text-anchor="middle">${pct(p)}</text>`; });
  rows.forEach((r, i) => {
    const share = t.income ? r.v / t.income : 0;
    const y = i * rowH + 10, bh = 20;
    const w = Math.max(0, x(share) - padL);
    // bar anchored at baseline: square start, 4px rounded data end
    svg += `<text x="${padL - 10}" y="${y + bh / 2 + 4}" text-anchor="end" style="fill:var(--ink);font-weight:600">${r.label}</text>`;
    svg += `<path d="${barPath(padL, y, w, bh, 4)}" fill="${r.color}"/>`;
    svg += `<line class="target-tick" x1="${x(r.target)}" x2="${x(r.target)}" y1="${y - 4}" y2="${y + bh + 4}"/>`;
    svg += `<text x="${Math.max(x(share), x(r.target)) + 8}" y="${y + bh / 2 + 4}" style="fill:var(--ink)">${pct(share)} · ${money(r.v)}</text>`;
    svg += `<rect x="0" y="${y - 6}" width="${W}" height="${bh + 12}" fill="transparent" data-row="${i}"/>`;
  });
  svg += `</svg>`;
  el.className = "chart";
  el.innerHTML = `<div class="legend"><span><i class="tick"></i>Target (50 / 30 / 20)</span></div>${svg}`;
  $$("rect[data-row]", el).forEach((hit) => {
    const r = rows[+hit.dataset.row], share = t.income ? r.v / t.income : 0, diff = r.v - r.target * t.income;
    const html = `<strong>${r.label}</strong><br>Actual <b>${money(r.v)}</b> (${pct(share, 1)})<br>Target <b>${money(r.target * t.income)}</b> (${pct(r.target)})<br>${diff >= 0 ? "Over" : "Under"} by <b>${money(Math.abs(diff))}</b>`;
    hit.addEventListener("mousemove", (e) => showTip(html, e.clientX, e.clientY));
    hit.addEventListener("mouseleave", hideTip);
  });
}
function barPath(x, y, w, h, r) {
  if (w <= 0) return "";
  r = Math.min(r, w, h / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}

function renderCompoundChart() {
  const el = $("#compoundChart"), rate = 0.07, years = 40;
  const miguel = [], jasmine = [];
  for (let yr = 0; yr <= years; yr++) {
    miguel.push(futureValue(25, yr, rate));
    jasmine.push(yr <= 10 ? 0 : futureValue(50, yr - 10, rate));
  }
  const series = [
    { name: "Miguel: $25/mo from year 0", color: "var(--s-needs)", data: miguel, contrib: (y) => 25 * 12 * y },
    { name: "Jasmine: $50/mo from year 10", color: "var(--s-wants)", data: jasmine, contrib: (y) => Math.max(0, y - 10) * 50 * 12 },
  ];
  const W = 760, H = 280, padL = 56, padR = 130, padT = 12, padB = 30;
  const step = Math.ceil(Math.max(...miguel, ...jasmine) / 4 / 10000) * 10000, maxY = step * 4;
  const x = (yr) => padL + (yr / years) * (W - padL - padR);
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Balance over 40 years for two savers">`;
  for (let v = 0; v <= maxY; v += step) svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${compactUsd.format(v)}</text>`;
  for (let yr = 0; yr <= years; yr += 10) svg += `<text class="axis-label" x="${x(yr)}" y="${H - 8}" text-anchor="middle">Yr ${yr}</text>`;
  series.forEach((s) => {
    const d = s.data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    const last = s.data[years];
    svg += `<text x="${x(years) + 8}" y="${y(last) + (s === series[0] ? -4 : 12)}" style="fill:var(--ink);font-weight:600">${money(last)}</text>`;
  });
  svg += `<line id="xhair" class="grid-line" x1="0" x2="0" y1="${padT}" y2="${H - padB}" style="stroke:var(--ink-2);visibility:hidden"/>`;
  series.forEach((s, i) => { svg += `<circle id="dot${i}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2" style="visibility:hidden"/>`; });
  svg += `<rect id="hit" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent"/></svg>`;
  el.className = "chart";
  el.innerHTML = `<div class="legend">${series.map((s) => `<span><i class="line" style="background:${s.color}"></i>${s.name}</span>`).join("")}</div>${svg}
    <p class="muted small">Miguel puts in ${money(25 * 12 * 40)} in total and Jasmine ${money(50 * 12 * 30)}, yet Miguel ends with more because his first 10 years keep compounding.</p>`;
  const svgEl = $("svg", el), hit = $("#hit", el), xh = $("#xhair", el);
  hit.addEventListener("mousemove", (e) => {
    const pt = svgEl.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svgEl.getScreenCTM().inverse());
    const yr = Math.max(0, Math.min(years, Math.round(((p.x - padL) / (W - padL - padR)) * years)));
    xh.setAttribute("x1", x(yr)); xh.setAttribute("x2", x(yr)); xh.style.visibility = "visible";
    series.forEach((s, i) => { const c = $(`#dot${i}`, el); c.setAttribute("cx", x(yr)); c.setAttribute("cy", y(s.data[yr])); c.style.visibility = "visible"; });
    showTip(`<strong>Year ${yr}</strong><br>${series.map((s) => `${s.name.split(":")[0]}: <b>${money(s.data[yr])}</b> <span style="opacity:.75">(put in ${money(s.contrib(yr))})</span>`).join("<br>")}`, e.clientX, e.clientY);
  });
  hit.addEventListener("mouseleave", () => { hideTip(); xh.style.visibility = "hidden"; series.forEach((_, i) => { $(`#dot${i}`, el).style.visibility = "hidden"; }); });
}

function renderCreditGauge() {
  const score = num(state.credit.score), el = $("#creditGauge");
  const band = score >= 740 ? ["good", "Very good: you qualify for most loans at the best rates"] : score >= 700 ? ["good", "Good"] : score >= 600 ? ["warn", "Decent: expect somewhat higher interest rates"] : score >= 300 ? ["bad", "Poor: loans may be denied or very expensive"] : ["", ""];
  const t = (Math.min(850, Math.max(300, score)) - 300) / 550;
  const util = num(state.credit.limit) > 0 ? balanceSheet().cardDebt / num(state.credit.limit) : 0;
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted)"><span>300</span><span>600</span><span>700</span><span>850</span></div>
    <div class="bar" style="height:10px;position:relative;background:linear-gradient(90deg,var(--gauge-bad) 0 54.5%,var(--gauge-mid) 54.5% 72.7%,var(--gauge-good) 72.7%)">
      <span style="position:absolute;left:calc(${(t * 100).toFixed(1)}% - 2px);width:4px;top:-4px;height:18px;background:var(--ink);border-radius:2px"></span>
    </div>
    <p style="margin:10px 0 4px"><span class="status ${band[0]}">${score || "–"} · ${band[1]}</span></p>
    <p class="small" style="margin:0">Card utilization: <strong>${pct(util)}</strong> of ${money(state.credit.limit)} limit <span class="status ${util > 0.3 ? "bad" : util > 0.1 ? "warn" : "good"}">${util > 0.3 ? "High" : util > 0.1 ? "OK" : "Great"}</span></p>`;
}

// ---------------------------------------------------------------- budget sheet
const GROUPS = ["income", "needs", "wants", "savings"];
function renderBudgetTables() {
  $("#budgetMonth").value = state.month;
  GROUPS.forEach((g) => {
    const tbody = $(`[data-group="${g}"] tbody`);
    tbody.innerHTML = state.budget[g].map((l) => `
      <tr data-id="${l.id}">
        <td><input aria-label="${g} item name" data-field="name" value="${esc(l.name)}" placeholder="Item"/></td>
        <td><input aria-label="${g} amount" data-field="amount" type="number" min="0" step="5" value="${l.amount ?? ""}" placeholder="0"/></td>
        <td><button class="icon-btn" data-remove title="Remove line" aria-label="Remove ${esc(l.name)}">×</button></td>
      </tr>`).join("");
  });
  updateBudgetTotals();
}

function updateBudgetTotals() {
  const t = totals();
  GROUPS.forEach((g) => { $(`[data-total="${g}"]`).textContent = money(t[g]); });
  const targets = { needs: 0.5, wants: 0.3, savings: 0.2 };
  Object.entries(targets).forEach(([g, p]) => {
    const share = t.income ? t[g] / t.income : 0;
    const over = g === "savings" ? share < p : share > p;
    $(`[data-target="${g}"]`).innerHTML = `target ${money(t.income * p)} · <span class="status ${over ? "warn" : "good"}">${pct(share)}</span>`;
  });
  $("#monthlySummary").innerHTML = [
    ["Total Income", t.income, null],
    ["Total Needs", t.needs, t.income ? t.needs / t.income : 0],
    ["Total Wants", t.wants, t.income ? t.wants / t.income : 0],
    ["Total Savings", t.savings, t.income ? t.savings / t.income : 0],
    ["Left to assign", t.left, null],
  ].map(([k, v, s]) => `<tr><td>${k}${s != null ? `<span class="pct">${pct(s, 1)}</span>` : ""}</td><td${k === "Left to assign" && v < 0 ? ' style="color:var(--red)"' : ""}>${money(v)}</td></tr>`).join("");
}

// ---------------------------------------------------------------- net worth tables
function renderBalanceTables() {
  $("#assetsTable tbody").innerHTML = state.assets.map((a) => `
    <tr data-id="${a.id}">
      <td><input aria-label="Asset name" data-field="name" value="${esc(a.name)}"/>
        <select aria-label="Asset type" data-field="type" style="margin-top:4px;font-size:12px;padding:4px 6px">${Object.entries(ASSET_TYPES).map(([k, v]) => `<option value="${k}"${k === a.type ? " selected" : ""}>${v}</option>`).join("")}</select></td>
      <td><input aria-label="Asset value" data-field="value" type="number" min="0" step="100" value="${a.value}" style="text-align:right"/></td>
      <td><button class="icon-btn" data-remove aria-label="Remove ${esc(a.name)}">×</button></td>
    </tr>`).join("");
  $("#debtsTable tbody").innerHTML = state.debts.map((d) => `
    <tr data-id="${d.id}">
      <td><input aria-label="Debt name" data-field="name" value="${esc(d.name)}"/></td>
      <td data-label="Type"><select aria-label="Debt type" data-field="type">${Object.entries(DEBT_TYPES).map(([k, v]) => `<option value="${k}"${k === d.type ? " selected" : ""}>${v}</option>`).join("")}</select></td>
      <td data-label="Balance"><input aria-label="Balance" data-field="balance" type="number" min="0" step="100" value="${d.balance}" style="text-align:right"/></td>
      <td data-label="APR %"><input aria-label="APR percent" data-field="apr" type="number" min="0" step="0.1" value="${d.apr}" style="text-align:right"/></td>
      <td data-label="Min / mo"><input aria-label="Minimum monthly payment" data-field="min" type="number" min="0" step="5" value="${d.min}" style="text-align:right"/></td>
      <td><button class="icon-btn" data-remove aria-label="Remove ${esc(d.name)}">×</button></td>
    </tr>`).join("");
  $("#extraDebt").value = state.extraDebt;
  $("#creditScore").value = state.credit.score;
  $("#creditLimit").value = state.credit.limit;
  $$("[data-method]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.method === state.payoffMethod)));
  updateBalance();
}

function updateBalance() {
  const bs = balanceSheet();
  $("#assetsTotal").textContent = money(bs.assets);
  $("#debtsTotal").textContent = money(bs.debts);
  $("#nwAssets").textContent = money(bs.assets);
  $("#nwLiabs").textContent = money(bs.debts);
  $("#nwTotal").textContent = money(bs.net);
  $("#nwTotal").style.color = bs.net < 0 ? "var(--red)" : "var(--ink)";

  const plan = payoffPlan(), other = payoffPlan(state.payoffMethod === "avalanche" ? "snowball" : "avalanche");
  const el = $("#payoffResult");
  if (!plan) { el.innerHTML = `<p class="status good">No non-mortgage debt. Nice work.</p>`; }
  else if (plan.stuck) { el.innerHTML = `<p class="status bad">At ${money(plan.budget)}/mo the balances never reach zero. Increase your payment.</p>`; }
  else {
    const diff = other.interestPaid - plan.interestPaid;
    el.innerHTML = `
      <div class="result-grid">
        <div><span class="label">Debt-free in</span><span class="value">${fmtMonths(plan.months)}</span></div>
        <div><span class="label">Total interest</span><span class="value">${money(plan.interestPaid)}</span></div>
        <div><span class="label">Paying each month</span><span class="value">${money(plan.budget)}</span></div>
        <div><span class="label">vs ${state.payoffMethod === "avalanche" ? "snowball" : "avalanche"}</span><span class="value" style="color:${diff >= 0 ? "var(--green)" : "var(--amber)"}">${diff >= 0 ? "saves " : "costs "}${money(Math.abs(diff))}</span></div>
      </div>
      <p class="small" style="margin:12px 0 0"><strong>Order:</strong> ${plan.paidOff.map((p) => `${esc(p.name)} (paid off month ${p.month})`).join(" → ")}</p>
      <p class="muted small" style="margin:6px 0 0">${state.payoffMethod === "avalanche" ? "Avalanche targets the highest APR first, which costs the least interest." : "Snowball clears the smallest balance first for quick wins and motivation."} Mortgages are left out.</p>`;
  }
  renderCreditGauge();
}

// ---------------------------------------------------------------- mortgage tab
function renderHome() {
  $$("[data-home]").forEach((i) => { i.value = state.home[i.dataset.home]; });
  updateHome();
}
function updateHome() {
  const m = mortgage(), t = totals();
  const ratio = t.income ? m.monthlyAll / t.income : 0;
  $("#mortgageResult").innerHTML = `
    <div class="result-grid">
      <div><span class="label">Loan amount</span><span class="value">${money(m.loan)}</span></div>
      <div><span class="label">Down payment</span><span class="value">${pct(m.downPct)}</span></div>
      <div><span class="label">Principal &amp; interest / mo</span><span class="value">${money(m.pmt)}</span></div>
      <div><span class="label">With tax &amp; insurance / mo</span><span class="value">${money(m.monthlyAll)}</span></div>
      <div><span class="label">Total interest over the loan</span><span class="value">${money(m.totalInterest)}</span></div>
      <div><span class="label">Share of your take-home</span><span class="value"><span class="status ${ratio > 0.35 ? "bad" : ratio > 0.28 ? "warn" : "good"}">${t.income ? pct(ratio) : "–"}</span></span></div>
    </div>
    ${m.downPct < 0.2 ? `<p class="small" style="margin:10px 0 0"><span class="status warn">Under 20% down</span> usually adds private mortgage insurance (PMI).</p>` : ""}`;
  const buyWins = m.buyCost < m.rentCost;
  $("#rentBuyResult").innerHTML = `
    <table class="compare">
      <thead><tr><th>Year one</th><th>Buy</th><th>Rent</th></tr></thead>
      <tbody>
        <tr><td>Mortgage interest after tax deduction</td><td>${money(m.interestAfterTax)}</td><td>–</td></tr>
        <tr><td>Property tax</td><td>${money(m.propTax)}</td><td>–</td></tr>
        <tr><td>Upkeep &amp; insurance</td><td>${money(num(state.home.upkeep) + num(state.home.insurance))}</td><td>–</td></tr>
        <tr><td>Rent</td><td>–</td><td>${money(num(state.home.rent) * 12)}</td></tr>
        <tr><td>Return on the down payment if invested instead</td><td>–</td><td>−${money(m.forgone)}</td></tr>
        <tr class="total"><td>Cost you don't get back</td><td>${money(m.buyCost)}</td><td>${money(m.rentCost)}</td></tr>
      </tbody>
    </table>
    <p class="verdict">${buyWins ? "Buying" : "Renting"} is cheaper by ${money(Math.abs(m.buyCost - m.rentCost))} in year one.</p>`;
  $("#kpiMortgage").textContent = money(m.monthlyAll);
  $("#kpiMortgageSub").textContent = `${money(num(state.home.price))} home · ${num(state.home.rate)}% · ${num(state.home.term)} yrs`;
}

// ---------------------------------------------------------------- goals
const PRESETS = [
  { label: "Emergency fund", name: "Emergency fund: 6 months of needs", kind: "emergency", years: 1, target: () => Math.round(totals().needs * 6) },
  { label: "Laptop in 3 months", name: "New laptop", kind: "purchase", years: 0.25, target: () => 2000 },
  { label: "College in 4 years", name: "College fund", kind: "college", years: 4, target: () => 40000 },
  { label: "Home down payment", name: "Down payment for a home", kind: "home", years: 5, target: () => num(state.home.down) || 100000 },
  { label: "Retire in 30 years", name: "Retirement nest egg", kind: "retirement", years: 30, target: () => 1000000 },
  { label: "Pay off credit card", name: "Pay off credit card", kind: "debt", years: 1, target: () => balanceSheet().cardDebt || 2000 },
];
function renderGoalPresets() {
  $("#goalPresets").innerHTML = PRESETS.map((p, i) => `<button type="button" data-preset="${i}">${p.label}</button>`).join("");
}
function renderGoals() {
  const t = totals();
  $("#goalList").innerHTML = state.goals.map((g) => {
    const h = horizonOf(num(g.years)), rate = g.kind === "emergency" ? 0 : SAVINGS_GROWTH[h];
    const need = requiredMonthly(num(g.target), num(g.saved), num(g.years), rate);
    const progress = Math.min(1, num(g.saved) / Math.max(1, num(g.target)));
    return `<li data-id="${g.id}">
      <div class="goal-top"><strong>${esc(g.name)}</strong><button class="icon-btn" data-remove-goal aria-label="Remove ${esc(g.name)}">×</button></div>
      <div class="bar"><span style="width:${(progress * 100).toFixed(1)}%"></span></div>
      <div class="goal-meta">
        <span>${money(g.saved)} of ${money(g.target)} (${pct(progress)})</span>
        <span>${fmtYears(num(g.years))} · ${h} term</span>
        <span>Needs <strong>${money(need)}/mo</strong>${t.savings ? ` (${pct(need / t.savings)} of savings)` : ""}</span>
      </div>
    </li>`;
  }).join("");
}

function renderQuiz() {
  $("#quiz").innerHTML = QUIZ.map((item, qi) => `
    <fieldset><legend>${qi + 1}. ${esc(item.q)}</legend>
      ${item.a.map((a, ai) => `<label><input type="radio" name="q${qi}" value="${ai}"${state.quiz[qi] === ai ? " checked" : ""}/> ${esc(a)}</label>`).join("")}
    </fieldset>`).join("");
  renderQuizResult();
}
function renderQuizResult() {
  const p = personality(), el = $("#quizResult");
  if (!p) { el.innerHTML = `<span class="small muted">Answer all ${QUIZ.length} to see your type (${Object.keys(state.quiz).length}/${QUIZ.length}).</span>`; return; }
  el.innerHTML = `<strong>${p.name}</strong> · ${p.score} points<p class="small" style="margin:4px 0">${esc(p.desc)}</p><ul class="small" style="margin:0;padding-left:18px">${p.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
}

// ---------------------------------------------------------------- overview & global refresh
function renderOverview() {
  const t = totals(), bs = balanceSheet();
  $("#heroName").textContent = state.name;
  $("#kpiNetWorth").textContent = money(bs.net);
  $("#kpiNetWorthSub").textContent = `${money(bs.assets)} assets − ${money(bs.debts)} liabilities`;
  $("#kpiIncome").textContent = money(t.income);
  $("#kpiSavings").textContent = money(t.savings);
  $("#kpiSavingsSub").innerHTML = `${t.income ? pct(t.savings / t.income, 1) : "0%"} of income · target 20%`;
  const months = t.needs ? bs.emergency / t.needs : 0;
  $("#kpiEmergency").textContent = money(bs.emergency);
  $("#kpiEmergencySub").innerHTML = `<span class="status ${months >= 3 ? "good" : months >= 1 ? "warn" : "bad"}">${months.toFixed(1)} months of needs</span> · target 3–6`;
  $("#kpiDebt").textContent = money(bs.debts);
  const plan = payoffPlan();
  $("#kpiDebtSub").textContent = plan && !plan.stuck ? `Non-mortgage debt gone in ${fmtMonths(plan.months)}` : state.debts.length ? "Raise payments to finish" : "Debt-free";
  $("#kpiCredit").textContent = state.credit.score || "–";
  const util = num(state.credit.limit) ? bs.cardDebt / num(state.credit.limit) : 0;
  $("#kpiCreditSub").textContent = `Utilization ${pct(util)} · aim under 30%`;
  renderSplitChart();
}

function refresh() {
  save();
  const advice = advise();
  renderOverview();
  updateHome();
  renderGoals();
  renderAdvice($("#topAdvice"), advice.filter((a) => a.priority !== "good"), 4);
  renderAdvice($("#budgetAdvice"), advice.filter((a) => ["Budget", "Savings", "Emergency fund"].includes(a.tag)));
  const h = state.horizon;
  renderAdvice($("#allAdvice"), h === "all" ? advice : advice.filter((a) => a.horizons.includes(h)));
  $$("[data-horizon]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.horizon === h)));
}

// ---------------------------------------------------------------- events
function selectTab(name) {
  $$(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  try { sessionStorage.setItem("learnfi.tab", name); } catch { /* ignore */ }
  window.scrollTo({ top: 0 });
}
$$(".tabs [role=tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
$$("[data-goto]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.goto)));

// budget edits
$("#tab-budget").addEventListener("input", (e) => {
  if (e.target.id === "budgetMonth") { state.month = e.target.value; save(); return; }
  const row = e.target.closest("tr[data-id]"), block = e.target.closest("[data-group]");
  if (!row || !block) return;
  const item = state.budget[block.dataset.group].find((l) => l.id === row.dataset.id);
  item[e.target.dataset.field] = e.target.dataset.field === "amount" ? num(e.target.value) : e.target.value;
  updateBudgetTotals(); refresh();
});
$("#tab-budget").addEventListener("click", (e) => {
  const add = e.target.closest("[data-add]");
  if (add) { state.budget[add.dataset.add].push(line("", 0)); renderBudgetTables(); refresh(); $(`[data-group="${add.dataset.add}"] tbody tr:last-child input`).focus(); return; }
  if (e.target.closest("[data-remove]")) {
    const row = e.target.closest("tr[data-id]"), g = e.target.closest("[data-group]").dataset.group;
    state.budget[g] = state.budget[g].filter((l) => l.id !== row.dataset.id);
    renderBudgetTables(); refresh();
  }
});

// net worth edits
$("#tab-networth").addEventListener("input", (e) => {
  const f = e.target.dataset.field, row = e.target.closest("tr[data-id]");
  if (row && f) {
    const list = e.target.closest("#assetsTable") ? state.assets : state.debts;
    const item = list.find((x) => x.id === row.dataset.id);
    item[f] = ["name", "type"].includes(f) ? e.target.value : num(e.target.value);
  } else if (e.target.id === "extraDebt") state.extraDebt = num(e.target.value);
  else if (e.target.id === "creditScore") state.credit.score = num(e.target.value);
  else if (e.target.id === "creditLimit") state.credit.limit = num(e.target.value);
  else return;
  updateBalance(); refresh();
});
$("#tab-networth").addEventListener("click", (e) => {
  if (e.target.closest("[data-add-asset]")) { state.assets.push({ id: uid(), name: "", type: "cash", value: 0 }); renderBalanceTables(); refresh(); return; }
  if (e.target.closest("[data-add-debt]")) { state.debts.push({ id: uid(), name: "", type: "card", balance: 0, apr: 0, min: 0 }); renderBalanceTables(); refresh(); return; }
  const m = e.target.closest("[data-method]");
  if (m) { state.payoffMethod = m.dataset.method; renderBalanceTables(); refresh(); return; }
  if (e.target.closest("[data-remove]")) {
    const row = e.target.closest("tr[data-id]");
    if (e.target.closest("#assetsTable")) state.assets = state.assets.filter((a) => a.id !== row.dataset.id);
    else state.debts = state.debts.filter((d) => d.id !== row.dataset.id);
    renderBalanceTables(); refresh();
  }
});

// mortgage edits
$("#tab-home").addEventListener("input", (e) => {
  const k = e.target.dataset.home;
  if (!k) return;
  state.home[k] = num(e.target.value);
  refresh();
});

// goals
$("#goalPresets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-preset]");
  if (!b) return;
  const p = PRESETS[+b.dataset.preset], f = $("#goalForm").elements;
  f.namedItem("name").value = p.name; f.namedItem("kind").value = p.kind; f.namedItem("years").value = p.years;
  f.namedItem("target").value = p.target(); f.namedItem("saved").value = p.kind === "emergency" ? balanceSheet().emergency : 0;
  f.namedItem("target").focus();
});
$("#goalForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.elements, v = (n) => f.namedItem(n).value;
  state.goals.push({ id: uid(), name: v("name").trim(), kind: v("kind"), target: num(v("target")), saved: num(v("saved")), years: num(v("years")) });
  e.target.reset();
  state.horizon = "all";
  refresh();
});
$("#goalList").addEventListener("click", (e) => {
  if (!e.target.closest("[data-remove-goal]")) return;
  const id = e.target.closest("li[data-id]").dataset.id;
  state.goals = state.goals.filter((g) => g.id !== id);
  refresh();
});
$$("[data-horizon]").forEach((b) => b.addEventListener("click", () => { state.horizon = b.dataset.horizon; refresh(); }));
$("#quiz").addEventListener("change", (e) => {
  const qi = +e.target.name.slice(1);
  state.quiz[qi] = +e.target.value;
  renderQuizResult(); refresh();
});

// Two-step reset (no blocking dialogs): first click arms, second click within 4s confirms.
let resetArmed = null;
$("#resetBtn").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  if (!resetArmed) {
    btn.textContent = "Click again to reset";
    resetArmed = setTimeout(() => { resetArmed = null; btn.textContent = "Reset sample"; }, 4000);
    return;
  }
  clearTimeout(resetArmed); resetArmed = null; btn.textContent = "Reset sample";
  state = sampleState();
  renderAll();
});

// ---------------------------------------------------------------- Claude (optional)
try { $("#apiKey").value = sessionStorage.getItem("learnfi.key") || ""; } catch { /* ignore */ }
$("#apiKey").addEventListener("change", (e) => { try { sessionStorage.setItem("learnfi.key", e.target.value.trim()); } catch { /* ignore */ } });

function financialSnapshot() {
  const t = totals(), bs = balanceSheet(), m = mortgage(), p = personality();
  return {
    monthly_take_home_income: t.income,
    budget: Object.fromEntries(GROUPS.map((g) => [g, state.budget[g].map((l) => ({ item: l.name, monthly: num(l.amount) }))])),
    budget_split_pct: t.income ? { needs: +(t.needs / t.income * 100).toFixed(1), wants: +(t.wants / t.income * 100).toFixed(1), savings: +(t.savings / t.income * 100).toFixed(1) } : null,
    assets: state.assets.map((a) => ({ item: a.name, type: ASSET_TYPES[a.type], value: num(a.value) })),
    debts: state.debts.map((d) => ({ item: d.name, type: DEBT_TYPES[d.type], balance: num(d.balance), apr_pct: num(d.apr), min_monthly: num(d.min) })),
    net_worth: bs.net,
    emergency_fund_months_of_needs: t.needs ? +(bs.emergency / t.needs).toFixed(1) : 0,
    credit: { score: num(state.credit.score), card_utilization_pct: num(state.credit.limit) ? +(bs.cardDebt / num(state.credit.limit) * 100).toFixed(1) : null },
    home_scenario: { price: num(state.home.price), down_payment: num(state.home.down), rate_pct: num(state.home.rate), term_years: num(state.home.term), monthly_cost_with_tax_insurance: Math.round(m.monthlyAll), comparable_rent: num(state.home.rent) },
    goals: state.goals.map((g) => ({ name: g.name, type: g.kind, target: num(g.target), saved: num(g.saved), years: num(g.years), horizon: horizonOf(num(g.years)) })),
    money_personality: p ? p.name : "not taken",
  };
}

const SYSTEM_PROMPT = `You are a friendly financial-literacy coach inside an educational budgeting app. You explain things in plain language to people who may be new to personal finance.

Ground your advice in this framework, in priority order: (1) a working budget, with 50/30/20 needs/wants/savings as a starting point that can be adjusted; (2) an emergency fund of 3–6 months of needs in a high-yield savings account; (3) paying off high-interest debt (avalanche or snowball); (4) SMART goals split into short (<1 yr: cash/HYSA), medium (1–5 yrs: HYSA, CDs, some bonds) and long (5+ yrs: diversified low-cost index funds in tax-advantaged accounts like a 401(k) with employer match, IRA or Roth IRA); (5) diversify and review regularly. Mention inflation, credit score factors (payment history 35%, utilization 30%, history length 15%, mix 10%, new credit 10%), rent-vs-buy thinking, college total cost and financial aid, insurance, and scam awareness when they're relevant to this person's numbers.

Use the person's actual numbers. Be specific: give dollar amounts and timelines. Stay educational: don't recommend specific stocks, funds by ticker, or financial products by brand, and note when something depends on their country or tax situation.

Format with short markdown: "## " section headings, "- " bullets and **bold** for key numbers. Use at most 4 sections and keep it under about 350 words.`;

const FOCUS_TEXT = {
  overall: "Give me an overall prioritized plan for the next 12 months.",
  short: "Focus on my short-term goals (under a year): what to do first and where to keep the money.",
  college: "Focus on paying for college or further education: how to plan, save and compare the true cost.",
  home: "Focus on buying a home: am I ready, what should I target, and is renting smarter for now?",
  retirement: "Focus on long-term wealth and retirement: how much to invest, where, and why starting now matters.",
};

$("#askClaude").addEventListener("click", async () => {
  const out = $("#aiOutput"), btn = $("#askClaude");
  const apiKey = $("#apiKey").value.trim();
  if (!apiKey) { out.innerHTML = `<p class="error">Add your Anthropic API key first.</p>`; return; }
  try { sessionStorage.setItem("learnfi.key", apiKey); } catch { /* ignore */ }
  btn.disabled = true; btn.textContent = "Thinking…";
  out.innerHTML = `<p class="muted">Building your plan…</p>`;

  let Anthropic;
  try {
    ({ default: Anthropic } = await import("https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm"));
  } catch {
    out.innerHTML = `<p class="error">Couldn't load the Anthropic SDK. Check your connection.</p>`;
    btn.disabled = false; btn.textContent = "Get AI plan"; return;
  }

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const userText = `${FOCUS_TEXT[$("#aiFocus").value]}

My numbers (JSON):
${JSON.stringify(financialSnapshot(), null, 2)}
${$("#aiNote").value.trim() ? `\nMore context from me: ${$("#aiNote").value.trim()}` : ""}`;

  try {
    let text = "";
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
    });
    stream.on("text", (delta) => { text += delta; out.innerHTML = renderMarkdown(text); });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      out.innerHTML = `<p class="error">The model declined this request. Try rephrasing your note.</p>`;
    } else {
      out.innerHTML = renderMarkdown(text) + `<p class="muted small">AI-generated and educational only. Not financial advice.</p>`;
    }
  } catch (err) {
    let msg = "Something went wrong talking to Claude.";
    if (err instanceof Anthropic.AuthenticationError) msg = "That API key was rejected. Check it and try again.";
    else if (err instanceof Anthropic.RateLimitError) msg = "Rate limited. Wait a moment and try again.";
    else if (err instanceof Anthropic.APIConnectionError) msg = "Couldn't reach the Claude API. Check your connection.";
    else if (err instanceof Anthropic.APIError) msg = `Claude API error (${err.status ?? "unknown"}): ${err.message}`;
    out.innerHTML = `<p class="error">${esc(msg)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = "Get AI plan";
  }
});

// Minimal, escape-first markdown: headings, bullets, bold, paragraphs.
function renderMarkdown(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  let html = "", inList = false;
  for (const raw of md.split("\n")) {
    const l = raw.trimEnd();
    const bullet = l.match(/^\s*[-*]\s+(.*)/);
    if (bullet) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(bullet[1])}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    const h = l.match(/^#{1,4}\s+(.*)/);
    if (h) html += `<h3>${inline(h[1])}</h3>`;
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}

// ---------------------------------------------------------------- boot
function renderAll() {
  renderBudgetTables();
  renderBalanceTables();
  renderHome();
  renderGoalPresets();
  renderQuiz();
  renderCompoundChart();
  refresh();
}
renderAll();
try { const t = sessionStorage.getItem("learnfi.tab"); if (t && $(`#tab-${t}`)) selectTab(t); } catch { /* ignore */ }
