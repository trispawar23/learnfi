// LearnFi Wealth: money-management features for a consumer banking app.
// Balances and transactions come from the bank feed (data.js in this prototype); everything else
// (budget, net worth, goals, advice) is derived from them. User edits (category overrides, manual
// lines, goals) persist in this browser. The advisor is a deterministic rules engine; the Assistant
// tab and AI categorization call Claude.

const STORE_KEY = "learnfi.v2";
const SAVINGS_GROWTH = { short: 0.0, medium: 0.04, long: 0.07 }; // cash, HYSA/CD, diversified index
const INFLATION = 0.03;

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
    limits: {},
    cardControls: {},
    selectedCard: null,
    bcMonth: null,
    invest: { age: bank.profile.age, retireAge: 65, ret: 6, profile: null },
    feeCalc: { amount: null, monthly: null, years: null },
    booking: null,
    bookTopic: null,
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
    add({ priority: "high", tag: "Budget", title: "No income detected yet", body: "Once a paycheck lands in a linked account, your budget fills in automatically. You can also add cash income on the Budget tab.", why: "A budget is the foundation." });
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
      : "Your current payments don't cover the interest. Raise the monthly amount on the Net Worth tab.", action: { label: "See payoff plan", tab: "networth" }, why: "Paying off a 25% APR card is a guaranteed 25% return, which no investment matches." });
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

  // Category limits
  const overNow = budgetStatus(currentYM).filter((x) => x.status !== "ok"), overLast = budgetStatus(LAST_FULL).filter((x) => x.status === "over");
  if (overNow.length) add({ priority: overNow.some((x) => x.status === "over") ? "high" : "med", tag: "Budget", horizons: ["short"], title: `${overNow.length} categor${overNow.length > 1 ? "ies are" : "y is"} over or on pace to go over this month`, body: overNow.map((x) => `${x.label}: ${money(x.spent)} of ${money(x.limit)}`).join("; ") + ".", action: { label: "See budget check", tab: "overview" }, why: "Catching it early in the month leaves time to adjust." });
  if (overLast.length) add({ priority: "med", tag: "Budget", horizons: ["short"], title: `You went over budget in ${overLast.length} categor${overLast.length > 1 ? "ies" : "y"} in ${monthLabel}`, body: overLast.map((x) => `${x.label} by ${money(x.over)}`).join(", ") + ". Raise the limit if it was unrealistic, or plan a cut this month.", action: { label: "Edit limits", tab: "budget" }, why: "A budget only works if the limits match real life." });

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

  // Investments
  const mt = match401k(), pf = portfolio();
  if (mt && mt.missed > 0) {
    add({ priority: "high", tag: "Investing", horizons: ["long"], title: `You're leaving ${money(mt.missed)}/yr of 401(k) match on the table`, body: `You contribute ${mt.employeePct}% and your employer matches ${mt.matchRate * 100}% up to ${mt.matchUpToPct}%. Raising to ${mt.matchUpToPct}% costs about ${money((mt.employeeExtra / 24) * 0.78)} per paycheck after tax and adds ${money(mt.employeeExtra + mt.missed)}/yr to your retirement. It's an instant ${mt.matchRate * 100}% return.`, action: { label: "See the projection", tab: "invest" }, why: "An employer match is free money; take it even while paying down debt." });
  }
  pf.highFee.forEach((h) => add({ priority: "med", tag: "Fees", horizons: ["long"], title: `${h.name} charges ${h.er.toFixed(2)}% a year`, body: `That's ${money((h.value * h.er) / 100)}/yr on ${money(h.value)}. A broad index fund costs about ${INDEX_ER}%. Over decades, fee differences compound into thousands of dollars.`, action: { label: "Review holdings", tab: "invest" }, why: "Fees are one of the few investment returns you control." }));
  pf.single.filter((h) => h.value / pf.total > 0.1).forEach((h) => add({ priority: "med", tag: "Investing", horizons: ["long"], title: `${pct(h.value / pf.total)} of your investments is one stock (${h.name})`, body: "Your job already depends on this company. Diversifying keeps one bad year from hitting both your paycheck and your savings. Selling inside the 401(k) isn't taxed.", action: { label: "See allocation", tab: "invest" }, why: "Don't keep all your eggs in one basket." }));
  const prof = PROFILES[riskProfile()];
  const drift = Object.keys(CLASSES).reduce((mx, k) => Math.max(mx, Math.abs(pf.byClass[k] / pf.total - prof.target[k])), 0);
  if (drift > 0.1) add({ priority: "low", tag: "Investing", horizons: ["long"], title: `Your mix is ${pct(drift)} off your ${prof.label.toLowerCase()} target`, body: "Rebalance inside your retirement accounts, or send new contributions to the underweight assets.", action: { label: "See rebalancing", tab: "invest" }, why: "Rebalancing keeps your risk where you chose it." });
  const fit = advisorFit();
  if (fit.complex) add({ priority: "low", tag: "Advice", horizons: ["medium", "long"], title: `Consider ${fit.rec[0].toLowerCase()}`, body: fit.rec[1] + ".", action: { label: "Compare advisor options", tab: "advisors" }, why: "Some decisions are worth a second set of eyes, but ongoing fees add up." });

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
    debt: " Use the avalanche method on the Net Worth tab and pay cards in full afterward.",
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

// ---------------------------------------------------------------- overview (all visual)
// Small SVG building blocks. Every mark carries a data-tip for the shared hover tooltip.
const tipAttr = (html) => `data-tip="${esc(html)}"`;

function donut(segs, { size = 150, thick = 20, center = "", label = "" } = {}) {
  const total = segs.reduce((s, x) => s + x.value, 0) || 1, r = (size - thick) / 2, C = 2 * Math.PI * r, gap = segs.length > 1 ? 2 : 0;
  let at = 0;
  const arcs = segs.map((x) => {
    const len = Math.max(0, (x.value / total) * C - gap);
    const out = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${x.color}" stroke-width="${thick}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-at}" transform="rotate(-90 ${size / 2} ${size / 2})" ${tipAttr(x.tip)}/>`;
    at += (x.value / total) * C;
    return out;
  }).join("");
  return `<div class="donut" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label)}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--grid)" stroke-width="${thick}"/>${arcs}</svg><div class="donut-center">${center}</div></div>`;
}

function ring(frac, { size = 96, thick = 10, color = "var(--blue)", center = "", tip = "", marks = [] } = {}) {
  const r = (size - thick) / 2, C = 2 * Math.PI * r, f = Math.max(0, Math.min(1, frac));
  const ticks = marks.map((m) => {
    const a = m * 2 * Math.PI - Math.PI / 2, x1 = size / 2 + (r - thick / 2 - 2) * Math.cos(a), y1 = size / 2 + (r - thick / 2 - 2) * Math.sin(a), x2 = size / 2 + (r + thick / 2 + 2) * Math.cos(a), y2 = size / 2 + (r + thick / 2 + 2) * Math.sin(a);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--ink)" stroke-width="2"/>`;
  }).join("");
  return `<div class="donut" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}" role="img"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--grid)" stroke-width="${thick}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${thick}" stroke-linecap="round" stroke-dasharray="${f * C} ${C}" transform="rotate(-90 ${size / 2} ${size / 2})" ${tipAttr(tip)}/>${ticks}</svg><div class="donut-center">${center}</div></div>`;
}

const legend = (items) => `<div class="legend">${items.map((i) => `<span><i class="${i.cls || ""}" style="background:${i.color}"></i>${esc(i.label)}</span>`).join("")}</div>`;

function ovNetWorth() {
  const bs = balanceSheet();
  $("#ovNetWorth").textContent = money(bs.net);
  $("#syncLine").textContent = `${bank.accounts.length} linked accounts · updated ${shortDate(today)} · demo data`;
  const sumKinds = (kinds) => bank.accounts.filter((a) => kinds.includes(a.kind)).reduce((s, a) => s + a.balance, 0);
  const assets = [
    { label: "Cash & savings", value: sumKinds(["checking", "savings"]), color: "var(--s-needs)" },
    { label: "Investments & retirement", value: sumKinds(["investment", "retirement"]), color: "var(--s-savings)" },
    { label: "Other (car, home)", value: sum(state.manualAssets, "value"), color: "var(--s-cash)" },
  ].filter((x) => x.value > 0);
  const debts = allDebts().filter((d) => num(d.balance) > 0).sort((a, b) => b.balance - a.balance)
    .map((d, i) => ({ label: d.name.replace(/ ••\d+$/, ""), value: num(d.balance), color: `var(--debt-${Math.min(i, 3) + 1})`, apr: d.apr }));
  const max = Math.max(bs.assets, bs.debts);
  const bar = (title, total, segs) => `<div class="hbar-row"><span class="hbar-label">${title}<b>${money(total)}</b></span><div class="hbar" style="width:${(total / max) * 100}%">${segs.map((x) =>
    `<span style="flex:${x.value};background:${x.color}" ${tipAttr(`<strong>${esc(x.label)}</strong><br><b>${money(x.value)}</b>${x.apr ? ` · ${x.apr}% APR` : ""}`)}></span>`).join("")}</div></div>`;
  $("#ovBalance").innerHTML = bar("Own", bs.assets, assets) + bar("Owe", bs.debts, debts) +
    legend([...assets.map((a) => ({ label: a.label, color: a.color })), { label: "Debts (darker = larger)", color: "var(--debt-1)" }]);
}

