import { getColorizedSprite } from '../colorize.js';
import type {
  FloorColor,
  FurnitureInstance,
  OfficeLayout,
  PlacedFurniture,
  Seat,
  TileType as TileTypeVal,
  WorkstationKind,
} from '../types.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  Direction,
  FurnitureType,
  TILE_SIZE,
  TileType,
  WorkstationKind as Wk,
} from '../types.js';
import { getCatalogEntry } from './furnitureCatalog.js';

/** Convert flat tile array from layout into 2D grid */
export function layoutToTileMap(layout: OfficeLayout): TileTypeVal[][] {
  const map: TileTypeVal[][] = [];
  for (let r = 0; r < layout.rows; r++) {
    const row: TileTypeVal[] = [];
    for (let c = 0; c < layout.cols; c++) {
      row.push(layout.tiles[r * layout.cols + c]);
    }
    map.push(row);
  }
  return map;
}

/** Convert placed furniture into renderable FurnitureInstance[] */
export function layoutToFurnitureInstances(furniture: PlacedFurniture[]): FurnitureInstance[] {
  // Pre-compute desk zY per tile so surface items can sort in front of desks
  const deskZByTile = new Map<string, number>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || !entry.isDesk) continue;
    const deskZY = item.row * TILE_SIZE + entry.sprite.length;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        const prev = deskZByTile.get(key);
        if (prev === undefined || deskZY > prev) deskZByTile.set(key, deskZY);
      }
    }
  }

  const instances: FurnitureInstance[] = [];
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const x = item.col * TILE_SIZE;
    const y = item.row * TILE_SIZE;
    const spriteH = entry.sprite.length;
    let zY = y + spriteH;

    // Chair z-sorting: ensure characters sitting on chairs render correctly
    if (entry.category === 'chairs') {
      if (entry.orientation === 'back') {
        // Back-facing chairs render IN FRONT of the seated character
        // (the chair back visually occludes the character behind it)
        zY = (item.row + 1) * TILE_SIZE + 1;
      } else {
        // All other chairs: cap zY to first row bottom so characters
        // at any seat tile render in front of the chair
        zY = (item.row + 1) * TILE_SIZE;
      }
    }

    // Surface items render in front of the desk they sit on
    if (entry.canPlaceOnSurfaces) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`);
          if (deskZ !== undefined && deskZ + 0.5 > zY) zY = deskZ + 0.5;
        }
      }
    }

    // Colorize sprite if this furniture has a color override
    let sprite = entry.sprite;
    if (item.color) {
      const { h, s, b: bv, c: cv } = item.color;
      sprite = getColorizedSprite(
        `furn-${item.type}-${h}-${s}-${bv}-${cv}-${item.color.colorize ? 1 : 0}`,
        entry.sprite,
        item.color,
      );
    }

    instances.push({ sprite, x, y, zY });
  }
  return instances;
}

/** Get all tiles blocked by furniture footprints, optionally excluding a set of tiles.
 *  Skips top backgroundTiles rows so characters can walk through them. */
export function getBlockedTiles(
  furniture: PlacedFurniture[],
  excludeTiles?: Set<string>,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const bgRows = entry.backgroundTiles || 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue; // skip background rows — characters can walk through
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        if (excludeTiles && excludeTiles.has(key)) continue;
        tiles.add(key);
      }
    }
  }
  return tiles;
}

/** Get tiles blocked for placement purposes — skips top backgroundTiles rows per item */
export function getPlacementBlockedTiles(
  furniture: PlacedFurniture[],
  excludeUid?: string,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    if (item.uid === excludeUid) continue;
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const bgRows = entry.backgroundTiles || 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue; // skip background rows
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }
  return tiles;
}

/** Map chair orientation to character facing direction */
function orientationToFacing(orientation: string): Direction {
  switch (orientation) {
    case 'front':
      return Direction.DOWN;
    case 'back':
      return Direction.UP;
    case 'left':
      return Direction.LEFT;
    case 'right':
      return Direction.RIGHT;
    default:
      return Direction.DOWN;
  }
}

/** Map a furniture type to the workstation kind a chair facing it belongs to. */
function furnitureTypeToWorkstationKind(type: string): WorkstationKind | null {
  switch (type) {
    case FurnitureType.WHITEBOARD:
      return Wk.WHITEBOARD;
    case FurnitureType.BOOKSHELF:
      return Wk.BOOKSHELF;
    case FurnitureType.PC:
      return Wk.BROWSER;
    case FurnitureType.SERVER_RACK:
      return Wk.SERVER_RACK;
    case FurnitureType.SOFA:
      return Wk.SOFA;
    case FurnitureType.BED:
      return Wk.BED;
    case FurnitureType.COOLER:
      return Wk.SOFA; // legacy placeholder (pre-SOFA_SPRITE layouts)
    case FurnitureType.LAMP:
      return Wk.BED; // legacy placeholder (pre-BED_SPRITE layouts)
    case FurnitureType.DESK:
      return Wk.DESK;
    default:
      return null;
  }
}

/** Index all furniture tiles by type, so chair-facing lookups know which kind they hit. */
function buildFurnitureTileIndex(
  furniture: PlacedFurniture[],
): Map<string, string /* furnitureType */> {
  const index = new Map<string, string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        index.set(`${item.col + dc},${item.row + dr}`, item.type);
      }
    }
  }
  return index;
}

/** Scan up to 3 tiles along a direction from a chair; return the kind of the first furniture hit. */
function inferWorkstationKindByScan(
  col: number,
  row: number,
  facing: Direction,
  tileTypeIndex: Map<string, string>,
): WorkstationKind | null {
  const dc = facing === Direction.LEFT ? -1 : facing === Direction.RIGHT ? 1 : 0;
  const dr = facing === Direction.UP ? -1 : facing === Direction.DOWN ? 1 : 0;
  for (let step = 1; step <= 3; step++) {
    const key = `${col + dc * step},${row + dr * step}`;
    const type = tileTypeIndex.get(key);
    if (!type) continue;
    const kind = furnitureTypeToWorkstationKind(type);
    if (kind) return kind;
  }
  return null;
}

/** Generate seats from chair furniture.
 *  Facing priority: 1) chair orientation, 2) adjacent desk, 3) forward (DOWN). */
export function layoutToSeats(furniture: PlacedFurniture[]): Map<string, Seat> {
  const seats = new Map<string, Seat>();

  // Build set of all desk tiles
  const deskTiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || !entry.isDesk) continue;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        deskTiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }

  // Index all furniture tiles by type (for workstation-kind inference)
  const tileTypeIndex = buildFurnitureTileIndex(furniture);

  // Tile -> workstation kind (pre-computed for fast facing inference).
  const workstationTiles = new Set<string>();
  for (const [key, type] of tileTypeIndex) {
    if (furnitureTypeToWorkstationKind(type)) workstationTiles.add(key);
  }

  const dirs: Array<{ dc: number; dr: number; facing: Direction }> = [
    { dc: 0, dr: -1, facing: Direction.UP }, // desk is above chair → face UP
    { dc: 0, dr: 1, facing: Direction.DOWN }, // desk is below chair → face DOWN
    { dc: -1, dr: 0, facing: Direction.LEFT }, // desk is left of chair → face LEFT
    { dc: 1, dr: 0, facing: Direction.RIGHT }, // desk is right of chair → face RIGHT
  ];

  // For each chair, every footprint tile becomes a seat.
  // Multi-tile chairs (e.g. 2-tile couches) produce multiple seats.
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || entry.category !== 'chairs') continue;

    let seatCount = 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc;
        const tileRow = item.row + dr;

        // Determine facing direction:
        // 1) Chair orientation takes priority
        // 2) Adjacent desk direction
        // 3) Any adjacent workstation-bearing furniture (whiteboard/bookshelf/pc/cooler/lamp)
        // 4) Default forward (DOWN)
        let facingDir: Direction = Direction.DOWN;
        if (entry.orientation) {
          facingDir = orientationToFacing(entry.orientation);
        } else {
          let matched = false;
          for (const d of dirs) {
            if (deskTiles.has(`${tileCol + d.dc},${tileRow + d.dr}`)) {
              facingDir = d.facing;
              matched = true;
              break;
            }
          }
          if (!matched) {
            // Look up to 3 tiles away in each cardinal direction for
            // any non-desk workstation (whiteboard/bookshelf/pc/cooler/lamp).
            outer: for (let step = 1; step <= 3; step++) {
              for (const d of dirs) {
                if (workstationTiles.has(`${tileCol + d.dc * step},${tileRow + d.dr * step}`)) {
                  facingDir = d.facing;
                  break outer;
                }
              }
            }
          }
        }

        // First seat uses chair uid (backward compat), subsequent use uid:N
        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`;
        // Infer workstation kind from what the chair is facing
        const workstationKind =
          inferWorkstationKindByScan(tileCol, tileRow, facingDir, tileTypeIndex) ?? Wk.DESK;
        seats.set(seatUid, {
          uid: seatUid,
          seatCol: tileCol,
          seatRow: tileRow,
          facingDir,
          assigned: false,
          workstationKind,
        });
        seatCount++;
      }
    }
  }

  return seats;
}

