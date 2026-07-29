import { describe, expect, it } from "vitest";
import {
  amortisedPayment,
  COST_DEFAULTS,
  computeLcoe,
  computeOwnerCashFlow,
  internalRateOfReturn,
} from "./cashflow";

describe("loan amortisation", () => {
  it("matches the standard annuity formula", () => {
    // 100,000 at 6% over 10 years: 13,586.80 a year.
    expect(amortisedPayment(100_000, 0.06, 10)).toBeCloseTo(13_586.8, 1);
  });

  it("spreads a zero-interest loan evenly", () => {
    expect(amortisedPayment(120_000, 0, 10)).toBe(12_000);
  });

  it("pays nothing on no principal", () => {
    expect(amortisedPayment(0, 0.06, 10)).toBe(0);
  });

  it("costs more per year over a shorter term", () => {
    expect(amortisedPayment(100_000, 0.06, 5)).toBeGreaterThan(
      amortisedPayment(100_000, 0.06, 20),
    );
  });

  it("costs more in total at a higher rate", () => {
    expect(amortisedPayment(100_000, 0.1, 10)).toBeGreaterThan(
      amortisedPayment(100_000, 0.03, 10),
    );
  });
});

describe("internal rate of return", () => {
  it("recovers a known rate", () => {
    // -1000 now, 1100 in a year, is exactly 10%.
    const irr = internalRateOfReturn([-1000, 1100]);
    expect(irr).toBeCloseTo(0.1, 6);
  });

  it("recovers the rate of a level annuity", () => {
    // -1000 followed by five payments of 250 is close to 7.93%.
    const irr = internalRateOfReturn([-1000, 250, 250, 250, 250, 250]);
    expect(irr).toBeCloseTo(0.0793, 3);
  });

  it("is zero when the money simply comes back", () => {
    expect(internalRateOfReturn([-1000, 500, 500])).toBeCloseTo(0, 6);
  });

  it("returns null when a project never pays back", () => {
    // Every flow negative: no rate makes the present value zero.
    expect(internalRateOfReturn([-1000, -100, -100])).toBeNull();
  });
});

describe("levelised cost of energy", () => {
  const utility = {
    capacityKwDc: 100_000,
    annualKwh: 190_000_000,
    costs: COST_DEFAULTS.utility,
  };

  it("produces a cost per kWh in the range utility projects report", () => {
    const result = computeLcoe(utility);
    // US utility PV LCOE sits around 3-6 cents/kWh at these assumptions.
    expect(result.lcoePerKwh).toBeGreaterThan(0.02);
    expect(result.lcoePerKwh).toBeLessThan(0.09);
  });

  it("discounts energy as well as cost", () => {
    const result = computeLcoe(utility);
    // Undiscounted lifetime energy would be about 4.5 billion kWh; discounting
    // must bring it well below that, or the denominator is wrong.
    expect(result.totalDiscountedEnergyKwh).toBeLessThan(190_000_000 * 25 * 0.8);
    expect(result.totalDiscountedEnergyKwh).toBeGreaterThan(190_000_000 * 10);
  });

  it("rises with the discount rate", () => {
    const cheap = computeLcoe({ ...utility, discountRate: 0.03 });
    const dear = computeLcoe({ ...utility, discountRate: 0.1 });
    expect(dear.lcoePerKwh).toBeGreaterThan(cheap.lcoePerKwh);
  });

  it("falls when incentives reduce net capex", () => {
    const unsubsidised = computeLcoe(utility);
    const subsidised = computeLcoe({ ...utility, incentiveFraction: 0.3 });
    expect(subsidised.lcoePerKwh).toBeLessThan(unsubsidised.lcoePerKwh);
    expect(subsidised.netCapex).toBeCloseTo(unsubsidised.grossCapex * 0.7, 6);
  });

  it("falls at a sunnier site with the same cost", () => {
    const sunny = computeLcoe({ ...utility, annualKwh: 220_000_000 });
    const dull = computeLcoe({ ...utility, annualKwh: 120_000_000 });
    expect(sunny.lcoePerKwh).toBeLessThan(dull.lcoePerKwh);
  });

  it("rises with faster degradation", () => {
    const durable = computeLcoe({ ...utility, degradationRate: 0.002 });
    const declining = computeLcoe({ ...utility, degradationRate: 0.01 });
    expect(declining.lcoePerKwh).toBeGreaterThan(durable.lcoePerKwh);
  });

  it("costs more per kWh for a rooftop than a utility plant", () => {
    const rooftop = computeLcoe({
      capacityKwDc: 8,
      annualKwh: 11_000,
      costs: COST_DEFAULTS.residential,
    });
    expect(rooftop.lcoePerKwh).toBeGreaterThan(computeLcoe(utility).lcoePerKwh);
  });

  it("is infinite rather than zero when there is no energy", () => {
    const result = computeLcoe({ ...utility, annualKwh: 0 });
    expect(result.lcoePerKwh).toBe(Number.POSITIVE_INFINITY);
  });

  it("lists every assumption it used", () => {
    const result = computeLcoe({ ...utility, incentiveFraction: 0.3 });
    const assumptions = result.assumptions.join(" ");
    expect(assumptions).toContain("Capex");
    expect(assumptions).toContain("discount rate");
    expect(assumptions).toContain("degradation");
    expect(assumptions).toContain("Incentives");
    expect(result.method).toContain("discounted lifetime cost");
  });
});

