/**
 * Project economics.
 *
 * Two audiences, as the financial-analysis review pointed out, and conflating
 * them produces numbers that are wrong for both:
 *
 * - **Owner cash flow** (rooftop, behind the meter): what the bill payer saves,
 *   net of a loan, incentives and the tariff they escape.
 * - **LCOE** (utility scale, in front of the meter): the discounted cost of a
 *   megawatt-hour over the plant's life, which is what a PPA is compared against.
 *
 * Both are computed here. Neither is presented as a valuation: cost inputs are
 * regional and volatile, so every result reports the assumptions it used.
 */

export interface CostAssumptions {
  /** Installed cost per watt DC, in the project currency. */
  capexPerWattDc: number;
  /** Annual operations and maintenance, per kW DC per year. */
  opexPerKwYear: number;
  /** Inverter replacement cost per kW DC, applied once mid-life. */
  inverterReplacementPerKw: number;
  inverterReplacementYear: number;
  currency: string;
  source: string;
}

/**
 * Defaults are order-of-magnitude anchors from recent US and EU cost surveys,
 * split by scale because a rooftop installation costs several times what a
 * utility plant does per watt. They exist so a first pass is possible; real work
 * replaces them.
 */
export const COST_DEFAULTS: Record<"residential" | "commercial" | "utility", CostAssumptions> = {
  residential: {
    capexPerWattDc: 2.6,
    opexPerKwYear: 22,
    inverterReplacementPerKw: 180,
    inverterReplacementYear: 15,
    currency: "USD",
    source: "NREL/LBNL US residential PV cost benchmarks",
  },
  commercial: {
    capexPerWattDc: 1.5,
    opexPerKwYear: 16,
    inverterReplacementPerKw: 120,
    inverterReplacementYear: 15,
    currency: "USD",
    source: "NREL US commercial rooftop PV cost benchmarks",
  },
  utility: {
    capexPerWattDc: 1.0,
    opexPerKwYear: 13,
    inverterReplacementPerKw: 90,
    inverterReplacementYear: 15,
    currency: "USD",
    source: "NREL US utility-scale PV cost benchmarks",
  },
};

export interface FinanceInput {
  capacityKwDc: number;
  /** First-year AC energy, kWh. */
  annualKwh: number;
  costs: CostAssumptions;
  /** Analysis period in years. 25 to 30 is conventional for PV. */
  lifetimeYears?: number;
  /** Annual output decline as a fraction, e.g. 0.005 for 0.5% a year. */
  degradationRate?: number;
  /** Real discount rate as a fraction. */
  discountRate?: number;
  /** Upfront subsidy as a fraction of capex, e.g. 0.3 for a 30% credit. */
  incentiveFraction?: number;
  /** Fixed upfront rebate in currency units. */
  incentiveFixed?: number;
}

export interface YearRow {
  year: number;
  energyKwh: number;
  /** Positive is money in, negative is money out. */
  netCashFlow: number;
  cumulativeCashFlow: number;
  discountedCashFlow: number;
}

export interface LcoeResult {
  /** Levelised cost per kWh, in the project currency. */
  lcoePerKwh: number;
  netCapex: number;
  grossCapex: number;
  totalDiscountedCost: number;
  totalDiscountedEnergyKwh: number;
  lifetimeYears: number;
  discountRate: number;
  assumptions: string[];
  method: string;
}

/**
 * Levelised cost of energy.
 *
 * LCOE = discounted lifetime cost / discounted lifetime energy. The energy is
 * discounted too, which is what people most often get wrong; without it the
 * result is not a levelised cost and cannot be compared with a PPA price.
 */
