/**
 * Monthly irradiation profile, one line per source.
 */

import type { ResourceReport } from "@/services/solar/types";
import { MonthlySeriesChart } from "./MonthlySeriesChart";

export function MonthlyChart({ reports }: { reports: ResourceReport[] }) {
  return (
    <MonthlySeriesChart
      title="Monthly irradiation"
      ariaLabel="Monthly global horizontal irradiation by source"
      unitLabel="Monthly global horizontal irradiation, kWh/m² per month."
      reports={reports}
      select={(report) => report.monthlyGhi}
      valueDigits={0}
    />
  );
}