function ovCashflow() {
  const months = [...MONTHS].reverse(), data = months.map((ym) => ({ ym, ...totals(ym) }));
  const W = 560, H = 230, padL = 52, padB = 30, padT = 10, colW = (W - padL) / months.length, bw = Math.min(56, colW * 0.5);
  const maxV = Math.max(...data.map((d) => Math.max(d.income, d.needs + d.wants + d.savings + d.unassigned))) * 1.08;
  const step = Math.ceil(maxV / 4 / 500) * 500, maxY = step * 4;
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly income versus spending and saving">`;
  for (let v = 0; v <= maxY; v += step) svg += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${compactUsd.format(v)}</text>`;
  data.forEach((d, i) => {
    const cx = padL + colW * i + colW / 2, x0 = cx - bw / 2;
    let base = 0;
    [["needs", "var(--s-needs)", "Needs"], ["wants", "var(--s-wants)", "Wants"], ["savings", "var(--s-savings)", "Savings"], ["unassigned", "var(--muted)", "Uncategorized"]].forEach(([k, c, lbl], j, arr) => {
      if (d[k] <= 0) return;
      const top = y(base + d[k]), h = y(base) - top;
      const isTop = !arr.slice(j + 1).some(([kk]) => d[kk] > 0);
      svg += `<path d="${isTop ? barPathV(x0, top, bw, h - 2, 4) : `M${x0},${top} h${bw} v${Math.max(0, h - 2)} h${-bw} Z`}" fill="${c}" ${tipAttr(`<strong>${monthName(d.ym, "short")} · ${lbl}</strong><br><b>${money(d[k])}</b> (${d.income ? pct(d[k] / d.income) : "–"} of income)`)}/>`;
      base += d[k];
    });
    svg += `<line x1="${x0 - 8}" x2="${x0 + bw + 8}" y1="${y(d.income)}" y2="${y(d.income)}" stroke="var(--ink)" stroke-width="2.5" ${tipAttr(`<strong>${monthName(d.ym, "short")} income</strong><br><b>${money(d.income)}</b><br>Left over <b>${money(d.left)}</b>`)}/>`;
    svg += `<text class="axis-label" x="${cx}" y="${H - 10}" text-anchor="middle">${new Date(`${d.ym}-15T12:00:00`).toLocaleDateString("en-US", { month: "short" })}${d.ym === currentYM ? " (so far)" : ""}</text>`;
  });
  svg += `</svg>`;
  $("#ovCashflow").className = "chart";
  $("#ovCashflow").innerHTML = legend([{ label: "Needs", color: "var(--s-needs)" }, { label: "Wants", color: "var(--s-wants)" }, { label: "Savings", color: "var(--s-savings)" }, { label: "Income", color: "var(--ink)", cls: "line" }]) + svg;
}
function barPathV(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function ovSplit() {
  const t = totals(LAST_FULL);
  $("#ovSplitLabel").textContent = monthName(LAST_FULL, "short");
  const segs = [
    { k: "Needs", v: t.needs, target: 0.5, color: "var(--s-needs)" },
    { k: "Wants", v: t.wants, target: 0.3, color: "var(--s-wants)" },
    { k: "Savings", v: t.savings, target: 0.2, color: "var(--s-savings)" },
  ];
  const d = donut(segs.map((s) => ({ value: s.v, color: s.color, tip: `<strong>${s.k}</strong><br><b>${money(s.v)}</b> · ${pct(s.v / t.income)} (target ${pct(s.target)})` })),
    { size: 150, thick: 22, label: "Needs, wants and savings share of income", center: `<b>${pct(t.savings / t.income)}</b><span>saved</span>` });
  $("#ovSplit").innerHTML = `<div class="donut-wrap">${d}<ul class="split-list">${segs.map((s) => {
    const share = s.v / t.income, off = s.k === "Savings" ? share < s.target - 0.01 : share > s.target + 0.01;
    return `<li><i style="background:${s.color}"></i><span>${s.k}</span><b>${pct(share)}</b><small class="${off ? "status warn" : "status good"}">${off ? (s.k === "Savings" ? "below" : "above") : (s.k === "Savings" ? "meets" : "within")} ${pct(s.target)}</small></li>`;
  }).join("")}</ul></div>`;
}

function ovSpend() {
  $("#ovSpendLabel").textContent = monthName(LAST_FULL, "short");
  const cats = monthCategories(LAST_FULL).filter((c) => ["needs", "wants"].includes(c.bucket)).slice(0, 7);
  const max = Math.max(1, ...cats.map((c) => c.amount));
  $("#ovSpend").innerHTML = `<ul class="spark-bars">${cats.map((c) => `<li ${tipAttr(`<strong>${CATS[c.cat].label}</strong><br><b>${money(c.amount)}</b> · ${c.count} transaction${c.count > 1 ? "s" : ""}`)}>
    <span class="lbl">${CATS[c.cat].label}</span><span class="track"><span style="width:${(c.amount / max) * 100}%;background:${c.bucket === "needs" ? "var(--s-needs)" : "var(--s-wants)"}"></span></span><span class="amt">${money(c.amount)}</span></li>`).join("")}</ul>` +
    legend([{ label: "Need", color: "var(--s-needs)" }, { label: "Want", color: "var(--s-wants)" }]);
}

function ovEmergency() {
  const t = totals(LAST_FULL), bs = balanceSheet(), months = t.needs ? bs.emergency / t.needs : 0;
  const color = months >= 3 ? "var(--green)" : months >= 1 ? "var(--amber)" : "var(--red)";
  $("#ovEmergency").innerHTML = `<div class="ring-wrap">${ring(months / 6, { size: 140, thick: 14, color, marks: [0.5], center: `<b>${months.toFixed(1)}</b><span>of 6 months</span>`, tip: `<strong>Emergency fund</strong><br><b>${money(bs.emergency)}</b> covers ${months.toFixed(1)} months of needs (${money(t.needs)}/mo)` })}
    <p class="small center">${money(bs.emergency)} saved · <b>${money(Math.max(0, t.needs * 3 - bs.emergency))}</b> to 3 months</p></div>`;
}

function ovCredit() {
  const score = bank.creditScore, bs = balanceSheet(), util = bs.cardLimit ? bs.cardDebt / bs.cardLimit : 0;
  const W = 200, H = 120, cx = 100, cy = 105, r = 80, th = 16;
  const ang = (s) => Math.PI * (1 - (s - 300) / 550);
  const arc = (s0, s1, color) => {
    const a0 = ang(s0), a1 = ang(s1);
    return `<path d="M${cx + r * Math.cos(a0)},${cy - r * Math.sin(a0)} A${r},${r} 0 0 1 ${cx + r * Math.cos(a1)},${cy - r * Math.sin(a1)}" fill="none" stroke="${color}" stroke-width="${th}" ${tipAttr(`${s0}–${s1}`)}/>`;
  };
  const a = ang(score), nx = cx + (r - 22) * Math.cos(a), ny = cy - (r - 22) * Math.sin(a);
  const band = score >= 740 ? "Very good" : score >= 700 ? "Good" : score >= 600 ? "Decent" : "Poor";
  $("#ovCredit").innerHTML = `<div class="gauge"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Credit score ${score}">
      ${arc(300, 598, "var(--gauge-bad)")}${arc(602, 698, "var(--gauge-mid)")}${arc(702, 850, "var(--gauge-good)")}
      <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="5" fill="var(--ink)"/>
    </svg><div class="gauge-num"><b>${score}</b><span>${band}</span></div></div>
    <div class="meter" ${tipAttr(`<strong>Card utilization</strong><br><b>${pct(util)}</b> of ${money(bs.cardLimit)} limit · aim under 30%`)}>
      <span class="meter-lbl">Card utilization <b>${pct(util)}</b></span>
      <span class="meter-track"><span style="width:${Math.min(100, util * 100)}%;background:${util > 0.3 ? "var(--red)" : util > 0.1 ? "var(--amber)" : "var(--green)"}"></span><i style="left:30%"></i></span>
    </div>`;
}

function ovRunway() {
  const payday = nextPayday(), bs = balanceSheet();
  const end = new Date(payday); end.setDate(end.getDate() + 2);
  const days = Math.round((end - today) / 86400000);
  const bills = recurring().filter((r) => r.account === "chk" && r.nextDate <= end);
  const payAmt = bank.transactions.find((t) => catOf(t) === "paycheck")?.amount || 0;
  const events = [...bills.map((b) => ({ d: Math.round((b.nextDate - today) / 86400000), amt: -b.amount, label: titleCase(b.merchant) })), { d: Math.round((payday - today) / 86400000), amt: payAmt, label: "Paycheck" }].sort((a, b) => a.d - b.d);
  let bal = bs.checking;
  const pts = [[0, bal]];
  events.forEach((e) => { pts.push([e.d, bal]); bal += e.amt; pts.push([e.d, bal]); e.after = bal; });
  pts.push([days, bal]);
  const W = 760, H = 200, padL = 52, padR = 16, padT = 26, padB = 26;
  const maxV = Math.max(...pts.map((p) => p[1])) * 1.15, step = Math.ceil(maxV / 3 / 250) * 250, maxY = step * 3;
  const x = (d) => padL + (d / days) * (W - padL - padR), y = (v) => padT + (1 - Math.max(0, v) / maxY) * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected checking balance until payday">`;
  for (let v = 0; v <= maxY; v += step) svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${compactUsd.format(v)}</text>`;
  svg += `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("")} L${x(days)},${y(0)} L${x(0)},${y(0)} Z" fill="var(--s-needs)" opacity=".12"/>`;
  svg += `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("")}" fill="none" stroke="var(--s-needs)" stroke-width="2"/>`;
  events.forEach((e, i) => {
    const income = e.amt > 0;
    svg += `<line x1="${x(e.d)}" x2="${x(e.d)}" y1="${padT - 6}" y2="${H - padB}" stroke="${income ? "var(--green)" : "var(--line)"}" stroke-dasharray="${income ? "0" : "3 3"}"/>`;
    svg += `<circle cx="${x(e.d)}" cy="${y(e.after)}" r="5" fill="${income ? "var(--green)" : "var(--s-needs)"}" stroke="var(--surface)" stroke-width="2" ${tipAttr(`<strong>${esc(e.label)}</strong> · ${shortDate(new Date(today.getTime() + e.d * 86400000))}<br>${income ? "+" : "−"}${cents(Math.abs(e.amt))} · balance after <b>${cents(e.after)}</b>`)}/>`;
    svg += `<text x="${x(e.d)}" y="${padT - 10 - (i % 2) * 0}" text-anchor="middle" class="ev-label" style="fill:${income ? "var(--green)" : "var(--ink-2)"}">${income ? "Payday" : `−${money(Math.abs(e.amt))}`}</text>`;
  });
  for (let d = 0; d <= days; d += Math.max(1, Math.round(days / 6))) svg += `<text class="axis-label" x="${x(d)}" y="${H - 6}" text-anchor="middle">${d === 0 ? "Today" : shortDate(new Date(today.getTime() + d * 86400000))}</text>`;
  svg += `</svg>`;
  const low = Math.min(...pts.map((p) => p[1]));
  $("#ovRunwayLabel").innerHTML = `Lowest point <b class="status ${low < 100 ? "bad" : "good"}">${money(low)}</b> · payday ${shortDate(payday)}`;
  $("#ovRunway").className = "chart";
  $("#ovRunway").innerHTML = svg;
}

