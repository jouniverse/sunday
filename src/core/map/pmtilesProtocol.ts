/**
 * Register the pmtiles: protocol once before any Map is constructed.
 * Used for local WDPA (and later land) vector tiles via convertFileSrc.
 */

import { addProtocol } from "maplibre-gl";
import { Protocol } from "pmtiles";

let registered = false;

export function ensurePmtilesProtocol(): void {
  if (registered) return;
  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
  registered = true;
}
