// LearnFi Wealth: money-management features for a consumer banking app.
// Balances and transactions come from the bank feed (data.js in this prototype); everything else
// (budget, net worth, goals, advice) is derived from them. User edits (category overrides, manual
// lines, goals) persist in this browser. The advisor is a deterministic rules engine; the Assistant
// tab and AI categorization call Claude.

const STORE_KEY = "learnfi.v2";
const SAVINGS_GROWTH = { short: 0.0, medium: 0.04, long: 0.07 }; // cash, HYSA/CD, diversified index

const bank = window.LearnFiBank.load();

// ---------------------------------------------------------------- categories
// bucket: income | needs | wants | savings | transfer (excluded) | unassigned
const CATS = {
  paycheck: { label: "Paychecks", bucket: "income" },
  side_income: { label: "Side income", bucket: "income" },
  housing: { label: "Rent / housing", bucket: "needs" },
  utilities: { label: "Utilities", bucket: "needs" },
  phone_internet: { label: "Phone & internet", bucket: "needs" },
  transport: { label: "Car, gas & insurance", bucket: "needs" },
  loan_payment: { label: "Loan payments", bucket: "needs" },
  groceries: { label: "Groceries", bucket: "needs" },
  health: { label: "Health", bucket: "needs" },
  fees_interest: { label: "Card interest & fees", bucket: "needs" },
  dining: { label: "Eating out", bucket: "wants" },
  entertainment: { label: "Entertainment", bucket: "wants" },
  subscriptions: { label: "Subscriptions", bucket: "wants" },
  shopping: { label: "Shopping", bucket: "wants" },
  fitness: { label: "Gym & fitness", bucket: "wants" },
  savings_transfer: { label: "Savings transfers", bucket: "savings" },
  investment: { label: "Investing (IRA)", bucket: "savings" },
  card_payment: { label: "Card payment (transfer)", bucket: "transfer" },
  uncategorized: { label: "Uncategorized", bucket: "unassigned" },
};
const GROUPS = ["income", "needs", "wants", "savings"];

// ---------------------------------------------------------------- user state (edits on top of bank data)
const uid = () => Math.random().toString(36).slice(2, 9);
const line = (name, amount) => ({ id: uid(), name, amount });

function defaultState() {
  return {
    name: "Alex",
    merchantCat: {},           // merchant -> category override
    manual: {},                // "YYYY-MM" -> { income|needs|wants|savings: [lines] }
    manualAssets: [{ id: uid(), name: "Car (estimated value)", value: 14000 }],
    manualDebts: [],
    payoffMethod: "avalanche",
    extraDebt: 100,
    home: { price: 400000, down: 100000, rate: 6, term: 30, taxPct: 1, upkeep: 2000, insurance: 1200, marginal: 33, rent: null, altReturn: 2 },
    goals: [
      { id: uid(), name: "Emergency fund: 3 months of needs", kind: "emergency", target: null, accountId: "sav", years: 1 },
      { id: uid(), name: "New laptop", kind: "purchase", target: 2000, accountId: "bucket", years: 0.5 },
    ],
    quiz: {},
    horizon: "all",
    budgetMonth: null,
  };
}

let state = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch { /* storage unavailable: fall through to defaults */ }
  return defaultState();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n) => usd.format(Math.round(n || 0));
const cents = (n) => usd2.format(n || 0);
const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const pct = (n, d = 0) => `${(n * 100).toFixed(d)}%`;
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const sum = (arr, key = "amount") => arr.reduce((a, x) => a + num(x[key]), 0);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const horizonOf = (years) => (years <= 1 ? "short" : years <= 5 ? "medium" : "long");
const monthName = (ym, style = "long") => new Date(`${ym}-15T12:00:00`).toLocaleDateString("en-US", { month: style, year: "numeric" });
const shortDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const DEBT_TYPES = { card: "Credit card", student: "Student loan", auto: "Car loan", mortgage: "Mortgage", personal: "Personal loan", payday: "Payday loan", other: "Other" };
const today = bank.asOf;
const currentYM = isoDate(today).slice(0, 7);
const MONTHS = [...new Set(bank.transactions.map((t) => t.date.slice(0, 7)))].sort().reverse(); // newest first
const LAST_FULL = MONTHS.find((m) => m !== currentYM) || MONTHS[0];
const acct = (id) => bank.accounts.find((a) => a.id === id);

// ---------------------------------------------------------------- transaction-derived numbers
const catOf = (t) => state.merchantCat[t.merchant] || t.category || "uncategorized";
const bucketOf = (t) => CATS[catOf(t)]?.bucket || "unassigned";
const txIn = (ym) => bank.transactions.filter((t) => t.date.startsWith(ym));

function monthCategories(ym) {
  const by = {};
  for (const t of txIn(ym)) {
    const c = catOf(t), b = CATS[c].bucket;
    if (b === "transfer") continue;
    const amt = b === "income" ? t.amount : -t.amount;
    (by[c] ||= { cat: c, bucket: b, amount: 0, count: 0 }).amount += amt;
    by[c].count++;
  }
  return Object.values(by).sort((a, b) => b.amount - a.amount);
}

function totals(ym = state.budgetMonth || LAST_FULL) {
  const cats = monthCategories(ym), man = state.manual[ym] || {};
  const t = { income: 0, needs: 0, wants: 0, savings: 0, unassigned: 0 };
  cats.forEach((c) => { t[c.bucket] += c.amount; });
  GROUPS.forEach((g) => { t[g] += sum(man[g] || []); });
  t.left = t.income - t.needs - t.wants - t.savings - t.unassigned;
  return t;
}

// Recurring payments: same merchant in every full month with a stable amount.
const VARIABLE_CATS = ["groceries", "dining", "shopping", "transport", "fees_interest", "uncategorized", "entertainment"];
function recurring() {
  const full = MONTHS.filter((m) => m !== currentYM);
  const byMerchant = {};
  for (const t of bank.transactions) {
    if (t.amount >= 0 || t.transfer) continue;
    if (VARIABLE_CATS.includes(catOf(t)) && !/INSURANCE/.test(t.merchant)) continue;
    if (CATS[catOf(t)].bucket === "savings") continue; // transfers to your own accounts aren't bills
    (byMerchant[t.merchant] ||= []).push(t);
  }
  const out = [];
  for (const [merchant, list] of Object.entries(byMerchant)) {
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    if (!full.every((m) => months.has(m))) continue;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const amounts = sorted.map((t) => -t.amount);
    if (Math.max(...amounts) / Math.min(...amounts) > 1.3) continue;
    const day = Math.round(sorted.reduce((s, t) => s + Number(t.date.slice(8)), 0) / sorted.length);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const paidThisMonth = months.has(currentYM);
    const nextDate = new Date(today.getFullYear(), today.getMonth() + (paidThisMonth || day < today.getDate() ? 1 : 0), day);
    out.push({
      merchant, cat: catOf(last), account: last.account, amount: -last.amount, day, nextDate,
      // only fixed-price charges (subscriptions, memberships) get price-change alerts; utility bills vary
      priceUp: ["subscriptions", "fitness"].includes(catOf(last)) && -last.amount > -first.amount * 1.02 ? { from: -first.amount, to: -last.amount } : null,
      isSub: ["subscriptions", "fitness"].includes(catOf(last)),
    });
  }
  return out.sort((a, b) => a.nextDate - b.nextDate);
}

function nextPayday() {
  const days = [...new Set(bank.transactions.filter((t) => catOf(t) === "paycheck").map((t) => Number(t.date.slice(8))))].sort((a, b) => a - b);
  const d = days.find((x) => x > today.getDate());
  return d ? new Date(today.getFullYear(), today.getMonth(), d) : new Date(today.getFullYear(), today.getMonth() + 1, days[0] || 1);
}

function detectedRent() {
  const r = bank.transactions.find((t) => catOf(t) === "housing" && t.date.startsWith(LAST_FULL));
  return r ? -r.amount : 1500;
}

function interestPaid(monthsBack = 3) {
  const ms = MONTHS.filter((m) => m !== currentYM).slice(0, monthsBack);
  return -bank.transactions.filter((t) => catOf(t) === "fees_interest" && ms.includes(t.date.slice(0, 7))).reduce((s, t) => s + t.amount, 0);
}

// ---------------------------------------------------------------- balance sheet
const ASSET_KINDS = ["checking", "savings", "investment", "retirement"];
function linkedDebts() {
  return bank.accounts.filter((a) => a.kind === "credit" || a.kind === "loan").map((a) => ({
    id: a.id, name: `${a.name} ••${a.mask}`, type: a.kind === "credit" ? "card" : a.debtType, balance: a.balance, apr: a.apr, min: a.minPayment, linked: true,
  }));
}
const allDebts = () => [...linkedDebts(), ...state.manualDebts];

function balanceSheet() {
  const linkedA = bank.accounts.filter((a) => ASSET_KINDS.includes(a.kind)).reduce((s, a) => s + a.balance, 0);
  const assets = linkedA + sum(state.manualAssets, "value");
  const debts = sum(allDebts(), "balance");
  const emergency = bank.accounts.filter((a) => a.role === "emergency").reduce((s, a) => s + a.balance, 0);
  const cardLimit = bank.accounts.filter((a) => a.kind === "credit").reduce((s, a) => s + a.limit, 0);
  const cardDebt = allDebts().filter((d) => d.type === "card").reduce((s, d) => s + num(d.balance), 0);
  return { assets, debts, net: assets - debts, emergency, cardDebt, cardLimit, checking: acct("chk")?.balance || 0 };
}