/** Get the set of tiles occupied by seats (so they can be excluded from blocked tiles) */
export function getSeatTiles(seats: Map<string, Seat>): Set<string> {
  const tiles = new Set<string>();
  for (const seat of seats.values()) {
    tiles.add(`${seat.seatCol},${seat.seatRow}`);
  }
  return tiles;
}

/** Default floor colors for the two rooms */
const DEFAULT_LEFT_ROOM_COLOR: FloorColor = { h: 35, s: 30, b: 15, c: 0 }; // warm beige
const DEFAULT_RIGHT_ROOM_COLOR: FloorColor = { h: 25, s: 45, b: 5, c: 10 }; // warm brown
const DEFAULT_CARPET_COLOR: FloorColor = { h: 280, s: 40, b: -5, c: 0 }; // purple
const DEFAULT_DOORWAY_COLOR: FloorColor = { h: 35, s: 25, b: 10, c: 0 }; // tan

/** Create the default office layout matching the current hardcoded office */
export function createDefaultLayout(): OfficeLayout {
  const W = TileType.WALL;
  const F1 = TileType.FLOOR_1;
  const F2 = TileType.FLOOR_2;
  const F3 = TileType.FLOOR_3;
  const F4 = TileType.FLOOR_4;

  const tiles: TileTypeVal[] = [];
  const tileColors: Array<FloorColor | null> = [];

  for (let r = 0; r < DEFAULT_ROWS; r++) {
    for (let c = 0; c < DEFAULT_COLS; c++) {
      if (r === 0 || r === DEFAULT_ROWS - 1) {
        tiles.push(W);
        tileColors.push(null);
        continue;
      }
      if (c === 0 || c === DEFAULT_COLS - 1) {
        tiles.push(W);
        tileColors.push(null);
        continue;
      }
      if (c === 10) {
        if (r >= 4 && r <= 6) {
          tiles.push(F4);
          tileColors.push(DEFAULT_DOORWAY_COLOR);
        } else {
          tiles.push(W);
          tileColors.push(null);
        }
        continue;
      }
      if (c >= 15 && c <= 18 && r >= 7 && r <= 9) {
        tiles.push(F3);
        tileColors.push(DEFAULT_CARPET_COLOR);
        continue;
      }
      if (c < 10) {
        tiles.push(F1);
        tileColors.push(DEFAULT_LEFT_ROOM_COLOR);
      } else {
        tiles.push(F2);
        tileColors.push(DEFAULT_RIGHT_ROOM_COLOR);
      }
    }
  }

  // Default layout split into:
  //   Left room  (c 1-9)   = WORKROOM   (desk / whiteboard / bookshelf / pc / server_rack)
  //   Right room (c 11-18) = LOUNGE     (sofa / bed)
  const furniture: PlacedFurniture[] = [
    // Workroom — left
    { uid: 'desk-left', type: FurnitureType.DESK, col: 4, row: 3 },
    { uid: 'whiteboard-1', type: FurnitureType.WHITEBOARD, col: 4, row: 0 },
    { uid: 'bookshelf-1', type: FurnitureType.BOOKSHELF, col: 1, row: 5 },
    { uid: 'pc-1', type: FurnitureType.PC, col: 7, row: 6 },
    { uid: 'server-rack-1', type: FurnitureType.SERVER_RACK, col: 9, row: 5 },
    { uid: 'plant-left', type: FurnitureType.PLANT, col: 1, row: 1 },
    // Workroom chairs — tagged by the nearest workstation they face
    { uid: 'chair-whiteboard', type: FurnitureType.CHAIR, col: 5, row: 1 }, // face UP → whiteboard (THINKING)
    { uid: 'chair-desk-left', type: FurnitureType.CHAIR, col: 3, row: 4 }, // face RIGHT → desk (CODING)
    { uid: 'chair-desk-right', type: FurnitureType.CHAIR, col: 6, row: 3 }, // face LEFT → desk (CODING)
    { uid: 'chair-shelf', type: FurnitureType.CHAIR, col: 2, row: 5 }, // face LEFT → bookshelf (MEMORY)
    { uid: 'chair-pc', type: FurnitureType.CHAIR, col: 7, row: 8 }, // face UP → pc (BROWSING)
    { uid: 'chair-server', type: FurnitureType.CHAIR, col: 9, row: 8 }, // face UP → server_rack (EXECUTING)

    // Lounge — right
    { uid: 'sofa-1', type: FurnitureType.SOFA, col: 15, row: 7 }, // 2×1: covers (15,7)(16,7)
    { uid: 'bed-1', type: FurnitureType.BED, col: 12, row: 4 }, // 2×2: covers (12-13, 4-5)
    { uid: 'plant-right', type: FurnitureType.PLANT, col: 18, row: 1 },
    { uid: 'chair-sofa-1', type: FurnitureType.CHAIR, col: 15, row: 8 }, // face UP → sofa (RESTING)
    { uid: 'chair-sofa-2', type: FurnitureType.CHAIR, col: 16, row: 8 }, // face UP → sofa (RESTING)
    { uid: 'chair-bed', type: FurnitureType.CHAIR, col: 14, row: 4 }, // face LEFT → bed (SLEEPING)
  ];

  return { version: 1, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, tiles, tileColors, furniture };
}

