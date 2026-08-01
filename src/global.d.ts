/**
 * Ambient declarations.
 */

declare module "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url" {
  const workerUrl: string;
  export default workerUrl;
}

declare global {
  interface Window {
    /**
     * Mirror of the project store's dirty flag, so the browser unload guard can
     * read it without holding a store subscription.
     */
    __sundayProjectDirty?: boolean;
  }
}

export {};