function ovInvest() {
  const p = portfolio(), m = match401k();
  const segs = Object.keys(CLASSES).filter((k) => p.byClass[k] > 0).map((k) => ({ value: p.byClass[k], color: CLASSES[k].color, tip: `<strong>${CLASSES[k].label}</strong><br><b>${money(p.byClass[k])}</b> · ${pct(p.byClass[k] / p.total)}` }));
  const d = donut(segs, { size: 150, thick: 16, label: "Investment allocation", center: `<b>${compactUsd.format(p.total)}</b><span>invested</span>` });
  const meter = m ? `<div class="meter" ${tipAttr(`<strong>401(k) contribution</strong><br>You put in <b>${m.employeePct}%</b>; employer matches up to <b>${m.matchUpToPct}%</b>${m.missed > 0 ? `<br>Missing <b>${money(m.missed)}/yr</b>` : ""}`)}>
      <span class="meter-lbl">401(k) match <b>${m.employeePct}% of ${m.matchUpToPct}%</b></span>
      <span class="meter-track"><span style="width:${(m.employeePct / (m.matchUpToPct + 1)) * 100}%;background:${m.employeePct >= m.matchUpToPct ? "var(--green)" : "var(--amber)"}"></span><i style="left:${(m.matchUpToPct / (m.matchUpToPct + 1)) * 100}%"></i></span>
    </div>` : "";
  $("#ovInvest").innerHTML = `<div class="ring-wrap">${d}</div>${legend(Object.keys(CLASSES).filter((k) => p.byClass[k] > 0).map((k) => ({ label: CLASSES[k].label, color: CLASSES[k].color })))}${meter}`;
}

function ovGoals() {
  const t = totals(LAST_FULL);
  $("#ovGoals").innerHTML = state.goals.map((g) => {
    const target = goalTarget(g), saved = goalSaved(g), f = saved / Math.max(1, target);
    const h = horizonOf(num(g.years)), need = requiredMonthly(target, saved, num(g.years), g.kind === "emergency" ? 0 : SAVINGS_GROWTH[h]);
    const tight = t.savings && need / t.savings > 0.6;
    return `<div class="goal-ring">${ring(f, { size: 92, thick: 9, color: f >= 1 ? "var(--green)" : "var(--blue)", center: `<b>${pct(Math.min(1, f))}</b>`, tip: `<strong>${esc(g.name)}</strong><br>${money(saved)} of ${money(target)}<br>Needs <b>${money(need)}/mo</b> for ${fmtYears(num(g.years))}` })}
      <span class="goal-name">${esc(g.name)}</span><span class="goal-sub">${money(target)} · ${fmtYears(num(g.years))}</span><span class="goal-sub ${tight ? "status warn" : ""}">${money(need)}/mo</span></div>`;
  }).join("") || `<p class="muted">No goals yet. Add one on the Goals tab.</p>`;
}

function ovDebt() {
  const plan = payoffPlan(), debts = allDebts().filter((d) => d.type !== "mortgage" && num(d.balance) > 0).sort((a, b) => b.apr - a.apr);
  $("#ovDebtLabel").textContent = plan && !plan.stuck ? `Debt-free in ${fmtMonths(plan.months)} (${state.payoffMethod})` : "";
  const max = Math.max(1, ...debts.map((d) => num(d.balance)));
  const months = plan ? Math.max(...plan.paidOff.map((p) => p.month), 1) : 1;
  $("#ovDebt").innerHTML = `<ul class="debt-bars">${debts.map((d) => {
    const off = plan?.paidOff.find((p) => p.id === d.id)?.month;
    return `<li ${tipAttr(`<strong>${esc(d.name)}</strong><br><b>${money(d.balance)}</b> at ${d.apr}% APR${off ? `<br>Paid off in month ${off}` : ""}`)}>
      <span class="lbl">${esc(d.name.replace(/ ••\d+$/, ""))}<small>${d.apr}% APR</small></span>
      <span class="track"><span style="width:${(num(d.balance) / max) * 100}%;background:${d.apr >= 10 ? "var(--red)" : "var(--debt-2)"}"></span></span>
      <span class="amt">${money(d.balance)}</span>
      <span class="timeline"><span style="width:${off ? (off / months) * 100 : 100}%"></span><em>${off ? fmtMonths(off) : "–"}</em></span>
    </li>`;
  }).join("")}</ul><p class="muted small">Top bar: balance (red = 10%+ APR). Thin bar: when it's paid off on your current plan.</p>`;
}

function ovActions() {
  const t = totals(LAST_FULL), bs = balanceSheet(), m = match401k(), list = [];
  if (m && m.missed > 0) list.push({ big: `${money(m.missed)}`, unit: "/yr", label: "401(k) match you're not collecting", tab: "invest", tone: "bad" });
  const int = interestPaid(3);
  if (int > 0) list.push({ big: money(int * 4), unit: "/yr", label: "card interest at your current pace", tab: "networth", tone: "bad" });
  if (t.needs * 3 > bs.emergency) list.push({ big: money(t.needs * 3 - bs.emergency), unit: "", label: "to reach a 3-month emergency fund", tab: "goals", tone: "warn" });
  if (t.income && t.needs > t.income * 0.5) list.push({ big: money(t.needs - t.income * 0.5), unit: "/mo", label: "needs above the 50% guideline", tab: "budget", tone: "warn" });
  const subs = recurring().filter((r) => r.isSub);
  if (subs.length) list.push({ big: money(subs.reduce((s, r) => s + r.amount, 0) * 12), unit: "/yr", label: `on ${subs.length} subscriptions${subs.some((r) => r.priceUp) ? " (one went up)" : ""}`, tab: "activity", tone: "" });
  $("#ovActions").innerHTML = list.slice(0, 4).map((a) => `<button class="action-tile ${a.tone}" data-goto-tab="${a.tab}"><span class="action-big">${a.big}<small>${a.unit}</small></span><span class="action-lbl">${esc(a.label)}</span></button>`).join("");
}

function renderOverview() {
  renderBudgetCheck(); renderOvAccounts(); ovNetWorth(); ovCashflow(); ovSplit(); ovSpend(); ovEmergency(); ovCredit(); ovRunway(); ovInvest(); ovGoals(); ovDebt(); ovActions();
}

// Shared hover tooltip for any element with data-tip.
document.addEventListener("mousemove", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (el) showTip(el.dataset.tip, e.clientX, e.clientY);
  else if (!e.target.closest?.(".chart svg rect, [data-row], [data-alloc]")) hideTip();
});
document.addEventListener("click", (e) => { const b = e.target.closest("[data-goto-tab]"); if (b) selectTab(b.dataset.gotoTab); });

// ---------------------------------------------------------------- budget limits & flags
const DEFAULT_LIMITS = {
  housing: 1100, utilities: 140, phone_internet: 120, transport: 180, loan_payment: 450, groceries: 250, health: 50, fees_interest: 0,
  dining: 150, entertainment: 60, subscriptions: 40, shopping: 120, fitness: 60,
};
// Bills that land once a month in one lump: judge them on the full amount, not on daily pace.
const LUMPY = ["housing", "loan_payment", "phone_internet", "utilities", "fitness", "subscriptions", "fees_interest"];
const limitOf = (cat) => (state.limits?.[cat] ?? DEFAULT_LIMITS[cat]);

function budgetStatus(ym) {
  const days = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
  const frac = ym === currentYM ? today.getDate() / days : 1;
  const spent = Object.fromEntries(monthCategories(ym).map((c) => [c.cat, c.amount]));
  return Object.keys(CATS).filter((k) => ["needs", "wants"].includes(CATS[k].bucket) && limitOf(k) != null && (limitOf(k) > 0 || (spent[k] || 0) > 0))
    .map((k) => {
      const s = spent[k] || 0, lim = limitOf(k), expected = LUMPY.includes(k) ? lim : lim * frac;
      let status = "ok";
      if (s > lim + 0.5) status = "over";
      else if (frac < 1 && !LUMPY.includes(k) && s >= 20 && s > expected * 1.2) status = "pace";
      const projected = frac < 1 && !LUMPY.includes(k) ? s / frac : s;
      return { cat: k, label: CATS[k].label, bucket: CATS[k].bucket, spent: s, limit: lim, expected, frac, status, over: s - lim, projected };
    })
    .sort((a, b) => ({ over: 0, pace: 1, ok: 2 }[a.status] - { over: 0, pace: 1, ok: 2 }[b.status]) || (b.over - a.over));
}
function budgetFlags(ym) {
  const st = budgetStatus(ym), t = totals(ym), frac = st[0]?.frac ?? 1, flags = [];
  st.filter((x) => x.status === "over").forEach((x) => flags.push({ level: "over", cat: x.cat, text: x.limit === 0 ? `${x.label}: you paid ${money(x.spent)} and the goal is $0.` : `You're ${money(x.over)} over on ${x.label.toLowerCase()} (${money(x.spent)} of ${money(x.limit)}).` }));
  st.filter((x) => x.status === "pace").forEach((x) => flags.push({ level: "pace", cat: x.cat, text: `${x.label} is on pace for about ${money(x.projected)}, over your ${money(x.limit)} limit.` }));
  if (frac === 1 && t.income) {
    if (t.wants > t.income * 0.3) flags.push({ level: "over", text: `Wants were ${pct(t.wants / t.income)} of income, above 30%.` });
    if (t.needs > t.income * 0.5) flags.push({ level: "pace", text: `Needs were ${pct(t.needs / t.income)} of income, above the 50% guideline.` });
  }
  return { st, flags, mood: flags.some((f) => f.level === "over") ? "alert" : flags.length ? "worried" : "happy" };
}

