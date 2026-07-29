/**
 * Screening results.
 *
 * Each entry shows severity, what was found, what to do about it, and the basis
 * for the threshold — so a professional can disagree with a specific number
 * rather than dismissing the whole feature. The standing disclaimer is always
 * present, never dismissible.
 */

import { Callout } from "@/design-system/data";
import { CheckIcon, InfoIcon, WarningIcon } from "@/design-system/icons";
import type { Nudge, NudgeSeverity } from "@/domain/siting/nudges";
import { summariseNudges } from "@/domain/siting/nudges";

const TONE: Record<NudgeSeverity, "error" | "warning" | "note"> = {
  blocking: "error",
  caution: "warning",
  note: "note",
};

const LABEL: Record<NudgeSeverity, string> = {
  blocking: "Blocking",
  caution: "Check",
  note: "Note",
};

export function NudgeList({ nudges }: { nudges: Nudge[] }) {
  if (nudges.length === 0) return null;

  const summary = summariseNudges(nudges);

  return (
    <div className="nudges">
      <div className="nudges__summary">
        {summary.verdict === "no_obstacles_found" ? (
          <CheckIcon size={13} />
        ) : summary.verdict === "not_developable" ? (
          <WarningIcon size={13} />
        ) : (
          <InfoIcon size={13} />
        )}
        {summary.blocking > 0 && <span>{summary.blocking} blocking</span>}
        {summary.caution > 0 && <span>{summary.caution} to check</span>}
        {summary.note > 0 && <span>{summary.note} notes</span>}
      </div>

      {nudges.map((nudge) => (
        <details key={nudge.id} className={`nudge nudge--${nudge.severity}`}>
          <summary>
            <span className="nudge__severity">{LABEL[nudge.severity]}</span>
            <span className="nudge__title">{nudge.title}</span>
          </summary>
          <p className="nudge__detail">{nudge.detail}</p>
          {nudge.action && <p className="nudge__action">{nudge.action}</p>}
          <p className="nudge__basis">Basis: {nudge.basis}</p>
        </details>
      ))}

      <Callout tone={TONE[summary.verdict === "not_developable" ? "blocking" : "note"]} showIcon={false}>
        {summary.disclaimer}
      </Callout>
    </div>
  );
}
