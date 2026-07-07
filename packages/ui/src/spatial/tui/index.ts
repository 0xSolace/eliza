/**
 * Compatibility seam for the retired terminal adapter.
 *
 * `viewType: "tui"` remains a public contract so older payloads and future
 * reintroductions can compile, but this package no longer ships a concrete
 * alternate renderer or plugin registry.
 */

import type { ReactElement } from "react";

export interface SpatialTuiComponentOptions {
  onChange?: () => void;
}

function unsupported(): never {
  throw new Error("The terminal adapter is not shipped in this build.");
}

export function renderViewToLines(
  _view: ReactElement,
  _width?: number,
): string[] {
  unsupported();
}

export function renderSpatialToLines(
  _view: ReactElement,
  _width?: number,
): string[] {
  unsupported();
}

export function createSpatialTuiComponent(
  _render: () => ReactElement,
  _options?: SpatialTuiComponentOptions,
): never {
  unsupported();
}

export function registerSpatialTerminalView(
  _id: string,
  _render: () => ReactElement,
): never {
  unsupported();
}

export function getSpatialViewThunk(_id: string): undefined {
  return undefined;
}

export function listTerminalViewIds(): string[] {
  return [];
}

export function hasTerminalView(_id: string): boolean {
  return false;
}

export function getTerminalView(_id: string): undefined {
  return undefined;
}

export function getTerminalViewFactory(_id: string): undefined {
  return undefined;
}

export function registerTerminalView(_id: string, _factory: unknown): never {
  unsupported();
}
