/**
 * Ambient declarations.
 */

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
