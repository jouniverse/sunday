/**
 * Far-field horizon helpers — pure interpolation against a DEM-derived profile.
 *
 * The profile itself is computed in Rust from Terrarium tiles. This module
 * answers “what is the maskangle at this azimuth?” so the Report chart and
 * tests stay deterministic.
 */

export interface HorizonSample {
  /** Degrees from north, clockwise, 0–360. Same convention as pvlib azimuth. */
  azimuth: number;
  /** Terrain elevation angle as seen from the observer, degrees. */
  elevationDegrees: number;
}

export interface HorizonProfile {
  samples: HorizonSample[];
  observerElevationM?: number | null;
  radiusM: number;
  method: string;
}

/** IANA zone for `round(lon/15)` hours from UTC.

 * pvlib Location uses zoneinfo, which rejects ISO offsets (`-08:00`).
 * `Etc/GMT±N` uses POSIX-inverted signs: Etc/GMT+8 is UTC−8.
 */
export function solarTimezoneFromLongitude(longitude: number): string {
  const hours = Math.max(-12, Math.min(14, Math.round(longitude / 15)));
  if (hours === 0) return "UTC";
  const posix = -hours;
  const sign = posix >= 0 ? "+" : "-";
  return `Etc/GMT${sign}${Math.abs(posix)}`;
}

/**
 * High-sun / low-sun labels follow the site hemisphere, not the calendar name
 * the sidecar uses (June is winter in the south).
 */
export function sunPathTraceKind(
  isoDate: string,
  latitude: number,
): "high" | "equinox" | "low" {
  const month = Number(isoDate.slice(5, 7));
  if (month === 3 || month === 9) return "equinox";
  const juneIsHigh = latitude >= 0;
  if (month === 6) return juneIsHigh ? "high" : "low";
  if (month === 12) return juneIsHigh ? "low" : "high";
  return "equinox";
}

export function interpolateHorizonElevation(
  samples: HorizonSample[],
  azimuth: number,
): number | null {
  if (samples.length === 0) return null;
  if (samples.length === 1) return samples[0]!.elevationDegrees;
  const ordered = [...samples].sort((a, b) => a.azimuth - b.azimuth);
  const az = ((azimuth % 360) + 360) % 360;
  let hi = ordered.findIndex((sample) => sample.azimuth >= az);
  let loAz: number;
  let hiAz: number;
  let loEl: number;
  let hiEl: number;
  if (hi === -1) {
    const last = ordered[ordered.length - 1]!;
    const first = ordered[0]!;
    loAz = last.azimuth;
    hiAz = first.azimuth + 360;
    loEl = last.elevationDegrees;
    hiEl = first.elevationDegrees;
  } else if (hi === 0) {
    const last = ordered[ordered.length - 1]!;
    const first = ordered[0]!;
    loAz = last.azimuth - 360;
    hiAz = first.azimuth;
    loEl = last.elevationDegrees;
    hiEl = first.elevationDegrees;
  } else {
    const lo = ordered[hi - 1]!;
    const hiSample = ordered[hi]!;
    loAz = lo.azimuth;
    hiAz = hiSample.azimuth;
    loEl = lo.elevationDegrees;
    hiEl = hiSample.elevationDegrees;
  }
  const span = hiAz - loAz;
  if (span <= 0) return hiEl;
  const t = (az - loAz) / span;
  return loEl + t * (hiEl - loEl);
}

export function sunBlockedByHorizon(sunElevation: number, horizonElevation: number): boolean {
  return sunElevation < horizonElevation;
}