// ---------------------------------------------------------------- math
function amortPayment(principal, annualRate, years) {
  const r = annualRate / 100 / 12, n = years * 12;
  if (principal <= 0) return 0;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

function mortgage() {
  const h = state.home, rent = h.rent ?? detectedRent();
  const loan = Math.max(0, num(h.price) - num(h.down));
  const pmt = amortPayment(loan, num(h.rate), num(h.term));
  let bal = loan, interest = 0;
  const r = num(h.rate) / 100 / 12;
  for (let m = 0; m < 12 && bal > 0; m++) { const i = bal * r; interest += i; bal -= pmt - i; }
  const propTax = (num(h.price) * num(h.taxPct)) / 100;
  const monthlyAll = pmt + (propTax + num(h.insurance)) / 12;
  const totalInterest = pmt * num(h.term) * 12 - loan;
  const downPct = num(h.price) > 0 ? num(h.down) / num(h.price) : 0;
  const interestAfterTax = interest * (1 - num(h.marginal) / 100);
  const buyCost = interestAfterTax + propTax + num(h.upkeep) + num(h.insurance);
  const forgone = (num(h.down) * num(h.altReturn)) / 100;
  const rentCost = num(rent) * 12 - forgone;
  return { loan, pmt, interest, interestAfterTax, propTax, monthlyAll, totalInterest, downPct, buyCost, rentCost, forgone, rent };
}

// Month-by-month payoff simulation; mortgages are excluded (long-term, low-rate, tax-advantaged).
function payoffPlan(method = state.payoffMethod, extra = num(state.extraDebt)) {
  const debts = allDebts().filter((d) => d.type !== "mortgage" && num(d.balance) > 0)
    .map((d) => ({ ...d, bal: num(d.balance), r: num(d.apr) / 100 / 12, min: Math.max(num(d.min), 1) }));
  if (!debts.length) return null;
  const order = [...debts].sort((a, b) => method === "avalanche" ? b.apr - a.apr || a.bal - b.bal : a.bal - b.bal || b.apr - a.apr);
  const budget = debts.reduce((s, d) => s + d.min, 0) + extra;
  let month = 0, interest = 0;
  const paidOff = [];
  while (debts.some((d) => d.bal > 0.005) && month < 600) {
    month++;
    debts.forEach((d) => { if (d.bal > 0) { const i = d.bal * d.r; d.bal += i; interest += i; } });
    let pool = budget;
    debts.forEach((d) => { if (d.bal > 0) { const p = Math.min(d.min, d.bal); d.bal -= p; pool -= p; } });
    for (const t of order) {
      const d = debts.find((x) => x.id === t.id);
      if (d.bal > 0 && pool > 0) { const p = Math.min(pool, d.bal); d.bal -= p; pool -= p; }
    }
    debts.forEach((d) => { if (d.bal <= 0.005 && !paidOff.find((p) => p.id === d.id)) { d.bal = 0; paidOff.push({ id: d.id, name: d.name, month }); } });
  }
  return { months: month, interestPaid: interest, paidOff, budget, stuck: month >= 600 };
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

// Goals track a linked account's balance when one is chosen.
const goalSaved = (g) => (g.accountId && acct(g.accountId) ? acct(g.accountId).balance : num(g.saved));
const goalTarget = (g) => (g.kind === "emergency" && !g.target ? Math.round(totals(LAST_FULL).needs * 3) : num(g.target));

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
  { min: 5, max: 9, name: "Spender", desc: "You enjoy money in the moment. Watch for impulse buys and debt.", tips: ["Automate savings on payday, before you can spend it", "Use a 48-hour rule for non-essential purchases", "Track wants weekly against your 30%"] },
  { min: 10, max: 14, name: "Balancer", desc: "You manage money well but can get stuck being cautious or indecisive.", tips: ["Treat yourself occasionally; it's in the plan", "Stay open to new money-making opportunities", "Seek advice, but trust your instincts"] },
  { min: 15, max: 19, name: "Saver", desc: "You're excellent at saving, but you can be too frugal or rigid.", tips: ["Budget guilt-free money for wants", "Cash above 6 months of needs loses value to inflation; put it to work", "Celebrate your progress"] },
  { min: 20, max: 25, name: "Investor", desc: "You're strategic and risk-tolerant, but you can be over-optimistic and skip the basics.", tips: ["Keep the emergency fund topped up before taking risk", "Diversify; don't concentrate in single stocks or crypto", "Review risk annually"] },
];
function personality() {
  const answers = Object.values(state.quiz);
  if (answers.length < QUIZ.length) return null;
  const score = answers.reduce((s, i) => s + QUIZ_POINTS[i], 0);
  return { score, ...PERSONALITIES.find((p) => score >= p.min && score <= p.max) };
}

// ---------------------------------------------------------------- advisor (rules engine)
// Each item: { title, body, why, priority: "high"|"med"|"low"|"good", horizons: [...], tag, action? }
function advise() {
  const t = totals(LAST_FULL), bs = balanceSheet(), m = mortgage(), out = [];
  const add = (o) => out.push({ horizons: ["short", "medium", "long"], ...o });
  const persona = personality();
  const monthLabel = monthName(LAST_FULL, "long");

  if (t.income <= 0) {
    add({ priority: "high", tag: "Budget", title: "No income detected yet", body: "Once a paycheck lands in a linked account, your budget fills in automatically. You can also add cash income on the Monthly Budget tab.", why: "A budget is the foundation." });
    return rank(out);
  }

  const spent = t.needs + t.wants + t.unassigned;
  if (spent > t.income) {
    add({ priority: "high", tag: "Cash flow", title: `You spent ${money(spent - t.income)} more than you earned in ${monthLabel}`, body: "Cut wants first, then look at needs. Overspending usually ends up on a credit card at 20–30% APR.", why: "Spending more than you earn is how bad debt starts." });
  }

  // Upcoming bills vs checking balance
  const payday = nextPayday();
  const dueSoon = recurring().filter((r) => r.account === "chk" && r.nextDate < payday);
  const dueTotal = dueSoon.reduce((s, r) => s + r.amount, 0);
  if (bs.checking - dueTotal < 100) {
    add({ priority: "high", tag: "Cash flow", horizons: ["short"], title: `Checking could drop to ${money(bs.checking - dueTotal)} before payday`, body: `${dueSoon.length} bill${dueSoon.length === 1 ? "" : "s"} (${money(dueTotal)}) come out before ${shortDate(payday)}. Move money from savings or hold off on non-essential spending to avoid overdraft fees.`, why: "Overdraft fees are pure cost." });
  }

  if (bank.transactions.some((x) => /PAYDAY/.test(x.merchant))) {
    add({ priority: "high", tag: "Debt", title: "Get out of payday loans first", body: "Payday loans can run 300–800% APR. Ask the bank about a small personal loan to refinance, and stop rolling it over.", why: "This is the most expensive debt there is." });
  }

  // Emergency fund: 3–6 months of needs
  const monthsCovered = t.needs > 0 ? bs.emergency / t.needs : 0;
  const efGoal3 = t.needs * 3, efGoal6 = t.needs * 6;
  const efAcct = bank.accounts.find((a) => a.role === "emergency");
  const efTransfer = efAcct ? -txIn(LAST_FULL).filter((x) => x.amount < 0 && x.merchant.includes(`••${efAcct.mask}`)).reduce((s, x) => s + x.amount, 0) : 0;
  if (monthsCovered < 1) {
    add({ priority: "high", tag: "Emergency fund", horizons: ["short"], title: "Build a starter emergency fund", body: `Aim for 1 month of needs (${money(t.needs)}) first, then 3 months (${money(efGoal3)}). Set up an automatic transfer to savings on payday.`, why: "Without a buffer, surprises go on a credit card." });
  } else if (monthsCovered < 3) {
    const gap = efGoal3 - bs.emergency;
    const eta = efTransfer > 0 ? ` At your current ${money(efTransfer)}/mo transfer you'll get there in about ${Math.ceil(gap / efTransfer)} months.` : "";
    add({ priority: "med", tag: "Emergency fund", horizons: ["short"], title: `Emergency savings cover ${monthsCovered.toFixed(1)} months of needs; target is 3–6`, body: `You need ${money(gap)} more to reach 3 months (${money(efGoal3)}).${eta}`, action: { label: "Ask how to speed this up", ask: "How can I reach a 3-month emergency fund faster using my actual spending?" }, why: "The course puts the emergency fund first in the savings order." });
  } else if (monthsCovered <= 6.5) {
    add({ priority: "good", tag: "Emergency fund", horizons: ["short"], title: `Emergency fund is solid at ${monthsCovered.toFixed(1)} months`, body: "You can now point more of your savings at goals and investing.", why: "You're inside the recommended 3–6 month range." });
  } else {
    add({ priority: "low", tag: "Inflation", horizons: ["medium", "long"], title: `${money(bs.emergency - efGoal6)} above a 6-month cushion is losing to inflation`, body: "Consider CDs for medium-term goals or diversified index funds for long-term ones.", why: "Doing nothing with money means slowly losing it." });
  }

  // Idle checking cash
  const chk = acct("chk");
  if (chk && chk.balance > (t.needs + t.wants) * 1.5) {
    add({ priority: "low", tag: "Savings", horizons: ["short"], title: `${money(chk.balance - (t.needs + t.wants))} is sitting in checking at ${chk.apy}%`, body: `Your High-Yield Savings pays ${efAcct?.apy ?? 4}%. Keep about one month of spending in checking and move the rest.`, why: "Idle cash loses value to inflation." });
  }

  // High-interest debt + card interest actually paid
  const paidInt = interestPaid(3);
  const hi = allDebts().filter((d) => d.type !== "mortgage" && num(d.apr) >= 10 && num(d.balance) > 0).sort((a, b) => b.apr - a.apr);
  if (hi.length) {
    const plan = payoffPlan("avalanche"), snow = payoffPlan("snowball");
    const saved = snow && plan ? snow.interestPaid - plan.interestPaid : 0;
    add({ priority: "high", tag: "Debt", horizons: ["short", "medium"], title: paidInt > 0 ? `You paid ${money(paidInt)} in card interest over the last 3 months` : `Pay down ${hi[0].name} (${num(hi[0].apr)}% APR)`, body: plan && !plan.stuck
      ? `${hi[0].name} charges ${num(hi[0].apr)}% APR. Paying ${money(plan.budget)}/mo with the avalanche method clears non-mortgage debt in ${fmtMonths(plan.months)}${saved > 1 ? `, ${money(saved)} less interest than snowball` : ""}. After that, pay the statement balance in full each month.`
      : "Your current payments don't cover the interest. Raise the monthly amount on the Net Worth & Debt tab.", action: { label: "See payoff plan", tab: "networth" }, why: "Paying off a 25% APR card is a guaranteed 25% return, which no investment matches." });
  }

  // Credit
  const util = bs.cardLimit > 0 ? bs.cardDebt / bs.cardLimit : 0, score = bank.creditScore;
  if (util > 0.3) {
    add({ priority: "med", tag: "Credit", horizons: ["short"], title: `Card utilization is ${pct(util)}; get it under 30%, ideally under 10%`, body: `Paying the card down to ${money(bs.cardLimit * 0.3)} or less helps your score fastest. Utilization is 30% of your score.`, why: "It's the second-biggest score factor after payment history." });
  } else if (util > 0.1) {
    add({ priority: "low", tag: "Credit", horizons: ["short"], title: `Utilization at ${pct(util)}: good, under 10% is better`, body: "Paying the statement balance in full before the due date keeps reported utilization low.", why: "Utilization is 30% of your score." });
  }
  if (score < 600) {
    add({ priority: "high", tag: "Credit", horizons: ["short", "medium"], title: `Credit score ${score} will make loans expensive or impossible`, body: "Turn on autopay for every bill (payment history is 35% of your score), keep balances low, and avoid opening several cards at once.", why: "Below 600 often means denial or very high rates." });
  } else if (score < 700) {
    add({ priority: "low", tag: "Credit", horizons: ["medium"], title: `Push your ${score} score into the 700s before a big loan`, body: "On-time payments, low utilization and keeping old accounts open make the difference. A car loan or mortgage in the high 700s costs much less.", why: "600–700 is decent but means higher interest rates." });
  }

  // 50/30/20 from real spending
  const needsPct = t.needs / t.income, wantsPct = t.wants / t.income, savePct = t.savings / t.income;
  if (needsPct > 0.5) {
    const top = monthCategories(LAST_FULL).filter((c) => c.bucket === "needs").slice(0, 2).map((c) => CATS[c.cat].label.toLowerCase()).join(" and ");
    add({ priority: "med", tag: "Budget", horizons: ["short"], title: `Needs were ${pct(needsPct)} of income in ${monthLabel} (target 50%)`, body: `That's ${money(t.needs - t.income * 0.5)}/mo over. Your biggest needs are ${top}. Call your phone, internet and insurance providers and ask for a cheaper plan (they'd rather keep you), compare grocery prices per unit, and consider a smaller place when your lease ends.`, why: "Lower fixed costs free money for every goal." });
  }
  if (wantsPct > 0.3) {
    add({ priority: "med", tag: "Budget", horizons: ["short"], title: `Wants were ${pct(wantsPct)} of income (target 30%)`, body: `Bringing them to ${money(t.income * 0.3)} frees ${money(t.wants - t.income * 0.3)}/mo for savings.`, why: "The 50/30/20 rule is a starting point you can adjust." });
  }
  if (savePct < 0.2) {
    add({ priority: "med", tag: "Savings", horizons: ["short", "medium", "long"], title: `You saved ${pct(savePct, 1)} of income in ${monthLabel}; target is 20% (${money(t.income * 0.2)})`, body: `Close the ${money(t.income * 0.2 - t.savings)}/mo gap with an automatic transfer the day your paycheck lands, split across your savings buckets.`, why: "Savings fund your emergency cushion, big purchases and retirement." });
  } else {
    add({ priority: "good", tag: "Savings", title: `You saved ${pct(savePct, 1)} of income`, body: "That meets the 20% target. Make sure each dollar has a goal attached.", why: "Savings rate matters most early on." });
  }

  // Spending trends: category up >25% vs the two months before
  const fullMonths = MONTHS.filter((x) => x !== currentYM);
  if (fullMonths.length >= 3) {
    const prev = (cat) => fullMonths.slice(1, 3).reduce((s, ym) => s + (monthCategories(ym).find((c) => c.cat === cat)?.amount || 0), 0) / 2;
    monthCategories(LAST_FULL)
      .filter((c) => ["wants", "needs"].includes(c.bucket) && c.amount > 40 && prev(c.cat) > 0 && c.amount > prev(c.cat) * 1.25)
      .slice(0, 2)
      .forEach((c) => add({ priority: "low", tag: "Trend", horizons: ["short"], title: `${CATS[c.cat].label} rose to ${money(c.amount)} in ${monthLabel}`, body: `That's ${pct(c.amount / prev(c.cat) - 1)} above your usual ${money(prev(c.cat))}.`, why: "Small monthly creep adds up over a year." }));
  }

  // Subscriptions
  const subs = recurring().filter((r) => r.isSub);
  const subTotal = subs.reduce((s, r) => s + r.amount, 0);
  subs.filter((r) => r.priceUp).forEach((u) => add({ priority: "low", tag: "Subscriptions", horizons: ["short"], title: `${titleCase(u.merchant)} went up from ${cents(u.priceUp.from)} to ${cents(u.priceUp.to)}`, body: `You pay ${money(subTotal)}/mo (${money(subTotal * 12)}/yr) across ${subs.length} subscriptions. Cancel the ones you don't use, or ask for a retention offer.`, action: { label: "Review subscriptions", tab: "activity" }, why: "Price increases are easy to miss." }));

  const uncat = txIn(LAST_FULL).filter((x) => catOf(x) === "uncategorized");
  if (uncat.length) {
    add({ priority: "low", tag: "Budget", horizons: ["short"], title: `${uncat.length} transactions in ${monthLabel} aren't categorized`, body: `${money(-uncat.reduce((s, x) => s + x.amount, 0))} isn't counted as a need or a want yet. Categorize them on the Activity tab, or let the AI do it.`, action: { label: "Categorize", tab: "activity" }, why: "An accurate budget needs every dollar sorted." });
  }

  // Goals
  let goalNeed = 0;
  for (const g of state.goals) {
    const h = horizonOf(num(g.years));
    const rate = g.kind === "emergency" ? 0 : SAVINGS_GROWTH[h];
    const need = requiredMonthly(goalTarget(g), goalSaved(g), num(g.years), rate);
    goalNeed += need;
    add(goalAdvice(g, h, need, rate, t, m, monthsCovered));
  }
  if (state.goals.length && goalNeed > t.savings + Math.max(0, t.left)) {
    add({ priority: "high", tag: "Goals", horizons: ["short", "medium", "long"], title: `Your goals need ${money(goalNeed)}/mo but you saved ${money(t.savings)} in ${monthLabel}`, body: "Something has to give: extend a deadline, lower a target, or free up money from wants. Rank goals by order: emergency fund, high-interest debt, then everything else.", action: { label: "Ask the assistant to rebalance", ask: "My goals need more per month than I'm saving. Help me prioritize and rebalance them using my real spending." }, why: "A SMART goal must be achievable and realistic." });
  }

  // Investing readiness
  if (!hi.length && monthsCovered >= 3) {
    add({ priority: "low", tag: "Investing", horizons: ["long"], title: "You're ready to invest more for the long term", body: "Diversify, for example with a broad index fund like the S&P 500, which has historically returned ~10%/yr (6–7% after inflation). Max the 401(k) match first, then your Roth IRA.", why: "Basics are covered: budget, emergency fund, no high-interest debt." });
  } else {
    add({ priority: "low", tag: "Investing", horizons: ["long"], title: "Keep investing steady until the basics are done", body: "Your Roth IRA contribution is a good habit. Finish the emergency fund and pay off the high-interest card before increasing it, but always take any employer 401(k) match because it's free money.", why: "Investing without a foundation is like building a house on sand." });
  }

  if (persona) add({ priority: "low", tag: `${persona.name} tip`, title: persona.tips[0], body: persona.desc, why: `From your money-personality score of ${persona.score}.` });

  add({ priority: "low", tag: "Protection", horizons: ["short", "long"], title: "Check your insurance before you need it", body: "Health, renters or home, auto and, if anyone depends on you, life insurance move big risks off your balance sheet. Know your deductibles and co-pays.", why: "The best time to buy insurance is before something happens." });
  add({ priority: "low", tag: "Scams", horizons: ["short", "medium", "long"], title: "If it sounds too good to be true, it is", body: "The bank will never ask for your password or one-time code. Guaranteed high returns and urgency are red flags. Slow down before moving money.", why: "Scammers target emotion, and AI makes them more convincing." });

  return rank(out);
}

function goalAdvice(g, h, need, rate, t, m, efMonths) {
  const label = { short: "short-term", medium: "medium-term", long: "long-term" }[h];
  const vehicle = { short: "a high-yield savings account (liquid and safe)", medium: "a high-yield savings account or CDs, plus some bonds for the later years", long: "diversified, low-cost index funds in tax-advantaged accounts" }[h];
  const share = t.savings > 0 ? need / t.savings : Infinity;
  const priority = need === 0 ? "good" : share > 1 ? "high" : share > 0.6 ? "med" : "low";
  const linked = g.accountId && acct(g.accountId);
  const target = goalTarget(g);
  const base = need === 0
    ? `You're on track: ${linked ? `your ${linked.name} already holds` : "what you've saved covers"} ${money(target)}.`
    : `Set aside ${money(need)}/mo for ${fmtMonths(Math.round(num(g.years) * 12))}${rate ? ` (assuming ~${pct(rate)}/yr growth)` : ""}. That's ${Number.isFinite(share) ? pct(share) : "more than all"} of what you saved last month.${linked ? ` Schedule it as an automatic transfer into ${linked.name}.` : ""}`;
  const extra = {
    emergency: " Keep it in a separate account you don't see every day.",
    purchase: " Don't finance it on a credit card.",
    college: ` Look at the full cost (tuition, books, fees, housing, transport), not just the sticker price. Apply for grants and scholarships before taking loans, and talk to graduates of the program about real job outcomes. For grad school, count the salary you won't earn while studying.${h !== "short" ? " In the US, a 529 plan grows tax-free for education." : ""}`,
    home: ` On the Mortgage tab, this price means about ${money(m.monthlyAll)}/mo with taxes and insurance (${t.income ? pct(m.monthlyAll / t.income) : "–"} of take-home), versus ${money(m.rent)} rent today. 20% down avoids PMI.`,
    retirement: " Time matters more than the amount. Take the full employer 401(k) match first, then your Roth IRA. Raise contributions by 1% each year.",
    debt: " Use the avalanche method on the Net Worth & Debt tab and pay cards in full afterward.",
  }[g.kind] || "";
  const efWarn = g.kind !== "emergency" && efMonths < 3 && h !== "long" ? " Fund your emergency cushion alongside this one." : "";
  return { priority, tag: `${label} goal`, horizons: [h], title: `${g.name}: ${money(target)} in ${fmtYears(num(g.years))}`, body: base + extra + efWarn, why: `Best home for ${label} money: ${vehicle}.`, action: { label: "Ask the assistant", ask: `Help me plan for my goal "${g.name}" (${money(target)} in ${fmtYears(num(g.years))}). What's realistic given my spending, and where should the money go?` } };
}

const PRIORITY_ORDER = { high: 0, med: 1, low: 2, good: 3 };
function rank(list) { return list.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]); }
function fmtMonths(n) { if (n < 12) return `${n} month${n === 1 ? "" : "s"}`; const y = Math.floor(n / 12), r = n % 12; return `${y} yr${y > 1 ? "s" : ""}${r ? ` ${r} mo` : ""}`; }
function fmtYears(y) { return y < 1 ? fmtMonths(Math.round(y * 12)) : `${+y.toFixed(2)} yr${y === 1 ? "" : "s"}`; }
function titleCase(s) { return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()); }