describe("owner cash flow", () => {
  const rooftop = {
    capacityKwDc: 8,
    annualKwh: 11_000,
    costs: COST_DEFAULTS.residential,
    tariffPerKwh: 0.28,
    selfConsumptionFraction: 0.5,
    exportPricePerKwh: 0.06,
    incentiveFraction: 0.3,
  };

  it("pays back a well-sited residential system within its life", () => {
    const result = computeOwnerCashFlow(rooftop);
    expect(result.simplePaybackYears).not.toBeNull();
    expect(result.simplePaybackYears as number).toBeGreaterThan(3);
    expect(result.simplePaybackYears as number).toBeLessThan(25);
  });

  it("takes longer to pay back on a discounted basis", () => {
    const result = computeOwnerCashFlow(rooftop);
    expect(result.discountedPaybackYears).not.toBeNull();
    expect(result.discountedPaybackYears as number).toBeGreaterThan(
      result.simplePaybackYears as number,
    );
  });

  it("values exported energy at the export price, not the retail tariff", () => {
    const mostlySelfUsed = computeOwnerCashFlow({ ...rooftop, selfConsumptionFraction: 0.9 });
    const mostlyExported = computeOwnerCashFlow({ ...rooftop, selfConsumptionFraction: 0.1 });
    // This is the distinction that decides whether rooftop payback is honest.
    expect(mostlySelfUsed.lifetimeSavings).toBeGreaterThan(mostlyExported.lifetimeSavings);
    expect(mostlySelfUsed.netPresentValue).toBeGreaterThan(mostlyExported.netPresentValue);
  });

  it("never pays back when the tariff is worthless", () => {
    const result = computeOwnerCashFlow({
      ...rooftop,
      tariffPerKwh: 0.005,
      exportPricePerKwh: 0,
    });
    expect(result.simplePaybackYears).toBeNull();
    expect(result.netPresentValue).toBeLessThan(0);
  });

  it("reduces the upfront cash when a loan is taken", () => {
    const cash = computeOwnerCashFlow(rooftop);
    const financed = computeOwnerCashFlow({ ...rooftop, loanFraction: 0.8, loanRate: 0.06 });
    expect(financed.upfrontCash).toBeCloseTo(cash.netCapex * 0.2, 6);
    expect(financed.annualLoanPayment).toBeGreaterThan(0);
    // Interest makes the total worse even though day one is easier.
    expect(financed.lifetimeSavings).toBeLessThan(cash.lifetimeSavings);
  });

  it("charges the loan only during its term", () => {
    const result = computeOwnerCashFlow({ ...rooftop, loanFraction: 1, loanTermYears: 10 });
    const duringLoan = result.rows.find((row) => row.year === 10);
    const afterLoan = result.rows.find((row) => row.year === 11);
    expect(afterLoan?.netCashFlow).toBeGreaterThan(duringLoan?.netCashFlow as number);
  });

  it("charges the inverter replacement exactly once", () => {
    const result = computeOwnerCashFlow({ ...rooftop, loanFraction: 0 });
    const replacementYear = COST_DEFAULTS.residential.inverterReplacementYear;
    const atReplacement = result.rows.find((row) => row.year === replacementYear);
    const yearBefore = result.rows.find((row) => row.year === replacementYear - 1);
    const yearAfter = result.rows.find((row) => row.year === replacementYear + 1);
    expect(atReplacement?.netCashFlow).toBeLessThan(yearBefore?.netCashFlow as number);
    expect(yearAfter?.netCashFlow).toBeGreaterThan(atReplacement?.netCashFlow as number);
  });

  it("declines output year on year", () => {
    const result = computeOwnerCashFlow(rooftop);
    const first = result.rows[0];
    const last = result.rows[result.rows.length - 1];
    expect(last?.energyKwh).toBeLessThan(first?.energyKwh as number);
    // 0.5% a year over 25 years leaves about 89%.
    expect((last?.energyKwh as number) / (first?.energyKwh as number)).toBeCloseTo(0.888, 2);
  });

  it("keeps the cumulative balance internally consistent", () => {
    const result = computeOwnerCashFlow(rooftop);
    let running = -result.upfrontCash;
    for (const row of result.rows) {
      running += row.netCashFlow;
      expect(row.cumulativeCashFlow).toBeCloseTo(running, 6);
    }
    expect(result.lifetimeSavings).toBeCloseTo(running, 6);
  });

  it("computes a positive return for an attractive project", () => {
    const result = computeOwnerCashFlow(rooftop);
    expect(result.internalRateOfReturn).not.toBeNull();
    expect(result.internalRateOfReturn as number).toBeGreaterThan(0);
  });

  it("states its assumptions and excludes tax explicitly", () => {
    const result = computeOwnerCashFlow({ ...rooftop, loanFraction: 0.5 });
    const assumptions = result.assumptions.join(" ");
    expect(assumptions).toContain("self-consumed");
    expect(assumptions).toContain("financed");
    expect(result.method).toContain("Excludes tax");
  });
});