// Mascot: Penny, a flat piggy bank drawn in the app's blue palette. Mood sets the face, badge and motion.
let mascotSeq = 0;
function mascotSVG(mood, size = 120) {
  const id = `pg${++mascotSeq}`;
  const eyes = mood === "happy"
    ? `<path d="M41 55 q5 -5 10 0" class="m-line"/><path d="M69 55 q5 -5 10 0" class="m-line"/>`
    : `<g class="m-eyes"><ellipse cx="46" cy="54" rx="${mood === "alert" ? 4.6 : 4}" ry="${mood === "alert" ? 5.6 : 4.6}" class="m-face"/><ellipse cx="74" cy="54" rx="${mood === "alert" ? 4.6 : 4}" ry="${mood === "alert" ? 5.6 : 4.6}" class="m-face"/><circle cx="47.6" cy="52" r="1.4" fill="#fff"/><circle cx="75.6" cy="52" r="1.4" fill="#fff"/></g>`;
  const brows = mood === "worried" ? `<path d="M39 45 l12 -4" class="m-line thin"/><path d="M81 45 l-12 -4" class="m-line thin"/>` : mood === "alert" ? `<path d="M40 43 q6 -5 11 -1" class="m-line thin"/><path d="M80 43 q-6 -5 -11 -1" class="m-line thin"/>` : "";
  const mouth = mood === "happy" ? `<path d="M54 84 q6 6 12 0" class="m-line"/>` : mood === "worried" ? `<path d="M54 87 q6 -4 12 0" class="m-line"/>` : `<ellipse cx="60" cy="86" rx="3.6" ry="4.4" class="m-face"/>`;
  const badge = mood === "worried" ? `<g class="m-badge"><circle cx="98" cy="22" r="11" fill="var(--amber)"/><path d="M98 16 v7" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="98" cy="28" r="1.8" fill="#fff"/></g>`
    : mood === "alert" ? `<g class="m-badge"><circle cx="98" cy="22" r="12" fill="var(--red)"/><path d="M98 15 v8" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><circle cx="98" cy="29" r="2" fill="#fff"/></g>`
    : `<g class="m-coin"><circle cx="60" cy="14" r="9" fill="url(#${id}c)"/><path d="M60 9.5 v9" stroke="#b07a10" stroke-width="2" stroke-linecap="round"/></g>`;
  return `<svg class="mascot ${mood}" viewBox="0 0 120 120" width="${size}" height="${size}" role="img" aria-label="Penny the piggy bank looks ${mood === "happy" ? "happy" : mood === "worried" ? "worried" : "alarmed"}">
    <defs>
      <linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--mascot-1)"/><stop offset="1" stop-color="var(--mascot-2)"/></linearGradient>
      <linearGradient id="${id}c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#f2b632"/></linearGradient>
    </defs>
    <ellipse cx="60" cy="112" rx="30" ry="4" class="m-shadow"/>
    <g class="m-body">
      <path d="M32 40 q-2 -18 12 -16 q4 6 2 14z" fill="url(#${id}b)"/><path d="M88 40 q2 -18 -12 -16 q-4 6 -2 14z" fill="url(#${id}b)"/>
      <rect x="38" y="92" width="13" height="16" rx="6.5" fill="var(--mascot-2)"/><rect x="69" y="92" width="13" height="16" rx="6.5" fill="var(--mascot-2)"/>
      <circle cx="60" cy="64" r="40" fill="url(#${id}b)"/>
      <ellipse cx="46" cy="40" rx="14" ry="8" fill="#fff" opacity=".22" transform="rotate(-25 46 40)"/>
      <rect x="51" y="27" width="18" height="4" rx="2" fill="var(--mascot-face)" opacity=".35"/>
      ${eyes}${brows}
      <ellipse cx="60" cy="71" rx="12" ry="8.5" fill="var(--mascot-snout)"/><ellipse cx="55.5" cy="71" rx="2" ry="2.6" class="m-face" opacity=".7"/><ellipse cx="64.5" cy="71" rx="2" ry="2.6" class="m-face" opacity=".7"/>
      <circle cx="34" cy="70" r="5" fill="#ff9fb8" opacity=".55"/><circle cx="86" cy="70" r="5" fill="#ff9fb8" opacity=".55"/>
      ${mouth}
    </g>${badge}</svg>`;
}

let bcIndex = 0;
function renderBudgetCheck() {
  const which = state.bcMonth || "current", ym = which === "current" ? currentYM : LAST_FULL;
  $("#bcLastBtn").textContent = monthName(LAST_FULL, "long").split(" ")[0];
  $$("[data-bc]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.bc === which)));
  const { st, flags, mood } = budgetFlags(ym);
  bcIndex = flags.length ? bcIndex % flags.length : 0;
  $("#bcMascot").innerHTML = mascotSVG(mood, 132);
  $("#budgetCheck").dataset.mood = mood;
  const f = flags[bcIndex];
  $("#bcBubble").innerHTML = f
    ? `<strong>${f.level === "over" ? "Over budget" : "Heads up"}</strong> ${esc(f.text)}${flags.length > 1 ? ` <span class="bubble-count">${bcIndex + 1} of ${flags.length} · tap Penny for the next</span>` : ""}`
    : `<strong>Nice!</strong> Every category is within its limit${which === "current" ? " so far this month" : ` in ${monthName(LAST_FULL, "long")}`}.`;
  $("#bcBars").innerHTML = st.filter((x) => x.spent > 0 || x.status !== "ok").map((x) => {
    const scale = Math.max(x.limit, x.spent, 1) * 1.05;
    const color = x.status === "over" ? "var(--red)" : x.status === "pace" ? "var(--amber)" : x.bucket === "needs" ? "var(--s-needs)" : "var(--s-wants)";
    return `<li class="${x.status} ${f && f.cat === x.cat ? "focus" : ""}" ${tipAttr(`<strong>${esc(x.label)}</strong><br>Spent <b>${money(x.spent)}</b> of ${money(x.limit)}${x.frac < 1 && !LUMPY.includes(x.cat) ? `<br>Expected by today: ${money(x.expected)}` : ""}${x.status === "over" ? `<br>Over by <b>${money(x.over)}</b>` : x.status === "pace" ? `<br>On pace for ${money(x.projected)}` : ""}`)}>
      <span class="lbl">${esc(x.label)}</span>
      <span class="track"><span style="width:${(x.spent / scale) * 100}%;background:${color}"></span><i class="lim" style="left:${(x.limit / scale) * 100}%"></i>${x.frac < 1 && !LUMPY.includes(x.cat) ? `<i class="pace" style="left:${(x.expected / scale) * 100}%"></i>` : ""}</span>
      <span class="amt">${money(x.spent)} <small>/ ${money(x.limit)}</small></span>
      <span class="flag">${x.status === "over" ? "Over" : x.status === "pace" ? "On pace to go over" : ""}</span></li>`;
  }).join("");
}
$("#tab-overview").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bc]");
  if (b) { state.bcMonth = b.dataset.bc; bcIndex = 0; save(); renderBudgetCheck(); return; }
  if (e.target.closest("#bcMascot")) { bcIndex++; renderBudgetCheck(); const m = $("#bcMascot svg"); m?.classList.remove("poke"); void m?.getBoundingClientRect(); m?.classList.add("poke"); }
});

function renderLimits() {
  const cur = Object.fromEntries(budgetStatus(currentYM).map((x) => [x.cat, x]));
  const last = Object.fromEntries(budgetStatus(LAST_FULL).map((x) => [x.cat, x]));
  const cats = Object.keys(CATS).filter((k) => ["needs", "wants"].includes(CATS[k].bucket));
  const cell = (x) => !x ? `<span class="muted">–</span>` : `<span class="mini-track"><span style="width:${Math.min(100, (x.spent / Math.max(1, x.limit)) * 100)}%;background:${x.status === "over" ? "var(--red)" : x.status === "pace" ? "var(--amber)" : "var(--green)"}"></span></span> ${money(x.spent)}${x.status === "over" ? ` <span class="status bad">over ${money(x.over)}</span>` : x.status === "pace" ? ` <span class="status warn">on pace to go over</span>` : ""}`;
  $("#limitsTable").innerHTML = `<thead><tr><th>Category</th><th>Type</th><th class="num">Monthly limit</th><th>${monthName(currentYM, "short")} so far</th><th>${monthName(LAST_FULL, "short")}</th></tr></thead><tbody>` +
    cats.map((k) => `<tr><td>${CATS[k].label}</td><td><span class="bucket b-${CATS[k].bucket}">${CATS[k].bucket === "needs" ? "Need" : "Want"}</span></td>
      <td class="num"><input type="number" min="0" step="10" data-limit="${k}" value="${limitOf(k)}" aria-label="Monthly limit for ${CATS[k].label}" style="text-align:right;max-width:110px"/></td>
      <td>${cell(cur[k])}</td><td>${cell(last[k])}</td></tr>`).join("") + `</tbody>`;
}
$("#tab-budget").addEventListener("change", (e) => {
  const k = e.target.dataset.limit;
  if (!k) return;
  state.limits = { ...(state.limits || {}), [k]: num(e.target.value) };
  renderLimits(); refresh();
});

// Penny pops up once per visit when something is over budget.
function maybeShowMascotToast() {
  let shown = false;
  try { shown = sessionStorage.getItem("learnfi.toast") === "1"; } catch { /* ignore */ }
  if (shown) return;
  const cur = budgetFlags(currentYM), last = budgetFlags(LAST_FULL);
  const pick = cur.flags.find((f) => f.level === "over") || cur.flags[0] || last.flags.find((f) => f.level === "over");
  if (!pick) return;
  $("#toastMascot").innerHTML = mascotSVG(pick.level === "over" ? "alert" : "worried", 88);
  $("#toastText").textContent = (cur.flags.includes(pick) ? "" : `In ${monthName(LAST_FULL, "long")}: `) + pick.text;
  $("#mascotToast").hidden = false;
  try { sessionStorage.setItem("learnfi.toast", "1"); } catch { /* ignore */ }
  state.bcMonth = cur.flags.includes(pick) ? "current" : "last";
}
$("#toastClose").addEventListener("click", () => { $("#mascotToast").hidden = true; });
$("#toastGo").addEventListener("click", () => { $("#mascotToast").hidden = true; selectTab("overview"); renderBudgetCheck(); $("#budgetCheck").scrollIntoView({ behavior: "smooth", block: "center" }); });

const KIND_LABEL = { checking: "Checking", savings: "Savings", credit: "Credit card", loan: "Loan", investment: "Investment", retirement: "Retirement" };

// ---------------------------------------------------------------- accounts & cards
const cardAccounts = () => bank.accounts.filter((a) => a.card);
const cardSpend = (a, ym) => -bank.transactions.filter((t) => t.account === a.id && t.date.startsWith(ym) && t.amount < 0 && !t.transfer && catOf(t) !== "fees_interest").reduce((s, t) => s + t.amount, 0);
function nextDue(a) {
  const d = new Date(today.getFullYear(), today.getMonth(), a.dueDay);
  if (d < today) d.setMonth(d.getMonth() + 1);
  return d;
}
const ctrl = (id) => (state.cardControls[id] ||= { locked: false, online: true, intl: false, alerts: true, alertAmount: 100 });

