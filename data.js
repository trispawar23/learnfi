// Demo bank feed for the prototype.
// In the real app this module is replaced by the bank's own account and transaction APIs;
// the rest of the app only depends on the shape returned by load().
//
// accounts:     { id, name, mask, kind: checking|savings|credit|loan|investment|retirement,
//                 balance, role?, apy?, limit?, apr?, minPayment?, dueDay?, debtType?, external? }
// transactions: { id, date: "YYYY-MM-DD", account, merchant, amount (+ in / − out), category|null, transfer }
(function () {
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pad = (n) => String(n).padStart(2, "0");

  function load(today = new Date()) {
    const accounts = [
      { id: "chk", name: "Everyday Checking", mask: "4821", kind: "checking", balance: 1240.18, apy: 0.01 },
      { id: "sav", name: "High-Yield Savings", mask: "7710", kind: "savings", role: "emergency", balance: 3000, apy: 4.0 },
      { id: "bucket", name: "Laptop savings bucket", mask: "7711", kind: "savings", balance: 300, apy: 4.0 },
      { id: "card", name: "Rewards Credit Card", mask: "3392", kind: "credit", balance: 2412.55, limit: 6000, apr: 24.99, minPayment: 75, dueDay: 26 },
      { id: "auto", name: "Auto Loan", mask: "5520", kind: "loan", debtType: "auto", balance: 9000, apr: 7.5, minPayment: 250 },
      { id: "student", name: "Student Loan", mask: "0912", kind: "loan", debtType: "student", balance: 18000, apr: 5.5, minPayment: 200, external: true },
      { id: "ira", name: "Roth IRA", mask: "6604", kind: "investment", balance: 4200 },
      { id: "k401", name: "Employer 401(k)", mask: "2210", kind: "retirement", balance: 12000, external: true },
    ];

    const transactions = [];
    let n = 0;
    for (let back = 3; back >= 0; back--) {
      const first = new Date(today.getFullYear(), today.getMonth() - back, 1);
      const y = first.getFullYear(), m = first.getMonth() + 1, ym = `${y}-${pad(m)}`;
      const days = new Date(y, m, 0).getDate();
      const last = back === 0 ? today.getDate() : days;
      const r = rng(y * 100 + m);
      const between = (a, b) => Math.round((a + (b - a) * r()) * 100) / 100;
      const add = (day, account, merchant, amount, category, transfer = false) => {
        if (day <= last) transactions.push({ id: `t${++n}`, date: `${ym}-${pad(Math.min(day, days))}`, account, merchant, amount, category, transfer });
      };
      const monthIndex = 3 - back; // 0 = oldest month

      // income
      add(1, "chk", "ACME LOGISTICS PAYROLL", 1550, "paycheck");
      add(15, "chk", "ACME LOGISTICS PAYROLL", 1550, "paycheck");
      add(20, "chk", "ETSY PAYOUT", between(240, 360), "side_income");
      // fixed needs
      add(1, "chk", "MAPLE COURT APARTMENTS", -1100, "housing");
      add(5, "chk", "AUTO LOAN PAYMENT ••5520", -250, "loan_payment");
      add(8, "card", "NORTHWIND MOBILE", -60, "phone_internet");
      add(10, "chk", "FIBERLINK INTERNET", -60, "phone_internet");
      add(12, "card", "SAFEROAD INSURANCE", -90, "transport");
      add(18, "chk", "CITY POWER & WATER", -between(105, 135), "utilities");
      add(25, "chk", "STUDENT LOAN SERVICER", -200, "loan_payment");
      [3, 10, 17, 24].forEach((d) => add(d, "card", "FRESHMART", -between(55, 75), "groceries"));
      [6, 20].forEach((d) => add(d, "card", "QUICKFUEL", -between(35, 45), "transport"));
      add(28, "card", "INTEREST CHARGE", -between(45, 52), "fees_interest");
      // wants
      const diners = ["CORNER CAFE", "NOODLE HOUSE", "TAQUERIA SOL", "PIZZA PLANET"];
      [4, 7, 11, 13, 19, 23, 27].forEach((d) => add(d, "card", diners[Math.floor(r() * diners.length)], -between(12, 58), "dining"));
      add(2, "card", "FITLAB GYM", -60, "fitness");
      add(3, "card", "STREAMFLIX", -15.49, "subscriptions");
      add(14, "card", "TUNEBOX MUSIC", monthIndex < 2 ? -9.99 : -10.99, "subscriptions");
      add(22, "card", "VIDPLUS", -18.99, "subscriptions");
      add(9, "card", "CINEMACITY", -between(18, 40), "entertainment");
      if (monthIndex === 1) add(21, "card", "TICKETHUB", -85, "entertainment");
      [7, 16, 26].forEach((d) => add(d, "card", "SHOPMART ONLINE", -between(25, 70), "shopping"));
      // merchants the bank couldn't categorize
      add(12, "card", "SQ *KIOSK 2231", -between(8, 20), null);
      add(24, "card", "PAYPAL *JMARKET", -between(20, 45), null);
      // savings and transfers
      add(2, "chk", "TRANSFER TO SAVINGS ••7710", -200, "savings_transfer");
      add(16, "chk", "TRANSFER TO LAPTOP BUCKET ••7711", -75, "savings_transfer");
      add(16, "chk", "ROTH IRA CONTRIBUTION ••6604", -150, "investment");
      add(26, "chk", "PAYMENT TO CREDIT CARD ••3392", -between(480, 560), "card_payment", true);
    }
    transactions.sort((a, b) => b.date.localeCompare(a.date) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
    return { accounts, transactions, creditScore: 680, asOf: today };
  }

  window.LearnFiBank = { load };
})();