function renderAdvice(el, items, limit) {
  const list = limit ? items.slice(0, limit) : items;
  const pClass = { high: "p-high", med: "p-med", low: "", good: "p-good" };
  const pText = { high: "Act now", med: "Next", low: "Tip", good: "On track" };
  el.innerHTML = list.map((a, i) => `
    <li class="${pClass[a.priority]}">
      <div>
        <h3>${esc(a.title)} <span class="pill">${esc(a.tag)}</span> <span class="status ${a.priority === "high" ? "bad" : a.priority === "med" ? "warn" : a.priority === "good" ? "good" : ""}">${pText[a.priority]}</span></h3>
        <p>${esc(a.body)}</p>
        <p class="why">Why: ${esc(a.why)}</p>
        ${a.action ? `<button class="btn link small-link" data-advice-action="${i}">${esc(a.action.label)} →</button>` : ""}
      </div>
    </li>`).join("") || `<li><div><p>Nothing to flag right now.</p></div></li>`;
  el._items = list;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-advice-action]");
  if (!b) return;
  const a = b.closest(".advice-list")._items[+b.dataset.adviceAction].action;
  if (a.ask) { selectTab("assistant"); askAssistant(a.ask); }
  else selectTab(a.tab);
});

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
  const t = totals(LAST_FULL), el = $("#splitChart");
  $("#splitMonthLabel").textContent = `${monthName(LAST_FULL)} · from your transactions`;
  const rows = [
    { label: "Needs", color: "var(--s-needs)", v: t.needs, target: 0.5 },
    { label: "Wants", color: "var(--s-wants)", v: t.wants, target: 0.3 },
    { label: "Savings", color: "var(--s-savings)", v: t.savings, target: 0.2 },
  ];
  const W = 520, rowH = 44, padL = 70, padR = 110, H = rows.length * rowH + 26;
  const maxPct = Math.max(0.6, ...rows.map((r) => (t.income ? r.v / t.income : 0))) * 1.05;
  const x = (p) => padL + (p / maxPct) * (W - padL - padR);
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].filter((p) => p <= maxPct);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Needs, wants and savings as a share of income compared with 50/30/20 targets">`;
  ticks.forEach((p) => { svg += `<line class="grid-line" x1="${x(p)}" x2="${x(p)}" y1="0" y2="${H - 22}"/><text class="axis-label" x="${x(p)}" y="${H - 6}" text-anchor="middle">${pct(p)}</text>`; });
  rows.forEach((r, i) => {
    const share = t.income ? r.v / t.income : 0, y = i * rowH + 10, bh = 20;
    svg += `<text x="${padL - 10}" y="${y + bh / 2 + 4}" text-anchor="end" style="fill:var(--ink);font-weight:600">${r.label}</text>`;
    svg += `<path d="${barPath(padL, y, Math.max(0, x(share) - padL), bh, 4)}" fill="${r.color}"/>`;
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
  series.forEach((s, i) => {
    const d = s.data.map((v, j) => `${j ? "L" : "M"}${x(j).toFixed(1)},${y(v).toFixed(1)}`).join("");
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    svg += `<text x="${x(years) + 8}" y="${y(s.data[years]) + (i === 0 ? -4 : 12)}" style="fill:var(--ink);font-weight:600">${money(s.data[years])}</text>`;
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
  const score = bank.creditScore, bs = balanceSheet(), el = $("#creditGauge");
  const band = score >= 740 ? ["good", "Very good: you qualify for most loans at the best rates"] : score >= 700 ? ["good", "Good"] : score >= 600 ? ["warn", "Decent: expect somewhat higher interest rates"] : ["bad", "Poor: loans may be denied or very expensive"];
  const pos = (Math.min(850, Math.max(300, score)) - 300) / 550;
  const util = bs.cardLimit > 0 ? bs.cardDebt / bs.cardLimit : 0;
  el.innerHTML = `
    <div class="score-big">${score}</div>
    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted)"><span>300</span><span>600</span><span>700</span><span>850</span></div>
    <div class="bar" style="height:10px;position:relative;background:linear-gradient(90deg,var(--gauge-bad) 0 54.5%,var(--gauge-mid) 54.5% 72.7%,var(--gauge-good) 72.7%)">
      <span style="position:absolute;left:calc(${(pos * 100).toFixed(1)}% - 2px);width:4px;top:-4px;height:18px;background:var(--ink);border-radius:2px"></span>
    </div>
    <p style="margin:10px 0 4px"><span class="status ${band[0]}">${band[1]}</span></p>
    <p class="small" style="margin:0">Card utilization: <strong>${pct(util)}</strong> of ${money(bs.cardLimit)} limit <span class="status ${util > 0.3 ? "bad" : util > 0.1 ? "warn" : "good"}">${util > 0.3 ? "High" : util > 0.1 ? "OK" : "Great"}</span></p>`;
}

// ---------------------------------------------------------------- overview
const KIND_LABEL = { checking: "Checking", savings: "Savings", credit: "Credit card", loan: "Loan", investment: "Investment", retirement: "Retirement" };
function renderAccountStrip() {
  $("#syncLine").textContent = `${bank.accounts.length} linked accounts · updated ${shortDate(today)} · demo data`;
  $("#accountStrip").innerHTML = bank.accounts.map((a) => {
    const debt = a.kind === "credit" || a.kind === "loan";
    const sub = a.kind === "credit" ? `${pct(a.balance / a.limit)} of ${money(a.limit)} limit · ${a.apr}% APR`
      : a.kind === "loan" ? `${a.apr}% APR · ${money(a.minPayment)}/mo`
      : a.apy ? `${a.apy}% APY${a.role === "emergency" ? " · emergency fund" : ""}` : a.external ? "From another institution" : "";
    return `<div class="acct ${debt ? "debt" : ""}">
      <span class="acct-kind">${KIND_LABEL[a.kind]}${a.external ? " · external" : ""}</span>
      <span class="acct-name">${esc(a.name)} <span class="mask">••${a.mask}</span></span>
      <span class="acct-bal">${debt ? "−" : ""}${cents(a.balance)}</span>
      <span class="acct-sub">${sub}</span>
    </div>`;
  }).join("");
}

function renderUpcoming() {
  const payday = nextPayday(), bs = balanceSheet();
  const list = recurring().filter((r) => r.nextDate < payday);
  $("#paydayLabel").textContent = `Next paycheck ${shortDate(payday)}`;
  const fromChk = list.filter((r) => r.account === "chk").reduce((s, r) => s + r.amount, 0);
  $("#upcomingList").innerHTML = list.map((r) => `
    <li><span class="date">${shortDate(r.nextDate)}</span>
      <span class="who">${esc(titleCase(r.merchant))}<small>${r.account === "card" ? "Credit card" : "Checking"}${r.priceUp ? ` · <span class="status warn">price up</span>` : ""}</small></span>
      <span class="amt">${cents(r.amount)}</span></li>`).join("") +
    `<li class="proj"><span></span><span class="who">Checking after these bills</span><span class="amt"><span class="status ${bs.checking - fromChk < 100 ? "bad" : "good"}">${cents(bs.checking - fromChk)}</span></span></li>`;
}

function renderOverview() {
  const t = totals(LAST_FULL), bs = balanceSheet();
  $("#heroName").textContent = state.name;
  $("#kpiNetWorth").textContent = money(bs.net);
  $("#kpiNetWorthSub").textContent = `${money(bs.assets)} assets − ${money(bs.debts)} liabilities`;
  $("#kpiIncomeLabel").textContent = `Take-home income, ${monthName(LAST_FULL, "short")}`;
  $("#kpiIncome").textContent = money(t.income);
  $("#kpiIncomeSub").textContent = "Paychecks and side income deposited";
  $("#kpiSavings").textContent = money(t.savings);
  $("#kpiSavingsSub").innerHTML = `${t.income ? pct(t.savings / t.income, 1) : "0%"} of income · target 20%`;
  const months = t.needs ? bs.emergency / t.needs : 0;
  $("#kpiEmergency").textContent = money(bs.emergency);
  $("#kpiEmergencySub").innerHTML = `<span class="status ${months >= 3 ? "good" : months >= 1 ? "warn" : "bad"}">${months.toFixed(1)} months of needs</span> · target 3–6`;
  $("#kpiDebt").textContent = money(bs.debts);
  const plan = payoffPlan();
  $("#kpiDebtSub").textContent = plan && !plan.stuck ? `Non-mortgage debt gone in ${fmtMonths(plan.months)}` : "Raise payments to finish";
  $("#kpiCredit").textContent = bank.creditScore;
  $("#kpiCreditSub").textContent = `Utilization ${pct(bs.cardLimit ? bs.cardDebt / bs.cardLimit : 0)} · aim under 30%`;
  renderAccountStrip();
  renderUpcoming();
  renderSplitChart();
}

// ---------------------------------------------------------------- activity
function monthOptions(sel, value, includeAll) {
  sel.innerHTML = (includeAll ? `<option value="all">All recent activity</option>` : "") +
    MONTHS.map((m) => `<option value="${m}"${m === value ? " selected" : ""}>${monthName(m)}${m === currentYM ? " (so far)" : ""}</option>`).join("");
}
function catSelect(t) {
  const c = catOf(t);
  return `<select class="cat-select" data-merchant="${esc(t.merchant)}" aria-label="Category for ${esc(t.merchant)}">${Object.entries(CATS)
    .filter(([k, v]) => (t.amount > 0 ? v.bucket === "income" || k === "uncategorized" : v.bucket !== "income") && (k !== "card_payment" || c === "card_payment"))
    .map(([k, v]) => `<option value="${k}"${k === c ? " selected" : ""}>${v.label}</option>`).join("")}</select>`;
}
const BUCKET_LABEL = { income: "Income", needs: "Need", wants: "Want", savings: "Savings", transfer: "Transfer", unassigned: "Uncategorized" };
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

function renderActivity() {
  const q = $("#txSearch").value.trim().toLowerCase(), m = $("#txMonth").value, b = $("#txBucket").value;
  const rows = bank.transactions.filter((t) => (m === "all" || t.date.startsWith(m)) && (b === "all" || bucketOf(t) === b) && (!q || t.merchant.toLowerCase().includes(q)));
  let lastDate = "";
  $("#txTable tbody").innerHTML = rows.map((t) => {
    const head = t.date !== lastDate ? `<tr class="day"><td colspan="3">${new Date(`${t.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</td></tr>` : "";
    lastDate = t.date;
    const bk = bucketOf(t), a = acct(t.account);
    return `${head}<tr data-cat="${catOf(t)}">
      <td><span class="merchant">${esc(titleCase(t.merchant))}</span><span class="acct-small">${esc(a.name)} ••${a.mask} · <span class="bucket b-${bk}">${BUCKET_LABEL[bk]}</span>${state.merchantCat[t.merchant] ? " · edited" : ""}</span></td>
      <td>${catSelect(t)}</td>
      <td class="num ${t.amount > 0 ? "in" : ""}">${t.amount > 0 ? "+" : "−"}${cents(Math.abs(t.amount))}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="3" class="muted">No transactions match.</td></tr>`;
  $("#txCount").textContent = `${rows.length} transaction${rows.length === 1 ? "" : "s"}`;

  const uncatMerchants = [...new Set(bank.transactions.filter((t) => catOf(t) === "uncategorized").map((t) => t.merchant))];
  $("#uncatBanner").innerHTML = uncatMerchants.length ? `<div class="banner"><span><strong>${uncatMerchants.length} merchant${uncatMerchants.length > 1 ? "s" : ""}</strong> couldn't be categorized automatically.</span><button class="btn primary small" id="aiCategorize">Categorize with AI</button></div>` : "";

  const rec = recurring();
  const subsTotal = rec.filter((r) => r.isSub).reduce((s, r) => s + r.amount, 0);
  $("#recurringList").innerHTML = rec.map((r) => `
    <li><span class="who">${esc(titleCase(r.merchant))}<small>${CATS[r.cat].label} · around the ${ordinal(r.day)} · next ${shortDate(r.nextDate)}</small></span>
      <span class="amt">${cents(r.amount)}${r.priceUp ? `<small class="status warn">↑ from ${cents(r.priceUp.from)}</small>` : ""}</span></li>`).join("") +
    `<li class="proj"><span class="who">Subscriptions total</span><span class="amt">${cents(subsTotal)}/mo<small>${money(subsTotal * 12)}/yr</small></span></li>`;

  const ym = m === "all" ? LAST_FULL : m;
  $("#catMonthLabel").textContent = monthName(ym);
  const cats = monthCategories(ym).filter((c) => ["needs", "wants", "unassigned"].includes(c.bucket));
  const max = Math.max(1, ...cats.map((c) => c.amount));
  $("#catBars").innerHTML = cats.map((c) => `<li><span class="lbl">${CATS[c.cat].label}</span>
    <span class="track"><span style="width:${(c.amount / max * 100).toFixed(1)}%;background:${c.bucket === "needs" ? "var(--s-needs)" : c.bucket === "wants" ? "var(--s-wants)" : "var(--muted)"}"></span></span>
    <span class="amt">${money(c.amount)}</span></li>`).join("") +
    `<li class="cat-legend"><span><i style="background:var(--s-needs)"></i>Need</span><span><i style="background:var(--s-wants)"></i>Want</span></li>`;
}

// ---------------------------------------------------------------- budget sheet (auto from transactions + manual lines)
function renderBudget() {
  const ym = state.budgetMonth || LAST_FULL;
  monthOptions($("#budgetMonth"), ym, false);
  const cats = monthCategories(ym), man = (state.manual[ym] ||= { income: [], needs: [], wants: [], savings: [] });
  GROUPS.forEach((g) => {
    const autoRows = cats.filter((c) => c.bucket === g).map((c) => `
      <tr class="auto-row" data-cat="${c.cat}" tabindex="0" title="Show these transactions">
        <td><span class="cell-text">${CATS[c.cat].label}<span class="chip-auto">auto · ${c.count}</span></span></td>
        <td class="num"><span class="cell-text">${cents(c.amount)}</span></td><td></td>
      </tr>`).join("");
    const manualRows = (man[g] || []).map((l) => `
      <tr data-id="${l.id}">
        <td><input aria-label="${g} item name" data-field="name" value="${esc(l.name)}" placeholder="Cash item"/></td>
        <td><input aria-label="${g} amount" data-field="amount" type="number" min="0" step="5" value="${l.amount ?? ""}" placeholder="0"/></td>
        <td><button class="icon-btn" data-remove title="Remove line" aria-label="Remove ${esc(l.name)}">×</button></td>
      </tr>`).join("");
    $(`[data-group="${g}"] tbody`).innerHTML = autoRows + manualRows || `<tr><td colspan="2" class="empty-cell">Nothing yet this month</td><td></td></tr>`;
  });
  updateBudgetTotals();
}

function updateBudgetTotals() {
  const ym = state.budgetMonth || LAST_FULL, t = totals(ym);
  GROUPS.forEach((g) => { $(`[data-total="${g}"]`).textContent = money(t[g]); });
  const targets = { needs: 0.5, wants: 0.3, savings: 0.2 };
  Object.entries(targets).forEach(([g, p]) => {
    const share = t.income ? t[g] / t.income : 0;
    const off = g === "savings" ? share < p : share > p;
    $(`[data-target="${g}"]`).innerHTML = `target ${money(t.income * p)} · <span class="status ${off ? "warn" : "good"}">${pct(share)}</span>`;
  });
  const rows = [
    ["Total Income", t.income, null],
    ["Total Needs", t.needs, t.income ? t.needs / t.income : 0],
    ["Total Wants", t.wants, t.income ? t.wants / t.income : 0],
    ["Total Savings", t.savings, t.income ? t.savings / t.income : 0],
  ];
  if (t.unassigned) rows.push(["Uncategorized", t.unassigned, t.income ? t.unassigned / t.income : 0]);
  rows.push([ym === currentYM ? "Left so far" : "Left over", t.left, null]);
  $("#monthlySummary").innerHTML = rows.map(([k, v, s]) => `<tr><td>${k}${s != null ? `<span class="pct">${pct(s, 1)}</span>` : ""}</td><td${v < 0 ? ' style="color:var(--red)"' : ""}>${money(v)}</td></tr>`).join("");
}

// ---------------------------------------------------------------- net worth
function renderBalance() {
  const assets = bank.accounts.filter((a) => ASSET_KINDS.includes(a.kind));
  $("#linkedAssets").innerHTML = assets.map((a) => `<li><span>${esc(a.name)} <span class="mask">••${a.mask}</span><small>${KIND_LABEL[a.kind]}${a.external ? " · external" : ""} · linked</small></span><strong>${cents(a.balance)}</strong></li>`).join("");
  $("#linkedDebts").innerHTML = linkedDebts().map((d) => `<li><span>${esc(d.name)}<small>${DEBT_TYPES[d.type]} · ${d.apr}% APR · ${money(d.min)}/mo min · linked</small></span><strong>${cents(d.balance)}</strong></li>`).join("");
  $("#assetsTable tbody").innerHTML = state.manualAssets.map((a) => `
    <tr data-id="${a.id}">
      <td><input aria-label="Asset name" data-field="name" value="${esc(a.name)}"/></td>
      <td><input aria-label="Asset value" data-field="value" type="number" min="0" step="100" value="${a.value}" style="text-align:right"/></td>
      <td><button class="icon-btn" data-remove aria-label="Remove ${esc(a.name)}">×</button></td>
    </tr>`).join("");
  $("#assetsTable").hidden = !state.manualAssets.length;
  $("#debtsTable").hidden = !state.manualDebts.length;
  $("#debtsTable tbody").innerHTML = state.manualDebts.map((d) => `
    <tr data-id="${d.id}">
      <td><input aria-label="Debt name" data-field="name" value="${esc(d.name)}"/></td>
      <td data-label="Type"><select aria-label="Debt type" data-field="type">${Object.entries(DEBT_TYPES).map(([k, v]) => `<option value="${k}"${k === d.type ? " selected" : ""}>${v}</option>`).join("")}</select></td>
      <td data-label="Balance"><input aria-label="Balance" data-field="balance" type="number" min="0" step="100" value="${d.balance}" style="text-align:right"/></td>
      <td data-label="APR %"><input aria-label="APR percent" data-field="apr" type="number" min="0" step="0.1" value="${d.apr}" style="text-align:right"/></td>
      <td data-label="Min / mo"><input aria-label="Minimum monthly payment" data-field="min" type="number" min="0" step="5" value="${d.min}" style="text-align:right"/></td>
      <td><button class="icon-btn" data-remove aria-label="Remove ${esc(d.name)}">×</button></td>
    </tr>`).join("");
  $("#extraDebt").value = state.extraDebt;
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
  if (!plan) el.innerHTML = `<p class="status good">No non-mortgage debt. Nice work.</p>`;
  else if (plan.stuck) el.innerHTML = `<p class="status bad">At ${money(plan.budget)}/mo the balances never reach zero. Increase your payment.</p>`;
  else {
    const diff = other.interestPaid - plan.interestPaid;
    el.innerHTML = `
      <div class="result-grid">
        <div><span class="label">Debt-free in</span><span class="value">${fmtMonths(plan.months)}</span></div>
        <div><span class="label">Total interest</span><span class="value">${money(plan.interestPaid)}</span></div>
        <div><span class="label">Paying each month</span><span class="value">${money(plan.budget)}</span></div>
        <div><span class="label">vs ${state.payoffMethod === "avalanche" ? "snowball" : "avalanche"}</span><span class="value" style="color:${diff >= 0 ? "var(--green)" : "var(--amber)"}">${diff >= 0 ? "saves " : "costs "}${money(Math.abs(diff))}</span></div>
      </div>
      <p class="small" style="margin:12px 0 0"><strong>Order:</strong> ${plan.paidOff.map((p) => `${esc(p.name)} (month ${p.month})`).join(" → ")}</p>
      <p class="muted small" style="margin:6px 0 0">${state.payoffMethod === "avalanche" ? "Avalanche targets the highest APR first, which costs the least interest." : "Snowball clears the smallest balance first for quick wins and motivation."} Balances, rates and minimums come from your linked accounts. Mortgages are left out.</p>`;
  }
  renderCreditGauge();
}

// ---------------------------------------------------------------- mortgage tab
function renderHome() {
  $$("[data-home]").forEach((i) => { i.value = i.dataset.home === "rent" ? (state.home.rent ?? detectedRent()) : state.home[i.dataset.home]; });
  updateHome();
}
function updateHome() {
  const m = mortgage(), t = totals(LAST_FULL), ratio = t.income ? m.monthlyAll / t.income : 0;
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
        <tr><td>Rent</td><td>–</td><td>${money(num(m.rent) * 12)}</td></tr>
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
  { label: "Emergency fund", name: "Emergency fund: 6 months of needs", kind: "emergency", years: 1, accountId: "sav", target: () => totals(LAST_FULL).needs * 6 },
  { label: "Laptop in 6 months", name: "New laptop", kind: "purchase", years: 0.5, accountId: "bucket", target: () => 2000 },
  { label: "College in 4 years", name: "College fund", kind: "college", years: 4, accountId: "", target: () => 40000 },
  { label: "Home down payment", name: "Down payment for a home", kind: "home", years: 5, accountId: "", target: () => num(state.home.down) || 100000 },
  { label: "Retire in 30 years", name: "Retirement nest egg", kind: "retirement", years: 30, accountId: "ira", target: () => 1000000 },
  { label: "Pay off credit card", name: "Pay off credit card", kind: "debt", years: 1, accountId: "", target: () => balanceSheet().cardDebt },
];
function renderGoalForm() {
  $("#goalPresets").innerHTML = PRESETS.map((p, i) => `<button type="button" data-preset="${i}">${p.label}</button>`).join("");
  $("#goalAccount").innerHTML = `<option value="">Nothing linked yet</option>` + bank.accounts.filter((a) => ["savings", "investment", "retirement"].includes(a.kind))
    .map((a) => `<option value="${a.id}">${esc(a.name)} ••${a.mask} (${money(a.balance)})</option>`).join("");
}
function renderGoals() {
  const t = totals(LAST_FULL);
  $("#goalList").innerHTML = state.goals.map((g) => {
    const h = horizonOf(num(g.years)), rate = g.kind === "emergency" ? 0 : SAVINGS_GROWTH[h];
    const target = goalTarget(g), saved = goalSaved(g);
    const need = requiredMonthly(target, saved, num(g.years), rate);
    const progress = Math.min(1, saved / Math.max(1, target));
    const a = g.accountId && acct(g.accountId);
    return `<li data-id="${g.id}">
      <div class="goal-top"><strong>${esc(g.name)}</strong><button class="icon-btn" data-remove-goal aria-label="Remove ${esc(g.name)}">×</button></div>
      <div class="bar"><span style="width:${(progress * 100).toFixed(1)}%"></span></div>
      <div class="goal-meta">
        <span>${money(saved)} of ${money(target)} (${pct(progress)})</span>
        <span>${fmtYears(num(g.years))} · ${h} term</span>
        <span>Needs <strong>${money(need)}/mo</strong>${t.savings ? ` (${pct(need / t.savings)} of last month's savings)` : ""}</span>
        ${a ? `<span class="linked">Tracks ${esc(a.name)} ••${a.mask}</span>` : ""}
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
  el.innerHTML = `<strong>${p.name}</strong> · ${p.score} points<p class="small" style="margin:4px 0">${esc(p.desc)}</p><ul class="small" style="margin:0;padding-left:18px">${p.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
}

// ---------------------------------------------------------------- global refresh
function refresh() {
  save();
  const advice = advise();
  renderOverview();
  updateHome();
  renderGoals();
  renderAdvice($("#topAdvice"), advice.filter((a) => a.priority !== "good"), 4);
  renderAdvice($("#budgetAdvice"), advice.filter((a) => ["Budget", "Savings", "Emergency fund", "Cash flow", "Trend"].includes(a.tag)));
  const h = state.horizon;
  renderAdvice($("#allAdvice"), h === "all" ? advice : advice.filter((a) => a.horizons.includes(h)));
  $$("[data-horizon]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.horizon === h)));
}

// ---------------------------------------------------------------- events
function selectTab(name) {
  $$(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  try { localStorage.setItem("learnfi.tab", name); } catch { /* ignore */ }
  window.scrollTo({ top: 0 });
}
$$(".tabs [role=tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
$$("[data-goto]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.goto)));

// activity
["#txSearch", "#txMonth", "#txBucket"].forEach((s) => $(s).addEventListener("input", renderActivity));
$("#tab-activity").addEventListener("change", (e) => {
  const sel = e.target.closest(".cat-select");
  if (!sel) return;
  state.merchantCat[sel.dataset.merchant] = sel.value;
  renderActivity(); renderBudget(); refresh();
});
$("#tab-activity").addEventListener("click", (e) => { if (e.target.id === "aiCategorize") aiCategorize(e.target); });

// budget
$("#budgetMonth").addEventListener("change", (e) => { state.budgetMonth = e.target.value; renderBudget(); save(); });
$("#tab-budget").addEventListener("input", (e) => {
  const row = e.target.closest("tr[data-id]"), block = e.target.closest("[data-group]");
  if (!row || !block) return;
  const ym = state.budgetMonth || LAST_FULL;
  const item = state.manual[ym][block.dataset.group].find((l) => l.id === row.dataset.id);
  item[e.target.dataset.field] = e.target.dataset.field === "amount" ? num(e.target.value) : e.target.value;
  updateBudgetTotals(); refresh();
});
function openCategory(row) {
  $("#txMonth").value = state.budgetMonth || LAST_FULL;
  $("#txBucket").value = "all";
  $("#txSearch").value = "";
  selectTab("activity");
  renderActivity();
  $$(`#txTable tbody tr[data-cat="${row.dataset.cat}"]`).forEach((tr) => tr.classList.add("hl"));
  $("#txTable tr.hl")?.scrollIntoView({ block: "center" });
}
$("#tab-budget").addEventListener("click", (e) => {
  const ym = state.budgetMonth || LAST_FULL;
  const add = e.target.closest("[data-add]");
  if (add) { state.manual[ym][add.dataset.add].push(line("", 0)); renderBudget(); refresh(); $(`[data-group="${add.dataset.add}"] tbody tr:last-child input`)?.focus(); return; }
  if (e.target.closest("[data-remove]")) {
    const row = e.target.closest("tr[data-id]"), g = e.target.closest("[data-group]").dataset.group;
    state.manual[ym][g] = state.manual[ym][g].filter((l) => l.id !== row.dataset.id);
    renderBudget(); refresh(); return;
  }
  const auto = e.target.closest("tr.auto-row");
  if (auto) openCategory(auto);
});
$("#tab-budget").addEventListener("keydown", (e) => { const r = e.target.closest("tr.auto-row"); if (r && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openCategory(r); } });

// net worth
$("#tab-networth").addEventListener("input", (e) => {
  const f = e.target.dataset.field, row = e.target.closest("tr[data-id]");
  if (row && f) {
    const list = e.target.closest("#assetsTable") ? state.manualAssets : state.manualDebts;
    const item = list.find((x) => x.id === row.dataset.id);
    item[f] = ["name", "type"].includes(f) ? e.target.value : num(e.target.value);
  } else if (e.target.id === "extraDebt") state.extraDebt = num(e.target.value);
  else return;
  updateBalance(); refresh();
});
$("#tab-networth").addEventListener("click", (e) => {
  if (e.target.closest("[data-add-asset]")) { state.manualAssets.push({ id: uid(), name: "", value: 0 }); renderBalance(); refresh(); return; }
  if (e.target.closest("[data-add-debt]")) { state.manualDebts.push({ id: uid(), name: "", type: "personal", balance: 0, apr: 0, min: 0 }); renderBalance(); refresh(); return; }
  const m = e.target.closest("[data-method]");
  if (m) { state.payoffMethod = m.dataset.method; renderBalance(); refresh(); return; }
  if (e.target.closest("[data-remove]")) {
    const row = e.target.closest("tr[data-id]");
    if (e.target.closest("#assetsTable")) state.manualAssets = state.manualAssets.filter((a) => a.id !== row.dataset.id);
    else state.manualDebts = state.manualDebts.filter((d) => d.id !== row.dataset.id);
    renderBalance(); refresh();
  }
});

// mortgage
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
  f.namedItem("target").value = Math.round(p.target()); f.namedItem("accountId").value = p.accountId;
  f.namedItem("target").focus();
});
$("#goalForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.elements, v = (n) => f.namedItem(n).value;
  state.goals.push({ id: uid(), name: v("name").trim(), kind: v("kind"), target: num(v("target")), accountId: v("accountId"), saved: 0, years: num(v("years")) });
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
  state.quiz[+e.target.name.slice(1)] = +e.target.value;
  renderQuizResult(); refresh();
});

// Two-step reset (no blocking dialogs): first click arms, second click within 4s confirms.
let resetArmed = null;
$("#resetBtn").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  if (!resetArmed) {
    btn.textContent = "Click again to reset";
    resetArmed = setTimeout(() => { resetArmed = null; btn.textContent = "Reset demo"; }, 4000);
    return;
  }
  clearTimeout(resetArmed); resetArmed = null; btn.textContent = "Reset demo";
  state = defaultState();
  renderAll();
});

// ---------------------------------------------------------------- AI
// One adapter, two transports: inside claude.ai the page's `sample` capability (no key needed);
// run locally, the Anthropic SDK with the user's own key (prototype only; in production the
// bank's backend makes this call and the key never reaches the browser).
const AI_MODEL = "claude-opus-5-5";
const samplePromise = window.claude?.use ? window.claude.use("sample") : Promise.resolve(null);
samplePromise.then((s) => { $("#aiSetup").hidden = !!s; });
try { $("#apiKey").value = sessionStorage.getItem("learnfi.key") || ""; } catch { /* ignore */ }
$("#apiKey").addEventListener("change", (e) => { try { sessionStorage.setItem("learnfi.key", e.target.value.trim()); } catch { /* ignore */ } });

class AIError extends Error { constructor(code, message, text) { super(message); this.code = code; this.text = text; } }

// turns: [{role:"user"|"assistant", content:string}], ending on user. For `sample`, system goes into the first turn.
async function aiComplete(system, turns, onText) {
  const sample = await samplePromise;
  if (sample) {
    const input = turns.map((t, i) => (i === 0 ? { role: t.role, content: `${system}\n\n---\n\n${t.content}` } : t));
    try {
      const r = await sample(input, { modelTier: "default", cache: false, onText: onText ? ({ text }) => onText(text) : undefined });
      return r.text;
    } catch (err) {
      const msg = { not_granted: "Claude isn't allowed on this page yet. Turn it on from the page's Permissions menu.", rate_limited: "Too many requests right now. Wait a minute and try again." }[err?.code] || "Claude couldn't finish. Try again in a moment.";
      throw new AIError(err?.code || "error", msg, err?.text);
    }
  }
  const apiKey = $("#apiKey").value.trim();
  if (!apiKey) throw new AIError("no_key", "Add an Anthropic API key on the Assistant tab to use AI features locally.");
  let Anthropic;
  try { ({ default: Anthropic } = await import("https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm")); }
  catch { throw new AIError("offline", "Couldn't load the Anthropic SDK. Check your connection."); }
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let text = "";
  try {
    const stream = client.beta.messages.stream({
      model: AI_MODEL, max_tokens: 16000, output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      system, messages: turns,
    });
    stream.on("text", (d) => { text += d; onText?.(text); });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new AIError("refusal", "The model declined this request. Try rephrasing.");
    return text;
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new AIError("auth", "That API key was rejected. Check it and try again.");
    if (err instanceof Anthropic.RateLimitError) throw new AIError("rate_limited", "Rate limited. Wait a moment and try again.");
    if (err instanceof Anthropic.APIConnectionError) throw new AIError("offline", "Couldn't reach the Claude API. Check your connection.");
    if (err instanceof Anthropic.APIError) throw new AIError("api", `Claude API error (${err.status ?? "unknown"}): ${err.message}`);
    throw new AIError("error", "Something went wrong talking to Claude.");
  }
}

function financialContext() {
  const t = totals(LAST_FULL), bs = balanceSheet(), m = mortgage(), p = personality();
  return {
    today: isoDate(today),
    accounts: bank.accounts.map((a) => ({ name: `${a.name} ••${a.mask}`, kind: a.kind, balance: a.balance, ...(a.apy ? { apy_pct: a.apy } : {}), ...(a.apr ? { apr_pct: a.apr, min_payment: a.minPayment } : {}), ...(a.limit ? { limit: a.limit } : {}), ...(a.role ? { role: a.role } : {}) })),
    other_assets: state.manualAssets.map((a) => ({ name: a.name, value: num(a.value) })),
    other_debts: state.manualDebts.map((d) => ({ name: d.name, type: d.type, balance: num(d.balance), apr_pct: num(d.apr), min_payment: num(d.min) })),
    net_worth: Math.round(bs.net),
    credit_score: bank.creditScore,
    budget_by_month: MONTHS.map((ym) => { const x = totals(ym); return { month: ym, partial: ym === currentYM, income: Math.round(x.income), needs: Math.round(x.needs), wants: Math.round(x.wants), savings: Math.round(x.savings), uncategorized: Math.round(x.unassigned), by_category: Object.fromEntries(monthCategories(ym).map((c) => [CATS[c.cat].label, Math.round(c.amount)])) }; }),
    last_full_month_split_pct: t.income ? { needs: +(t.needs / t.income * 100).toFixed(1), wants: +(t.wants / t.income * 100).toFixed(1), savings: +(t.savings / t.income * 100).toFixed(1) } : null,
    emergency_fund_months_of_needs: t.needs ? +(bs.emergency / t.needs).toFixed(1) : 0,
    recurring_bills: recurring().map((r) => ({ merchant: r.merchant, amount: r.amount, next: isoDate(r.nextDate), category: CATS[r.cat].label, ...(r.priceUp ? { price_increase_from: r.priceUp.from } : {}) })),
    next_paycheck: isoDate(nextPayday()),
    goals: state.goals.map((g) => ({ name: g.name, type: g.kind, target: goalTarget(g), saved: Math.round(goalSaved(g)), years: num(g.years), horizon: horizonOf(num(g.years)) })),
    home_scenario: { price: num(state.home.price), down_payment: num(state.home.down), rate_pct: num(state.home.rate), term_years: num(state.home.term), monthly_cost_with_tax_insurance: Math.round(m.monthlyAll), current_rent: m.rent },
    money_personality: p ? p.name : "not taken",
    advisor_flags: advise().filter((a) => a.priority === "high" || a.priority === "med").map((a) => a.title),
    transactions_csv: "date,merchant,amount,category,account\n" + bank.transactions.map((x) => `${x.date},${x.merchant.replace(/,/g, " ")},${x.amount},${CATS[catOf(x)].label},${acct(x.account).name}`).join("\n"),
  };
}

const ASSISTANT_SYSTEM = `You are the money assistant inside a bank's consumer app. You help one customer understand and improve their finances using their own account data, which is provided as JSON at the start of the conversation. Speak plainly to someone who may be new to personal finance.

Ground advice in this framework, in priority order: (1) a working budget, with 50/30/20 needs/wants/savings as an adjustable starting point; (2) an emergency fund of 3–6 months of needs in high-yield savings; (3) paying off high-interest debt (avalanche or snowball), then paying cards in full; (4) SMART goals: short term (<1 yr) in cash/HYSA, medium (1–5 yrs) in HYSA/CDs/some bonds, long (5+ yrs) in diversified low-cost index funds in tax-advantaged accounts (401(k) match first, then IRA/Roth IRA); (5) diversify and review regularly. Bring in inflation, credit score factors (payment history 35%, utilization 30%, history 15%, mix 10%, new credit 10%), rent vs buy, the true cost of college and financial aid, insurance and scam awareness when they're relevant.

Rules:
- Use the customer's real numbers: name merchants, months, balances and amounts from the data. Do the arithmetic.
- Answer the question that was asked first, then add at most one next step.
- You can't move money or change accounts. Suggest the action and say where in the app to do it (Activity, Monthly Budget, Net Worth & Debt, Mortgage, Goals & Advisor).
- Stay educational: no specific stocks, funds by ticker or third-party products by brand. Say when something depends on their country or tax situation.
- If the data doesn't answer the question, say what's missing.
- Format with short markdown: optional "## " headings, "- " bullets, **bold** for key numbers. Keep answers under about 250 words unless asked for a full plan.`;

// ---------------------------------------------------------------- assistant chat
const chat = []; // {role, content, display?}
const CHIPS = [
  "How much did I spend on eating out last month, and how does it compare?",
  "Which subscriptions should I cut?",
  "Can I afford a $2,000 laptop in 6 months without touching my emergency fund?",
  "Build me a 12-month plan",
  "Am I ready to buy a home, or should I keep renting?",
  "How do I start saving for college or grad school?",
];
function renderChips() { $("#chatChips").innerHTML = CHIPS.map((c) => `<button type="button" data-chip>${esc(c)}</button>`).join(""); }
function renderChat(streamingText) {
  const log = $("#chatLog");
  const msgs = chat.map((m) => `<div class="msg ${m.role}">${m.role === "user" ? `<p>${esc(m.display || m.content)}</p>` : renderMarkdown(m.content)}</div>`);
  if (streamingText != null) msgs.push(`<div class="msg assistant">${streamingText ? renderMarkdown(streamingText) : `<p class="muted">Looking at your accounts…</p>`}</div>`);
  log.innerHTML = msgs.join("") || `<div class="chat-empty"><strong>Ask anything about your money.</strong><p class="muted small">Try a suggestion below. Answers use your balances and transactions.</p></div>`;
  log.scrollTop = log.scrollHeight;
}
let chatBusy = false;
async function askAssistant(question) {
  if (chatBusy || !question.trim()) return;
  chatBusy = true; $("#chatSend").disabled = true;
  // The first turn carries the account context; later turns are plain questions.
  const content = chat.length ? question : `My account data (JSON):\n${JSON.stringify(financialContext())}\n\nMy question: ${question}`;
  chat.push({ role: "user", content, display: question });
  $("#chatInput").value = "";
  renderChat("");
  try {
    const answer = await aiComplete(ASSISTANT_SYSTEM, chat.map(({ role, content: c }) => ({ role, content: c })), (t) => renderChat(t));
    chat.push({ role: "assistant", content: answer });
    renderChat();
  } catch (err) {
    chat.pop();
    renderChat();
    $("#chatLog").insertAdjacentHTML("beforeend", `<div class="msg assistant">${err.text ? renderMarkdown(err.text) : ""}<p class="error">${esc(err.message)}</p></div>`);
    $("#chatInput").value = question;
  } finally {
    chatBusy = false; $("#chatSend").disabled = false;
  }
}
$("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); askAssistant($("#chatInput").value); });
$("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askAssistant($("#chatInput").value); } });
$("#chatChips").addEventListener("click", (e) => { const b = e.target.closest("[data-chip]"); if (b) askAssistant(b.textContent); });

// AI categorization of merchants the bank couldn't categorize
async function aiCategorize(btn) {
  const merchants = [...new Set(bank.transactions.filter((t) => catOf(t) === "uncategorized").map((t) => t.merchant))];
  if (!merchants.length) return;
  const allowed = Object.entries(CATS).filter(([, v]) => ["needs", "wants"].includes(v.bucket)).map(([k]) => k);
  const examples = merchants.map((m) => ({ merchant: m, amounts: bank.transactions.filter((t) => t.merchant === m).map((t) => t.amount) }));
  btn.disabled = true; btn.textContent = "Categorizing…";
  try {
    const text = await aiComplete(
      "You categorize bank transactions. Reply with only a JSON object, no prose and no code fences.",
      [{ role: "user", content: `Assign each merchant one category from: ${allowed.join(", ")}.\nMerchants with their transaction amounts (negative = spending):\n${JSON.stringify(examples)}\nReturn {"<merchant>": "<category>"} for every merchant.` }],
    );
    const map = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    let n = 0;
    for (const [m, c] of Object.entries(map)) if (merchants.includes(m) && allowed.includes(c)) { state.merchantCat[m] = c; n++; }
    renderActivity(); renderBudget(); refresh();
    $("#uncatBanner").innerHTML = `<div class="banner ok">AI categorized ${n} merchant${n === 1 ? "" : "s"}. Rows marked "edited" can be changed anytime.</div>`;
  } catch (err) {
    btn.disabled = false; btn.textContent = "Categorize with AI";
    $("#uncatBanner").insertAdjacentHTML("beforeend", `<p class="error small">${esc(err instanceof AIError ? err.message : "Couldn't read the AI's answer. Try again.")}</p>`);
  }
}

// Minimal, escape-first markdown: headings, bullets, bold, paragraphs.
function renderMarkdown(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  let html = "", inList = false;
  for (const raw of md.split("\n")) {
    const l = raw.trimEnd();
    const bullet = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
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
  monthOptions($("#txMonth"), LAST_FULL, true);
  renderActivity();
  renderBudget();
  renderBalance();
  renderHome();
  renderGoalForm();
  renderQuiz();
  renderCompoundChart();
  renderChips();
  renderChat();
  refresh();
}
renderAll();
try { const t = localStorage.getItem("learnfi.tab"); if (t && $(`#tab-${t}`)) selectTab(t); } catch { /* ignore */ }