function cardFace(a, size = "full") {
  const c = a.card, locked = ctrl(a.id).locked;
  return `<div class="pay-card ${c.type} ${size} ${locked ? "locked" : ""}" aria-label="${esc(a.name)} ending ${c.last4}${locked ? ", locked" : ""}">
    <div class="pc-top"><span class="pc-brand">LearnFi</span><span class="pc-type">${c.type === "credit" ? "Rewards Credit" : "Debit"}</span></div>
    <div class="pc-chip" aria-hidden="true"></div>
    <svg class="pc-contactless" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7a8 8 0 0 1 0 10M12 5a11 11 0 0 1 0 14M16 3a14 14 0 0 1 0 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    <div class="pc-number">•••• •••• •••• ${c.last4}</div>
    <div class="pc-bottom"><span><small>Cardholder</small>${esc(bank.profile.fullName.toUpperCase())}</span><span><small>Expires</small>${c.expiry}</span><span class="pc-network" aria-hidden="true"><i></i><i></i></span></div>
    ${locked ? `<div class="pc-lock">Locked</div>` : ""}
  </div>`;
}

function renderOvAccounts() {
  $("#ovAccounts").innerHTML = bank.accounts.map((a) => {
    const debt = a.kind === "credit" || a.kind === "loan";
    const sub = a.kind === "credit" ? `${money(a.limit - a.balance)} available` : a.kind === "loan" ? `${a.apr}% APR` : a.apy ? `${a.apy}% APY` : KIND_LABEL[a.kind];
    if (a.card) return `<button class="mini-card ${a.card.type}" data-open-card="${a.id}" ${tipAttr(`<strong>${esc(a.name)}</strong><br>Card ending ${a.card.last4} · ${ctrl(a.id).locked ? "locked" : "active"}`)}>
      <span class="mc-top">${a.card.type === "credit" ? "Credit" : "Debit"} ••${a.card.last4}${ctrl(a.id).locked ? " · locked" : ""}</span>
      <span class="mc-bal">${debt ? "−" : ""}${cents(a.balance)}</span><span class="mc-sub">${esc(a.name)} · ${sub}</span></button>`;
    return `<div class="mini-acct ${debt ? "debt" : ""}"><span class="mc-top">${KIND_LABEL[a.kind]} ••${a.mask}</span><span class="mc-bal">${debt ? "−" : ""}${cents(a.balance)}</span><span class="mc-sub">${esc(a.name)} · ${sub}</span></div>`;
  }).join("");
}

function renderAccounts() {
  const cards = cardAccounts();
  const sel = cards.find((a) => a.id === state.selectedCard) || cards.find((a) => a.card.type === "credit") || cards[0];
  state.selectedCard = sel.id;
  $("#cardPicker").innerHTML = cards.map((a) => `<button role="tab" aria-selected="${a.id === sel.id}" data-card="${a.id}">${cardFace(a, "thumb")}<span>${esc(a.name)} ••${a.card.last4}</span></button>`).join("");
  $("#cardVisual").innerHTML = cardFace(sel);
  const c = ctrl(sel.id);
  $("#cardActions").innerHTML = `<button class="btn ${c.locked ? "primary" : "secondary"}" data-ctrl="locked">${c.locked ? "Unlock card" : "Lock card"}</button>
    ${sel.card.type === "credit" ? `<button class="btn secondary" data-goto="networth">Payoff plan</button>` : ""}
    <button class="btn secondary" data-report>Report lost or stolen</button>`;
  $("#cardControls").innerHTML = [
    ["locked", "Lock card", "Blocks new purchases and withdrawals. Recurring bills keep working."],
    ["online", "Online purchases", "Allow purchases on websites and in apps."],
    ["intl", "International use", "Allow purchases outside the US. Turn on before you travel."],
    ["alerts", `Alert me for purchases over ${money(c.alertAmount)}`, "Get a notification right after a large purchase."],
  ].map(([k, label, help]) => `<li><span><strong>${label}</strong><small>${help}</small></span>
    <button class="switch" role="switch" aria-checked="${!!c[k]}" data-ctrl="${k}" aria-label="${label}"><i></i></button></li>`).join("");

  const ym = currentYM, rows = [];
  if (sel.card.type === "credit") {
    const due = nextDue(sel), lastPay = bank.transactions.find((t) => catOf(t) === "card_payment");
    const util = sel.balance / sel.limit, earnedNow = cardSpend(sel, ym) * sel.cashBackPct / 100, earnedLast = cardSpend(sel, LAST_FULL) * sel.cashBackPct / 100;
    $("#cardDetailsTitle").textContent = `${sel.name} ••${sel.card.last4}`;
    rows.push(
      ["Current balance", cents(sel.balance), ""],
      ["Statement balance", cents(sel.statementBalance), `Closed ${shortDate(new Date(today.getFullYear(), today.getMonth() - (today.getDate() < sel.statementDay ? 1 : 0), sel.statementDay))}`],
      ["Minimum payment due", cents(sel.minPayment), `<span class="status ${Math.round((due - today) / 86400000) <= 5 ? "warn" : "good"}">Due ${shortDate(due)} · ${Math.round((due - today) / 86400000)} days</span>`],
      ["Pay in full to avoid interest", cents(sel.statementBalance), "Paying only the minimum keeps the 24.99% APR running"],
      ["Available credit", cents(sel.limit - sel.balance), `of ${money(sel.limit)} limit`],
      ["Utilization", `<span class="mini-track"><span style="width:${Math.min(100, util * 100)}%;background:${util > 0.3 ? "var(--red)" : util > 0.1 ? "var(--amber)" : "var(--green)"}"></span></span> ${pct(util)}`, "Keep under 30% for your score"],
      ["Purchase APR", `${sel.apr}%`, `Cash advance ${sel.cashAdvanceApr}%`],
      ["Last payment", lastPay ? cents(-lastPay.amount) : "–", lastPay ? `${shortDate(new Date(`${lastPay.date}T12:00:00`))} from Checking ••4821` : ""],
      ["Cash back", `${cents(earnedNow)} this month`, `${sel.cashBackPct}% on purchases · ${cents(earnedLast)} in ${monthName(LAST_FULL, "short")}`],
      ["Card ending", sel.card.last4, `Expires ${sel.card.expiry} · opened ${shortDate(new Date(`${sel.opened}T12:00:00`))}, ${sel.opened.slice(0, 4)}`],
    );
  } else {
    const spent = cardSpend(sel, ym);
    $("#cardDetailsTitle").textContent = `Debit card ••${sel.card.last4}`;
    rows.push(
      ["Linked account", `${esc(sel.name)} ••${sel.mask}`, ""],
      ["Available balance", cents(sel.available ?? sel.balance), `Current ${cents(sel.balance)}`],
      ["Spent with card this month", cents(spent), ""],
      ["Daily purchase limit", money(sel.card.dailyLimit), "ATM withdrawals up to $500/day"],
      ["Card ending", sel.card.last4, `Expires ${sel.card.expiry}`],
      ["Account opened", shortDate(new Date(`${sel.opened}T12:00:00`)) + `, ${sel.opened.slice(0, 4)}`, ""],
    );
  }
  $("#cardDetails").innerHTML = rows.map(([k, v, sub]) => `<div><dt>${k}</dt><dd><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</dd></div>`).join("");
  const recent = bank.transactions.filter((t) => t.account === sel.id).slice(0, 8);
  $("#cardRecent").innerHTML = recent.map((t) => `<li><span class="date">${shortDate(new Date(`${t.date}T12:00:00`))}</span><span class="who">${esc(titleCase(t.merchant))}<small>${CATS[catOf(t)].label}</small></span><span class="amt ${t.amount > 0 ? "in" : ""}">${t.amount > 0 ? "+" : "−"}${cents(Math.abs(t.amount))}</span></li>`).join("") || `<li class="muted">No recent activity.</li>`;

  $("#acctTable").innerHTML = `<thead><tr><th>Account</th><th>Type</th><th>Number</th><th class="num">Balance</th><th>Details</th></tr></thead><tbody>` + bank.accounts.map((a) => {
    const debt = a.kind === "credit" || a.kind === "loan";
    const det = a.kind === "credit" ? `${a.apr}% APR · ${money(a.limit - a.balance)} available · due ${shortDate(nextDue(a))}`
      : a.kind === "loan" ? `${a.apr}% APR · ${money(a.minPayment)}/mo${a.external ? " · held elsewhere" : ""}`
      : a.apy ? `${a.apy}% APY · earns about ${cents((a.balance * a.apy) / 100 / 12)}/mo${a.role === "emergency" ? " · emergency fund" : ""}`
      : a.holdings ? `${a.holdings.length} holdings${a.external ? " · held elsewhere" : ""}` : "";
    return `<tr><td><strong>${esc(a.name)}</strong></td><td>${KIND_LABEL[a.kind]}</td><td>••${a.mask}${a.card ? ` · card ••${a.card.last4}` : ""}</td><td class="num">${debt ? "−" : ""}${cents(a.balance)}</td><td class="small">${det}</td></tr>`;
  }).join("") + `</tbody>`;
}

$("#tab-accounts").addEventListener("click", (e) => {
  const pick = e.target.closest("[data-card]");
  if (pick) { state.selectedCard = pick.dataset.card; save(); renderAccounts(); return; }
  const t = e.target.closest("[data-ctrl]");
  if (t) { const c = ctrl(state.selectedCard); c[t.dataset.ctrl] = !c[t.dataset.ctrl]; save(); renderAccounts(); renderOvAccounts(); return; }
  if (e.target.closest("[data-report]")) {
    const c = ctrl(state.selectedCard); c.locked = true; save(); renderAccounts(); renderOvAccounts();
    $("#cardActions").insertAdjacentHTML("beforeend", `<p class="small" style="flex-basis:100%;margin:6px 0 0"><span class="status warn">Card locked.</span> In the real app this would start a replacement card. Demo only.</p>`);
  }
});
document.addEventListener("click", (e) => { const b = e.target.closest("[data-open-card]"); if (b) { state.selectedCard = b.dataset.openCard; save(); renderAccounts(); selectTab("accounts"); } });

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
    <span class="track"><span style="width:${(c.amount / max * 100).toFixed(1)}%;background:${limitOf(c.cat) != null && c.amount > limitOf(c.cat) + 0.5 ? "var(--red)" : c.bucket === "needs" ? "var(--s-needs)" : c.bucket === "wants" ? "var(--s-wants)" : "var(--muted)"}"></span>${limitOf(c.cat) ? `<i class="lim" style="left:${Math.min(100, (limitOf(c.cat) / max) * 100)}%"></i>` : ""}</span>
    <span class="amt">${money(c.amount)}</span></li>`).join("") +
    `<li class="cat-legend"><span><i style="background:var(--s-needs)"></i>Need</span><span><i style="background:var(--s-wants)"></i>Want</span><span><i style="background:var(--red)"></i>Over limit</span><span><i class="tick-key"></i>Limit</span></li>`;
}

// ---------------------------------------------------------------- budget sheet (auto from transactions + manual lines)
function renderBudget() {
  renderLimits();
  const ym = state.budgetMonth || LAST_FULL;
  monthOptions($("#budgetMonth"), ym, false);
  const cats = monthCategories(ym), man = (state.manual[ym] ||= { income: [], needs: [], wants: [], savings: [] });
  const flags = Object.fromEntries(budgetStatus(ym).map((x) => [x.cat, x]));
  GROUPS.forEach((g) => {
    const autoRows = cats.filter((c) => c.bucket === g).map((c) => `
      <tr class="auto-row ${flags[c.cat]?.status === "over" ? "over-row" : flags[c.cat]?.status === "pace" ? "pace-row" : ""}" data-cat="${c.cat}" tabindex="0" title="Show these transactions">
        <td><span class="cell-text">${CATS[c.cat].label}<span class="chip-auto">auto · ${c.count}</span>${flags[c.cat]?.status === "over" ? `<span class="chip-over">over by ${money(flags[c.cat].over)}</span>` : flags[c.cat]?.status === "pace" ? `<span class="chip-pace">on pace to go over</span>` : ""}</span></td>
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

