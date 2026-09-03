import { MENU } from "./data/menu.js";
import type { Menu } from "./types.js";

/**
 * Read access to the menu.
 *
 * Phase 1 serves the seed file. When the POS becomes the source of truth, a
 * PosMenuRepository implements this same interface and nothing above it changes.
 */
export interface MenuRepository {
  load(): Menu;
}

export class StaticMenuRepository implements MenuRepository {
  constructor(private readonly menu: Menu = MENU) {}

  load(): Menu {
    return this.menu;
  }
}

export const defaultMenuRepository: MenuRepository = new StaticMenuRepository();