/** Serialize layout to JSON string */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout);
}

/** Deserialize layout from JSON string, migrating old tile types if needed */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    const obj = JSON.parse(json);
    if (obj && obj.version === 1 && Array.isArray(obj.tiles) && Array.isArray(obj.furniture)) {
      return migrateLayout(obj as OfficeLayout);
    }
  } catch {
    /* ignore parse errors */
  }
  return null;
}

/**
 * Ensure layout has tileColors. If missing, generate defaults based on tile types.
 * Exported for use by message handlers that receive layouts over the wire.
 */
export function migrateLayoutColors(layout: OfficeLayout): OfficeLayout {
  return migrateLayout(layout);
}

/**
 * Migrate old layouts that use legacy tile types (TILE_FLOOR=1, WOOD_FLOOR=2, CARPET=3, DOORWAY=4)
 * to the new pattern-based system. If tileColors is already present, no migration needed.
 */
function migrateLayout(layout: OfficeLayout): OfficeLayout {
  if (layout.tileColors && layout.tileColors.length === layout.tiles.length) {
    return layout; // Already migrated
  }

  // Check if any tiles use old values (1-4) — these map directly to FLOOR_1-4
  // but need color assignments
  const tileColors: Array<FloorColor | null> = [];
  for (const tile of layout.tiles) {
    switch (tile) {
      case 0: // WALL
        tileColors.push(null);
        break;
      case 1: // was TILE_FLOOR → FLOOR_1 beige
        tileColors.push(DEFAULT_LEFT_ROOM_COLOR);
        break;
      case 2: // was WOOD_FLOOR → FLOOR_2 brown
        tileColors.push(DEFAULT_RIGHT_ROOM_COLOR);
        break;
      case 3: // was CARPET → FLOOR_3 purple
        tileColors.push(DEFAULT_CARPET_COLOR);
        break;
      case 4: // was DOORWAY → FLOOR_4 tan
        tileColors.push(DEFAULT_DOORWAY_COLOR);
        break;
      default:
        // New tile types (5-7) without colors — use neutral gray
        tileColors.push(tile > 0 ? { h: 0, s: 0, b: 0, c: 0 } : null);
    }
  }

  return { ...layout, tileColors };
}