// ---------------------------------------------------------------- investments
const CLASSES = {
  us_stock: { label: "US stocks", color: "var(--s-needs)" },
  intl_stock: { label: "International stocks", color: "var(--s-savings)" },
  bonds: { label: "Bonds", color: "var(--s-wants)" },
  cash: { label: "Cash & stable value", color: "var(--s-cash)" },
};
const classOf = (h) => (h.cls === "single_stock" ? "us_stock" : h.cls);
const PROFILES = {
  conservative: { label: "Conservative", target: { us_stock: 0.3, intl_stock: 0.1, bonds: 0.5, cash: 0.1 } },
  moderate: { label: "Moderate", target: { us_stock: 0.45, intl_stock: 0.15, bonds: 0.35, cash: 0.05 } },
  growth: { label: "Growth", target: { us_stock: 0.55, intl_stock: 0.25, bonds: 0.15, cash: 0.05 } },
  aggressive: { label: "Aggressive", target: { us_stock: 0.65, intl_stock: 0.3, bonds: 0.05, cash: 0 } },
};
const PROFILE_ORDER = ["conservative", "moderate", "growth", "aggressive"];
const INDEX_ER = 0.05; // a typical broad index fund, % per year

function portfolio() {
  const hs = bank.accounts.flatMap((a) => (a.holdings || []).map((h) => ({ ...h, account: a })));
  const total = hs.reduce((s, h) => s + h.value, 0);
  const byClass = Object.fromEntries(Object.keys(CLASSES).map((k) => [k, 0]));
  hs.forEach((h) => { byClass[classOf(h)] += h.value; });
  const fees = hs.reduce((s, h) => s + (h.value * h.er) / 100, 0);
  return { hs, total, byClass, fees, weightedEr: total ? (fees / total) * 100 : 0, single: hs.filter((h) => h.cls === "single_stock"), highFee: hs.filter((h) => h.er >= 0.5) };
}
const yearsToRetire = () => Math.max(1, num(state.invest.retireAge) - num(state.invest.age));
function suggestedProfile() {
  const yrs = yearsToRetire(), p = personality();
  let i = yrs >= 15 ? 2 : yrs >= 7 ? 1 : 0;
  if (p?.name === "Saver") i = Math.max(0, i - 1);
  if (p?.name === "Investor" && yrs >= 15) i = 3;
  return PROFILE_ORDER[i];
}
const riskProfile = () => state.invest.profile || suggestedProfile();

function match401k() {
  const k = bank.accounts.find((a) => a.contribution);
  if (!k) return null;
  const c = k.contribution, salary = bank.profile.grossSalary;
  const employee = (salary * c.employeePct) / 100;
  const employer = ((salary * Math.min(c.employeePct, c.matchUpToPct)) / 100) * c.matchRate;
  const employeeExtra = (salary * Math.max(0, c.matchUpToPct - c.employeePct)) / 100;
  return { account: k, ...c, salary, employee, employer, employeeExtra, missed: employeeExtra * c.matchRate };
}
function monthlyInvesting() {
  const ira = -txIn(LAST_FULL).filter((t) => catOf(t) === "investment").reduce((s, t) => s + t.amount, 0);
  const m = match401k();
  return { ira, k401: m ? (m.employee + m.employer) / 12 : 0, fullMatchExtra: m ? (m.employeeExtra + m.missed) / 12 : 0 };
}

function renderInvest() {
  const p = portfolio(), m = match401k(), mi = monthlyInvesting();
  const prof = riskProfile(), yrs = yearsToRetire(), r = num(state.invest.ret) / 100;
  const monthly = mi.ira + mi.k401;
  const endCurrent = futureValue(monthly, yrs, r, p.total);
  const real = (v) => v / Math.pow(1 + INFLATION, yrs);

  $("#investKpis").innerHTML = `
    <div class="kpi"><span class="label">Invested</span><span class="value">${money(p.total)}</span><span class="sub">Roth IRA + 401(k), ${p.hs.length} holdings</span></div>
    <div class="kpi"><span class="label">Going in each month</span><span class="value">${money(monthly)}</span><span class="sub">${money(mi.ira)} IRA · ${money(mi.k401)} 401(k) incl. match</span></div>
    <div class="kpi"><span class="label">401(k) match</span><span class="value">${m ? `${m.employeePct}% of ${m.matchUpToPct}%` : "–"}</span><span class="sub">${m && m.missed > 0 ? `<span class="status bad">Missing ${money(m.missed)}/yr free money</span>` : `<span class="status good">Getting the full match</span>`}</span></div>
    <div class="kpi"><span class="label">Fees you pay each year</span><span class="value">${money(p.fees)}</span><span class="sub">Weighted expense ratio ${p.weightedEr.toFixed(2)}%</span></div>
    <div class="kpi"><span class="label">Projected at ${num(state.invest.retireAge)}</span><span class="value">${money(endCurrent)}</span><span class="sub">${money(real(endCurrent))} in today's dollars</span></div>
    <div class="kpi"><span class="label">Income it could support</span><span class="value">${money(real(endCurrent) * 0.04 / 12)}/mo</span><span class="sub">Using the 4% rule, today's dollars</span></div>`;

  // allocation
  $("#riskProfile").value = prof;
  $("#riskWhy").textContent = state.invest.profile
    ? `You picked ${PROFILES[prof].label}. Suggested for you: ${PROFILES[suggestedProfile()].label}.`
    : `Suggested from ${yrs} years until retirement${personality() ? ` and your ${personality().name} money personality` : ""}. You can change it.`;
  renderAllocChart(p, PROFILES[prof].target);
  const diffs = Object.keys(CLASSES).map((k) => ({ k, d: p.byClass[k] / p.total - PROFILES[prof].target[k] }));
  const over = diffs.filter((x) => x.d > 0.05).sort((a, b) => b.d - a.d), under = diffs.filter((x) => x.d < -0.05).sort((a, b) => a.d - b.d);
  $("#rebalance").innerHTML = over.length || under.length
    ? `<div class="result-box"><strong>To match ${PROFILES[prof].label}:</strong><ul class="small tight">${over.map((x) => `<li>Trim ${CLASSES[x.k].label} by about ${money(x.d * p.total)}</li>`).join("")}${under.map((x) => `<li>Add about ${money(-x.d * p.total)} to ${CLASSES[x.k].label}</li>`).join("")}</ul><p class="muted small" style="margin:6px 0 0">Rebalance inside the IRA and 401(k), where trades aren't taxed, or point new contributions at what's underweight.</p></div>`
    : `<p class="status good">Within 5 points of your target in every asset class.</p>`;

  // projection
  $("#invAge").value = state.invest.age; $("#invRetire").value = state.invest.retireAge; $("#invReturn").value = state.invest.ret;
  $("#projLabel").textContent = `${yrs} years · ${num(state.invest.ret)}%/yr`;
  const series = [{ name: "Current contributions", color: "var(--s-needs)", monthly }];
  if (m && m.missed > 0) series.push({ name: `Raise 401(k) to ${m.matchUpToPct}% (full match)`, color: "var(--s-savings)", monthly: monthly + mi.fullMatchExtra });
  series.forEach((s) => { s.data = Array.from({ length: yrs + 1 }, (_, y) => futureValue(s.monthly, y, r, p.total)); });
  renderLineChart($("#projChart"), series, num(state.invest.age), yrs);
  const gain = series[1] ? series[1].data[yrs] - series[0].data[yrs] : 0;
  $("#projNote").textContent = `${gain > 0 ? `Taking the full match adds about ${money(gain)} by ${num(state.invest.retireAge)}. ` : ""}Projections assume a steady return; real markets move up and down. Inflation at ${pct(INFLATION)} is used for today's-dollar figures.`;

  // holdings
  $("#holdingsTable").innerHTML = `<thead><tr><th>Holding</th><th>Account</th><th>Type</th><th class="num">Value</th><th class="num">Share</th><th class="num">Expense ratio</th><th class="num">Cost / yr</th></tr></thead><tbody>` +
    p.hs.map((h) => {
      const share = h.value / p.total;
      const flag = h.er >= 0.5 ? ` <span class="status warn">High fee</span>` : h.cls === "single_stock" && share > 0.1 ? ` <span class="status warn">Concentrated</span>` : "";
      return `<tr><td><strong>${esc(h.name)}</strong>${flag}</td><td>${esc(h.account.name)}</td><td>${h.cls === "single_stock" ? "Single stock" : CLASSES[h.cls].label}</td><td class="num">${cents(h.value)}</td><td class="num">${pct(share, 1)}</td><td class="num">${h.er.toFixed(2)}%</td><td class="num">${cents((h.value * h.er) / 100)}</td></tr>`;
    }).join("") + `</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">${cents(p.total)}</td><td class="num">100%</td><td class="num">${p.weightedEr.toFixed(2)}%</td><td class="num">${cents(p.fees)}</td></tr></tfoot>`;
  const notes = p.highFee.map((h) => {
    const yearly = (h.value * (h.er - INDEX_ER)) / 100;
    const thirty = futureValue(0, 30, 0.06 - INDEX_ER / 100, h.value) - futureValue(0, 30, 0.06 - h.er / 100, h.value);
    return `<li><strong>${esc(h.name)}</strong> charges ${h.er.toFixed(2)}% a year. A broad index fund at ~${INDEX_ER}% would save about ${money(yearly)} this year and about ${money(thirty)} over 30 years on this balance alone.</li>`;
  });
  p.single.forEach((h) => { if (h.value / p.total > 0.1) notes.push(`<li><strong>${pct(h.value / p.total)} of your investments is ${esc(h.name)}.</strong> Your paycheck already depends on this company. Many planners suggest keeping a single stock under 10%; selling inside the 401(k) isn't taxed.</li>`); });
  $("#feeNote").innerHTML = notes.length ? `<ul class="small tight">${notes.join("")}</ul>` : "";
}