export function computeLcoe(input: FinanceInput): LcoeResult {
  const {
    capacityKwDc,
    annualKwh,
    costs,
    lifetimeYears = 25,
    degradationRate = 0.005,
    discountRate = 0.06,
    incentiveFraction = 0,
    incentiveFixed = 0,
  } = input;

  const grossCapex = capacityKwDc * 1000 * costs.capexPerWattDc;
  const netCapex = Math.max(0, grossCapex * (1 - incentiveFraction) - incentiveFixed);

  let discountedCost = netCapex;
  let discountedEnergy = 0;

  for (let year = 1; year <= lifetimeYears; year += 1) {
    const factor = (1 + discountRate) ** year;
    const energy = annualKwh * (1 - degradationRate) ** (year - 1);

    let cost = capacityKwDc * costs.opexPerKwYear;
    if (year === costs.inverterReplacementYear) {
      cost += capacityKwDc * costs.inverterReplacementPerKw;
    }

    discountedCost += cost / factor;
    discountedEnergy += energy / factor;
  }

  return {
    lcoePerKwh: discountedEnergy > 0 ? discountedCost / discountedEnergy : Number.POSITIVE_INFINITY,
    netCapex,
    grossCapex,
    totalDiscountedCost: discountedCost,
    totalDiscountedEnergyKwh: discountedEnergy,
    lifetimeYears,
    discountRate,
    assumptions: [
      `Capex ${costs.currency} ${costs.capexPerWattDc.toFixed(2)}/W DC (${costs.source}).`,
      `O&M ${costs.currency} ${costs.opexPerKwYear}/kW/year, inverter replacement in year ${costs.inverterReplacementYear}.`,
      `${(degradationRate * 100).toFixed(2)}% annual degradation over ${lifetimeYears} years.`,
      `${(discountRate * 100).toFixed(1)}% real discount rate.`,
      incentiveFraction > 0 || incentiveFixed > 0
        ? `Incentives: ${(incentiveFraction * 100).toFixed(0)}% of capex plus a fixed ${costs.currency} ${incentiveFixed}.`
        : "No incentives applied.",
    ],
    method:
      "LCOE = discounted lifetime cost / discounted lifetime energy, both at the same " +
      "real discount rate. Excludes tax, depreciation and financing structure.",
  };
}

export interface OwnerCashFlowInput extends FinanceInput {
  /** Retail electricity price displaced, per kWh. */
  tariffPerKwh: number;
  /** Annual real tariff escalation as a fraction. */
  tariffEscalation?: number;
  /** Share of generation consumed on site rather than exported. */
  selfConsumptionFraction?: number;
  /** Price received for exported energy, per kWh. */
  exportPricePerKwh?: number;
  /** Loan covering this fraction of net capex; 0 means a cash purchase. */
  loanFraction?: number;
  loanRate?: number;
  loanTermYears?: number;
}

export interface OwnerCashFlowResult {
  netCapex: number;
  /** Cash the owner puts in on day one. */
  upfrontCash: number;
  annualLoanPayment: number;
  rows: YearRow[];
  /** Undiscounted years to recover the upfront cash, or null if never. */
  simplePaybackYears: number | null;
  /** Discounted payback: the honest one. */
  discountedPaybackYears: number | null;
  netPresentValue: number;
  /** Internal rate of return as a fraction, or null when it does not exist. */
  internalRateOfReturn: number | null;
  lifetimeSavings: number;
  assumptions: string[];
  method: string;
}

/**
 * Owner cash flow for a behind-the-meter system.
 *
 * Self-consumed energy is worth the retail tariff; exported energy is worth
 * whatever the export arrangement pays, which is usually much less. Treating all
 * generation as retail-valued is the single most common way rooftop payback gets
 * overstated, so the split is explicit and required.
 */