function renderAllocChart(p, target) {
  const el = $("#allocChart"), keys = Object.keys(CLASSES);
  const rows = [{ label: "Now", share: Object.fromEntries(keys.map((k) => [k, p.byClass[k] / p.total])) }, { label: "Target", share: target }];
  const W = 520, padL = 64, barW = W - padL - 8, bh = 26, H = rows.length * 46 + 4;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Current versus target asset allocation">`;
  rows.forEach((r, i) => {
    const y = i * 46 + 6;
    svg += `<text x="${padL - 10}" y="${y + bh / 2 + 4}" text-anchor="end" style="fill:var(--ink);font-weight:600">${r.label}</text>`;
    let x = padL;
    keys.forEach((k) => {
      const w = r.share[k] * barW;
      if (w <= 0) return;
      svg += `<rect x="${x}" y="${y}" width="${Math.max(0, w - 2)}" height="${bh}" rx="3" fill="${CLASSES[k].color}" data-alloc="${i}:${k}"/>`;
      if (w > 44) svg += `<text x="${x + w / 2 - 1}" y="${y + bh / 2 + 4}" text-anchor="middle" style="fill:#fff;font-weight:600;pointer-events:none">${pct(r.share[k])}</text>`;
      x += w;
    });
  });
  svg += `</svg>`;
  el.className = "chart";
  el.innerHTML = `<div class="legend">${keys.map((k) => `<span><i style="background:${CLASSES[k].color}"></i>${CLASSES[k].label}</span>`).join("")}</div>${svg}`;
  $$("[data-alloc]", el).forEach((rect) => {
    const [i, k] = rect.dataset.alloc.split(":");
    const html = `<strong>${CLASSES[k].label}</strong><br>Now <b>${pct(rows[0].share[k], 1)}</b> (${money(p.byClass[k])})<br>Target <b>${pct(target[k])}</b> (${money(target[k] * p.total)})`;
    rect.addEventListener("mousemove", (e) => showTip(html, e.clientX, e.clientY));
    rect.addEventListener("mouseleave", hideTip);
  });
}

// Generic year-by-year line chart with crosshair, used for the retirement projection.
function renderLineChart(el, series, startAge, years) {
  const W = 560, H = 250, padL = 56, padR = 96, padT = 10, padB = 28;
  const maxV = Math.max(...series.flatMap((s) => s.data));
  const raw = maxV / 4, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), step = Math.ceil(raw / mag) * mag, maxY = step * 4;
  const x = (yr) => padL + (yr / years) * (W - padL - padR);
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected balance by age">`;
  for (let v = 0; v <= maxY + 1; v += step) svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${compactUsd.format(v)}</text>`;
  const tickEvery = years > 30 ? 10 : 5;
  for (let yr = 0; yr <= years; yr += tickEvery) svg += `<text class="axis-label" x="${x(yr)}" y="${H - 8}" text-anchor="middle">Age ${startAge + yr}</text>`;
  series.forEach((s, i) => {
    svg += `<path d="${s.data.map((v, j) => `${j ? "L" : "M"}${x(j).toFixed(1)},${y(v).toFixed(1)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    svg += `<text x="${x(years) + 8}" y="${y(s.data[years]) + (series.length > 1 ? (i === 0 ? 14 : -4) : 4)}" style="fill:var(--ink);font-weight:600">${compactUsd.format(s.data[years])}</text>`;
  });
  svg += `<line class="xh grid-line" x1="0" x2="0" y1="${padT}" y2="${H - padB}" style="stroke:var(--ink-2);visibility:hidden"/>`;
  series.forEach((s, i) => { svg += `<circle class="dot" data-i="${i}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2" style="visibility:hidden"/>`; });
  svg += `<rect class="hit" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent"/></svg>`;
  el.className = "chart";
  el.innerHTML = (series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i class="line" style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "") + svg;
  const svgEl = $("svg", el), xh = $(".xh", el);
  $(".hit", el).addEventListener("mousemove", (e) => {
    const pt = svgEl.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const q = pt.matrixTransform(svgEl.getScreenCTM().inverse());
    const yr = Math.max(0, Math.min(years, Math.round(((q.x - padL) / (W - padL - padR)) * years)));
    xh.setAttribute("x1", x(yr)); xh.setAttribute("x2", x(yr)); xh.style.visibility = "visible";
    $$(".dot", el).forEach((c) => { c.setAttribute("cx", x(yr)); c.setAttribute("cy", y(series[+c.dataset.i].data[yr])); c.style.visibility = "visible"; });
    showTip(`<strong>Age ${startAge + yr}</strong><br>${series.map((s) => `${esc(s.name)}: <b>${money(s.data[yr])}</b>`).join("<br>")}`, e.clientX, e.clientY);
  });
  $(".hit", el).addEventListener("mouseleave", () => { hideTip(); xh.style.visibility = "hidden"; $$(".dot", el).forEach((c) => { c.style.visibility = "hidden"; }); });
}

// ---------------------------------------------------------------- financial advisors
function advisorFit() {
  const p = portfolio(), t = totals(LAST_FULL), bs = balanceSheet(), m = match401k();
  const hiDebt = allDebts().some((d) => d.type !== "mortgage" && num(d.apr) >= 10 && num(d.balance) > 0);
  const bigGoals = state.goals.filter((g) => ["home", "college"].includes(g.kind));
  const reasons = [];
  if (hiDebt || t.needs + t.wants > t.income) reasons.push({ need: true, text: `You carry ${money(bs.cardDebt)} on a ${allDebts().find((d) => d.type === "card")?.apr ?? ""}% card. A free session with a debt and credit coach (or a nonprofit credit counselor) can build a payoff plan.` });
  if (m && m.missed > 0) reasons.push({ need: false, text: `Raising your 401(k) from ${m.employeePct}% to ${m.matchUpToPct}% captures ${money(m.missed)}/yr of match. You can do this yourself in your employer's benefits portal.` });
  if (p.highFee.length || p.single.some((h) => h.value / p.total > 0.1)) reasons.push({ need: false, text: "Your portfolio has a high-fee fund and a concentrated company-stock position. The Invest tab shows the fixes; an investment specialist can review them with you." });
  if (bigGoals.length) reasons.push({ need: true, text: `You have ${bigGoals.map((g) => g.name.toLowerCase()).join(" and ")} on your list. A one-time plan from a fee-only planner is worth it for decisions this size.` });
  if (p.total < 50000) reasons.push({ need: false, text: `With ${money(p.total)} invested, a 1% ongoing advisor would cost ${money(p.total * 0.01)}/yr now and much more as you grow. Low-cost index funds or a robo-advisor cover this stage.` });
  else if (p.total >= 250000) reasons.push({ need: true, text: `At ${money(p.total)} invested, tax planning and withdrawal strategy can be worth an ongoing fiduciary relationship.` });
  const complex = reasons.some((r) => r.need);
  const rec = p.total >= 250000 ? ["Ongoing fee-only fiduciary", "Flat-fee or AUM, ideally under 1%"]
    : complex ? ["A one-time session, not ongoing management", "Start with a free session with one of our planners, or a flat-fee plan from a fee-only fiduciary"]
    : ["Do it yourself or use a robo-advisor", "Your situation is simple enough for low-cost tools; revisit after big life changes"];
  return { rec, reasons, complex };
}

function renderAdvisors() {
  const fit = advisorFit();
  $("#advisorFit").innerHTML = `<p class="rec-head"><span class="rec-pill">Our suggestion</span> <strong>${esc(fit.rec[0])}</strong></p><p class="muted">${esc(fit.rec[1])}.</p>
    <ul class="fit-list">${fit.reasons.map((r) => `<li class="${r.need ? "need" : "self"}"><span class="fit-tag">${r.need ? "Advice helps" : "You can do this"}</span>${esc(r.text)}</li>`).join("")}</ul>`;

  const fc = state.feeCalc, p = portfolio(), mi = monthlyInvesting();
  const amount = fc.amount ?? Math.round(p.total), monthly = fc.monthly ?? Math.round(mi.ira + mi.k401), years = fc.years ?? 30;
  $("#feeAmount").value = amount; $("#feeMonthly").value = monthly; $("#feeYears").value = years;
  const opts = [
    { name: "DIY index funds", pctFee: 0.05 }, { name: "Robo-advisor", pctFee: 0.3 }, { name: "Hybrid", pctFee: 0.5 },
    { name: "AUM advisor", pctFee: 1.0 }, { name: "Flat-fee planner", flat: 2000 },
  ];
  const end = (o) => {
    if (o.flat != null) { let b = amount; for (let i = 0; i < years * 12; i++) b = b * (1 + 0.06 / 12) + monthly - o.flat / 12; return b; }
    return futureValue(monthly, years, 0.06 - o.pctFee / 100, amount);
  };
  const base = end(opts[0]);
  $("#feeCompare").innerHTML = `<table class="compare"><thead><tr><th>Option</th><th>Fee now</th><th>After ${years} yrs</th><th>Cost vs DIY</th></tr></thead><tbody>${opts.map((o) => {
    const v = end(o);
    return `<tr><td>${o.name}</td><td>${o.flat != null ? `${money(o.flat)}/yr` : `${o.pctFee}% · ${money((amount * o.pctFee) / 100)}/yr`}</td><td>${money(v)}</td><td>${v >= base - 1 ? "–" : `<span class="status warn">−${money(base - v)}</span>`}</td></tr>`;
  }).join("")}</tbody></table>`;
  renderBooking();
}

const ADVISORS = [
  { id: "priya", name: "Priya Raman", creds: "CFP®", role: "Financial planner · salaried, no commissions", topics: ["budget", "home", "college", "retirement"], fee: "Free for customers", initials: "PR" },
  { id: "marcus", name: "Marcus Lee", creds: "CFA", role: "Investment specialist", topics: ["investing", "retirement"], fee: "Free review · managed portfolios 0.35%/yr", initials: "ML" },
  { id: "dana", name: "Dana Ortiz", creds: "Certified credit counselor", role: "Debt and credit coach", topics: ["budget", "credit"], fee: "Free", initials: "DO" },
];
const TOPICS = { budget: "Budget & debt", investing: "Investing & my portfolio", retirement: "Retirement", home: "Buying a home", college: "College planning", credit: "Credit score" };
function slots() {
  const out = [], d = new Date(today);
  while (out.length < 6) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    ["10:00 AM", "3:30 PM"].forEach((t) => out.push(`${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${t}`));
  }
  return out;
}
function renderBooking() {
  const el = $("#booking"), b = state.booking;
  if (b) {
    const a = ADVISORS.find((x) => x.id === b.advisor);
    el.innerHTML = `<div class="booked">
      <div class="advisor-head"><span class="avatar">${a.initials}</span><div><strong>${esc(a.name)}, ${esc(a.creds)}</strong><span class="muted small">${esc(a.role)}</span></div></div>
      <p><span class="status good">Booked</span> ${esc(b.slot)} · video call · ${esc(TOPICS[b.topic])}</p>
      <p class="muted small">${b.share ? "Your LearnFi summary (balances, budget, goals) will be shared with your advisor." : "You chose not to share your LearnFi summary."} Demo booking: no real appointment was made.</p>
      <div class="form-actions"><button class="btn primary" id="prepBrief">${b.brief ? "Refresh prep notes" : "Prepare with AI"}</button><button class="btn secondary" id="cancelBooking">Cancel booking</button></div>
      <div id="briefOut" class="ai-output">${b.brief ? renderMarkdown(b.brief) : ""}</div>
    </div>`;
    return;
  }
  const topic = state.bookTopic || (advisorFit().complex ? "budget" : "investing");
  const list = ADVISORS.filter((a) => a.topics.includes(topic));
  el.innerHTML = `
    <div class="field-row"><label class="field">What do you want help with?
      <select id="bookTopic">${Object.entries(TOPICS).map(([k, v]) => `<option value="${k}"${k === topic ? " selected" : ""}>${v}</option>`).join("")}</select></label></div>
    <div class="advisor-cards" role="radiogroup" aria-label="Advisor">${list.map((a, i) => `
      <label class="advisor-card"><input type="radio" name="advisor" value="${a.id}"${i === 0 ? " checked" : ""}/>
        <span class="advisor-head"><span class="avatar">${a.initials}</span><span><strong>${esc(a.name)}, ${esc(a.creds)}</strong><span class="muted small">${esc(a.role)}</span></span></span>
        <span class="small">${esc(a.fee)} · fiduciary when giving advice</span></label>`).join("")}</div>
    <p class="small" style="margin:12px 0 6px"><strong>Pick a time</strong> (30-minute video call)</p>
    <div class="slots" role="radiogroup" aria-label="Time">${slots().map((s, i) => `<label class="slot"><input type="radio" name="slot" value="${esc(s)}"${i === 0 ? " checked" : ""}/><span>${esc(s)}</span></label>`).join("")}</div>
    <label class="consent"><input type="checkbox" id="shareSummary" checked/> Share my LearnFi summary (balances, budget, goals) with the advisor before the call</label>
    <div class="form-actions"><button class="btn primary" id="bookBtn">Book session</button></div>
    <p class="muted small">Demo only. Advisors shown are fictional examples of what a bank could offer.</p>`;
}

const BRIEF_SYSTEM = `You prepare a customer for a meeting with a financial advisor at their bank. Using their account data, write short meeting-prep notes in markdown with exactly these sections:
## Your snapshot (4-5 bullets with their real numbers)
## What to ask (5 questions specific to this advisor and topic, including how the advisor is paid and whether they act as a fiduciary)
## Bring or decide beforehand (3 bullets)
Keep it under 250 words. Be educational and neutral; don't recommend specific securities or third-party products.`;
async function prepBrief(btn) {
  const b = state.booking, a = ADVISORS.find((x) => x.id === b.advisor);
  btn.disabled = true; btn.textContent = "Preparing…";
  const out = $("#briefOut");
  out.innerHTML = `<p class="muted">Reading your accounts…</p>`;
  try {
    const text = await aiComplete(BRIEF_SYSTEM, [{ role: "user", content: `Meeting: ${TOPICS[b.topic]} with ${a.name}, ${a.creds} (${a.role}; ${a.fee}).\nMy account data (JSON):\n${JSON.stringify(financialContext())}` }], (t) => { out.innerHTML = renderMarkdown(t); });
    state.booking.brief = text; save();
    out.innerHTML = renderMarkdown(text);
    btn.textContent = "Refresh prep notes";
  } catch (err) {
    out.innerHTML = `${err.text ? renderMarkdown(err.text) : ""}<p class="error">${esc(err.message || "Couldn't prepare notes.")}</p>`;
    btn.textContent = "Prepare with AI";
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------- global refresh
function refresh() {
  save();
  const advice = advise();
  renderOverview();
  updateHome();
  renderGoals();
  renderInvest();
  renderAdvisors();
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

// invest
$("#tab-invest").addEventListener("input", (e) => {
  const map = { invAge: "age", invRetire: "retireAge", invReturn: "ret" };
  if (map[e.target.id]) { state.invest[map[e.target.id]] = num(e.target.value); }
  else if (e.target.id === "riskProfile") { state.invest.profile = e.target.value === suggestedProfile() ? null : e.target.value; }
  else return;
  refresh();
});

// advisors
$("#tab-advisors").addEventListener("input", (e) => {
  const map = { feeAmount: "amount", feeMonthly: "monthly", feeYears: "years" };
  if (map[e.target.id]) { state.feeCalc[map[e.target.id]] = num(e.target.value); save(); renderAdvisors(); $(`#${e.target.id}`).focus(); }
  else if (e.target.id === "bookTopic") { state.bookTopic = e.target.value; renderBooking(); }
});
$("#tab-advisors").addEventListener("click", (e) => {
  if (e.target.id === "bookBtn") {
    const advisor = $("input[name=advisor]:checked")?.value, slot = $("input[name=slot]:checked")?.value;
    if (!advisor || !slot) return;
    state.booking = { advisor, slot, topic: $("#bookTopic").value, share: $("#shareSummary").checked, brief: null };
    save(); renderBooking();
  } else if (e.target.id === "cancelBooking") { state.booking = null; save(); renderBooking(); }
  else if (e.target.id === "prepBrief") prepBrief(e.target);
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
    investments: (() => { const pf = portfolio(), mt = match401k(), mi = monthlyInvesting(); return {
      age: num(state.invest.age), retire_age: num(state.invest.retireAge), risk_profile: PROFILES[riskProfile()].label,
      holdings: pf.hs.map((h) => ({ name: h.name, account: h.account.name, type: h.cls, value: h.value, expense_ratio_pct: h.er })),
      allocation_pct: Object.fromEntries(Object.keys(CLASSES).map((k) => [CLASSES[k].label, +(pf.byClass[k] / pf.total * 100).toFixed(1)])),
      target_allocation_pct: Object.fromEntries(Object.keys(CLASSES).map((k) => [CLASSES[k].label, PROFILES[riskProfile()].target[k] * 100])),
      annual_fees: Math.round(pf.fees), monthly_investing: Math.round(mi.ira + mi.k401),
      k401: mt ? { employee_pct: mt.employeePct, match: `${mt.matchRate * 100}% up to ${mt.matchUpToPct}%`, missed_match_per_year: Math.round(mt.missed), gross_salary: mt.salary } : null,
    }; })(),
    budget_limits: Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [CATS[k].label, limitOf(k)])),
    over_budget_this_month: budgetFlags(currentYM).flags.map((f) => f.text),
    over_budget_last_month: budgetFlags(LAST_FULL).flags.map((f) => f.text),
    advisor_suggestion: advisorFit().rec.join(": "),
    advisor_booking: state.booking ? { advisor: ADVISORS.find((a) => a.id === state.booking.advisor)?.name, topic: TOPICS[state.booking.topic], when: state.booking.slot } : null,
    advisor_flags: advise().filter((a) => a.priority === "high" || a.priority === "med").map((a) => a.title),
    transactions_csv: "date,merchant,amount,category,account\n" + bank.transactions.map((x) => `${x.date},${x.merchant.replace(/,/g, " ")},${x.amount},${CATS[catOf(x)].label},${acct(x.account).name}`).join("\n"),
  };
}

const ASSISTANT_SYSTEM = `You are the money assistant inside a bank's consumer app. You help one customer understand and improve their finances using their own account data, which is provided as JSON at the start of the conversation. Speak plainly to someone who may be new to personal finance.

Ground advice in this framework, in priority order: (1) a working budget, with 50/30/20 needs/wants/savings as an adjustable starting point; (2) an emergency fund of 3–6 months of needs in high-yield savings; (3) paying off high-interest debt (avalanche or snowball), then paying cards in full; (4) SMART goals: short term (<1 yr) in cash/HYSA, medium (1–5 yrs) in HYSA/CDs/some bonds, long (5+ yrs) in diversified low-cost index funds in tax-advantaged accounts (401(k) match first, then IRA/Roth IRA); (5) diversify and review regularly. Bring in inflation, credit score factors (payment history 35%, utilization 30%, history 15%, mix 10%, new credit 10%), rent vs buy, the true cost of college and financial aid, insurance and scam awareness when they're relevant.

Rules:
- Use the customer's real numbers: name merchants, months, balances and amounts from the data. Do the arithmetic.
- Answer the question that was asked first, then add at most one next step.
- For investing questions, use their actual holdings, fees, allocation and 401(k) match. Explain trade-offs; don't promise returns.
- If something needs a professional (complex taxes, estate, insurance needs, a big life decision), say so and point to the Advisors tab, where they can compare advice types or book a session.
- You can't move money or change accounts. Suggest the action and say where in the app to do it (Activity, Budget, Net Worth, Invest, Mortgage, Goals, Advisors).
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
  "Is my investment mix right for my age?",
  "Do I need a financial advisor, and what kind?",
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
  renderAccounts();
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
maybeShowMascotToast();
renderBudgetCheck();
try { const t = localStorage.getItem("learnfi.tab"); if (t && $(`#tab-${t}`)) selectTab(t); } catch { /* ignore */ }