export function computeOwnerCashFlow(input: OwnerCashFlowInput): OwnerCashFlowResult {
  const {
    capacityKwDc,
    annualKwh,
    costs,
    lifetimeYears = 25,
    degradationRate = 0.005,
    discountRate = 0.05,
    incentiveFraction = 0,
    incentiveFixed = 0,
    tariffPerKwh,
    tariffEscalation = 0.02,
    selfConsumptionFraction = 0.5,
    exportPricePerKwh = 0,
    loanFraction = 0,
    loanRate = 0.06,
    loanTermYears = 10,
  } = input;

  const grossCapex = capacityKwDc * 1000 * costs.capexPerWattDc;
  const netCapex = Math.max(0, grossCapex * (1 - incentiveFraction) - incentiveFixed);
  const loanPrincipal = netCapex * Math.min(1, Math.max(0, loanFraction));
  const upfrontCash = netCapex - loanPrincipal;
  const annualLoanPayment = amortisedPayment(loanPrincipal, loanRate, loanTermYears);

  const rows: YearRow[] = [];
  let cumulative = -upfrontCash;
  let netPresentValue = -upfrontCash;
  const undiscountedFlows: number[] = [-upfrontCash];

  for (let year = 1; year <= lifetimeYears; year += 1) {
    const energy = annualKwh * (1 - degradationRate) ** (year - 1);
    const tariff = tariffPerKwh * (1 + tariffEscalation) ** (year - 1);
    const exportPrice = exportPricePerKwh * (1 + tariffEscalation) ** (year - 1);

    const selfConsumed = energy * selfConsumptionFraction;
    const exported = energy - selfConsumed;
    const revenue = selfConsumed * tariff + exported * exportPrice;

    let cost = capacityKwDc * costs.opexPerKwYear;
    if (year === costs.inverterReplacementYear) {
      cost += capacityKwDc * costs.inverterReplacementPerKw;
    }
    if (year <= loanTermYears) {
      cost += annualLoanPayment;
    }

    const net = revenue - cost;
    cumulative += net;
    const discounted = net / (1 + discountRate) ** year;
    netPresentValue += discounted;
    undiscountedFlows.push(net);

    rows.push({
      year,
      energyKwh: energy,
      netCashFlow: net,
      cumulativeCashFlow: cumulative,
      discountedCashFlow: discounted,
    });
  }

  return {
    netCapex,
    upfrontCash,
    annualLoanPayment,
    rows,
    simplePaybackYears: crossoverYear(rows, (row) => row.cumulativeCashFlow),
    discountedPaybackYears: discountedCrossover(rows, upfrontCash),
    netPresentValue,
    internalRateOfReturn: internalRateOfReturn(undiscountedFlows),
    lifetimeSavings: cumulative,
    assumptions: [
      `Capex ${costs.currency} ${costs.capexPerWattDc.toFixed(2)}/W DC (${costs.source}).`,
      `${(selfConsumptionFraction * 100).toFixed(0)}% of generation self-consumed at ` +
        `${costs.currency} ${tariffPerKwh.toFixed(3)}/kWh; the rest exported at ` +
        `${costs.currency} ${exportPricePerKwh.toFixed(3)}/kWh.`,
      `${(tariffEscalation * 100).toFixed(1)}% annual real tariff escalation.`,
      loanFraction > 0
        ? `${(loanFraction * 100).toFixed(0)}% financed at ${(loanRate * 100).toFixed(1)}% over ${loanTermYears} years.`
        : "Cash purchase, no financing.",
      `${(discountRate * 100).toFixed(1)}% discount rate over ${lifetimeYears} years.`,
    ],
    method:
      "Annual cash flow of displaced retail purchases plus export revenue, less O&M, " +
      "inverter replacement and loan payments. Excludes tax treatment.",
  };
}

/** Level annual payment that amortises a principal over a term. */
export function amortisedPayment(principal: number, rate: number, termYears: number): number {
  if (principal <= 0 || termYears <= 0) return 0;
  // A zero-interest loan is just the principal spread evenly.
  if (rate === 0) return principal / termYears;
  const factor = (1 + rate) ** termYears;
  return (principal * rate * factor) / (factor - 1);
}

/**
 * First year a running balance turns positive, interpolated within the year.
 * Returns null when it never does, which is a real and important answer.
 */
function crossoverYear(rows: YearRow[], value: (row: YearRow) => number): number | null {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as YearRow;
    if (value(row) >= 0) {
      const previous = i === 0 ? null : (rows[i - 1] as YearRow);
      const before = previous ? value(previous) : Number.NaN;
      if (previous && before < 0) {
        // Linear interpolation inside the year the sign changes.
        const fraction = -before / (value(row) - before);
        return previous.year + fraction;
      }
      return row.year;
    }
  }
  return null;
}

/**
 * Discounted payback. The rows already carry each year's discounted cash flow,
 * so this only has to accumulate them against the upfront outlay.
 */
function discountedCrossover(rows: YearRow[], upfrontCash: number): number | null {
  let cumulative = -upfrontCash;
  let previous = cumulative;
  for (const row of rows) {
    cumulative += row.discountedCashFlow;
    if (cumulative >= 0) {
      if (previous < 0) {
        const fraction = -previous / (cumulative - previous);
        return row.year - 1 + fraction;
      }
      return row.year;
    }
    previous = cumulative;
  }
  return null;
}

/**
 * Internal rate of return by bisection.
 *
 * Bisection rather than Newton's method because the cash-flow polynomial can have
 * awkward derivatives, and because a bracketed search cannot run away. Returns
 * null when no sign change exists in a plausible range, which is the correct
 * answer for a project that never pays back.
 */
export function internalRateOfReturn(flows: number[]): number | null {
  const npv = (rate: number) =>
    flows.reduce((total, flow, year) => total + flow / (1 + rate) ** year, 0);

  let low = -0.9;
  let high = 2.0;
  let npvLow = npv(low);
  // No sign change across a plausible range means no real rate of return exists.
  if (npvLow * npv(high) > 0) return null;

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid);
    if (Math.abs(npvMid) < 1e-9) return mid;
    if (npvLow * npvMid < 0) {
      high = mid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
  }
  return (low + high) / 2;
}
