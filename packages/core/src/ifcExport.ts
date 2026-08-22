// IFC4 SPF export — specs.md §6.4 (FR-16 client-side, Phase 3 row) and §9's "IFC subset
// export": IfcProject -> IfcSite -> IfcBuilding -> IfcBuildingStorey, IfcWallStandardCase,
// IfcSpace, IfcDoor, IfcWindow. Pure string generation, no dependencies (ARC-2).
//
// Scope, stated plainly: walls and rooms get real extruded-solid geometry. Openings get
// proper IfcOpeningElement + IfcRelVoidsElement/IfcRelFillsElement relationships (so a
// viewer's schedule and topology are correct) but IfcDoor/IfcWindow themselves carry no
// geometry of their own (Representation = $) — a real leaf/sash model was judged not
// worth the added risk of a hand-written subset exporter guessing at more IFC4 entity
// attribute orders from memory. This file has not been machine-verified against the IFC4
// EXPRESS schema; treat golden-test passage as "well-formed STEP", not "valid IFC" until
// it has actually been opened in IfcOpenShell/BlenderBIM, FreeCAD, and a web viewer (see
// README's manual smoke-test note, the same discipline as the DXF exporter's).
//
// Two conventions carried through every wall/space/opening:
//   * A local placement's Location is the geometry's centre, and its RefDirection points
//     along the wall run — this is what lets IfcRectangleProfileDef (centred on its own
//     origin) reproduce DM-5's centerline+thickness model without any offset math.
//   * Every length is millimetres (DM-4), declared via IfcSIUnit(MILLI, METRE).

import { activeLevel } from "./patch.js";
import { openingSpansOnRun, polygonFromBoundary, wallRuns, type WallRun } from "./wallGraph.js";
import type { Opening, PlanDocument } from "./types.js";

export type IfcExportOptions = {
  now?: Date;
  author?: string;
  organization?: string;
  /** Export every level (default) or just the active one. */
  allLevels?: boolean;
};

const IFC_GUID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/**
 * A deterministic 22-character IFC-alphabet GUID from a stable string key, so re-exporting
 * the same document produces byte-identical ids (golden-testable) — not an RFC-4122 UUID,
 * just syntactically what IfcGloballyUniqueId expects. Four independent 32-bit FNV-1a
 * passes give ~128 bits of spread, which is what an IFC GUID actually encodes.
 */
function ifcGuid(seed: string): string {
  let out = "";
  for (let round = 0; round < 4; round++) {
    let h = (0x811c9dc5 ^ round) >>> 0;
    const s = `${seed}#${round}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    for (let i = 0; i < 6; i++) {
      out += IFC_GUID_CHARS[h % 64];
      h = Math.floor(h / 64);
    }
  }
  return out.slice(0, 22);
}

function stepString(s: string): string {
  return `'${s.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`;
}
function stepEnum(e: string): string {
  return `.${e}.`;
}
/** IFC reals must carry a decimal point, or a STEP parser reads them as INTEGER. */
function stepReal(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return Number.isInteger(r) ? `${r}.` : String(r);
}
function stepList(items: Array<string | number>): string {
  return `(${items.join(",")})`;
}
const $ = "$";

class Ref {
  constructor(public readonly id: number) {}
  toString(): string {
    return `#${this.id}`;
  }
}
function isRef(v: unknown): v is Ref {
  return v instanceof Ref;
}

type Attr = string | number | Ref | Attr[];

class StepWriter {
  private lines: string[] = [];
  private seq = 0;

  private render(attr: Attr): string {
    if (isRef(attr)) return attr.toString();
    if (Array.isArray(attr)) return stepList(attr.map((a) => this.render(a)));
    return String(attr);
  }

  entity(type: string, attrs: Attr[]): Ref {
    const id = ++this.seq;
    this.lines.push(`#${id}=${type}(${attrs.map((a) => this.render(a)).join(",")});`);
    return new Ref(id);
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

/** IfcAxis2Placement3D + IfcCartesianPoint, optionally relative to a parent IfcLocalPlacement. */
function localPlacement(
  w: StepWriter,
  relTo: Ref | null,
  x: number,
  y: number,
  z: number,
  refDirection?: [number, number, number],
): Ref {
  const point = w.entity("IFCCARTESIANPOINT", [[stepReal(x), stepReal(y), stepReal(z)]]);
  const axis = w.entity("IFCAXIS2PLACEMENT3D", [
    point,
    $,
    refDirection ? w.entity("IFCDIRECTION", [[stepReal(refDirection[0]), stepReal(refDirection[1]), stepReal(refDirection[2])]]) : $,
  ]);
  return w.entity("IFCLOCALPLACEMENT", [relTo ?? $, axis]);
}

/** A rectangle centred on its own placement origin, extruded along local Z — a wall
 * segment, or an opening void, depending on the caller. */
function extrudedBox(
  w: StepWriter,
  context: Ref,
  relTo: Ref,
  centre: { x: number; y: number; z: number },
  refDirection: [number, number, number],
  lengthMm: number,
  thicknessMm: number,
  heightMm: number,
): { placement: Ref; shape: Ref } {
  const placement = localPlacement(w, relTo, centre.x, centre.y, centre.z, refDirection);
  const profilePos = w.entity("IFCAXIS2PLACEMENT2D", [w.entity("IFCCARTESIANPOINT", [[stepReal(0), stepReal(0)]]), $]);
  const profile = w.entity("IFCRECTANGLEPROFILEDEF", [stepEnum("AREA"), $, profilePos, stepReal(lengthMm), stepReal(thicknessMm)]);
  const extrudeDir = w.entity("IFCDIRECTION", [[stepReal(0), stepReal(0), stepReal(1)]]);
  const solid = w.entity("IFCEXTRUDEDAREASOLID", [profile, $, extrudeDir, stepReal(heightMm)]);
  const shapeRep = w.entity("IFCSHAPEREPRESENTATION", [context, stepString("Body"), stepString("SweptSolid"), [solid]]);
  const shape = w.entity("IFCPRODUCTDEFINITIONSHAPE", [$, $, [shapeRep]]);
  return { placement, shape };
}

function runDirection(run: WallRun): [number, number, number] {
  return run.axis === "h" ? [1, 0, 0] : [0, 1, 0];
}

export function exportIfc(doc: PlanDocument, options: IfcExportOptions = {}): string {
  const now = options.now ?? new Date();
  const author = options.author ?? "Floorcraft User";
  const organization = options.organization ?? "Floorcraft";
  const levels = options.allLevels === false ? [activeLevel(doc)] : doc.levels;

  const w = new StepWriter();

  // ---------------------------------------------------------------- owner history
  const person = w.entity("IFCPERSON", [$, stepString(author), $, $, $, $, $, $]);
  const org = w.entity("IFCORGANIZATION", [$, stepString(organization), $, $, $]);
  const personOrg = w.entity("IFCPERSONANDORGANIZATION", [person, org, $]);
  const application = w.entity("IFCAPPLICATION", [org, stepString("0.1"), stepString("Floorcraft"), stepString("floorcraft")]);
  const ownerHistory = w.entity("IFCOWNERHISTORY", [
    personOrg,
    application,
    $,
    stepEnum("ADDED"),
    $,
    $,
    $,
    String(Math.floor(now.getTime() / 1000)),
  ]);

  // ---------------------------------------------------------------------- units
  const lengthUnit = w.entity("IFCSIUNIT", [$, stepEnum("LENGTHUNIT"), stepEnum("MILLI"), stepEnum("METRE")]);
  const areaUnit = w.entity("IFCSIUNIT", [$, stepEnum("AREAUNIT"), $, stepEnum("SQUARE_METRE")]);
  const volumeUnit = w.entity("IFCSIUNIT", [$, stepEnum("VOLUMEUNIT"), $, stepEnum("CUBIC_METRE")]);
  const angleUnit = w.entity("IFCSIUNIT", [$, stepEnum("PLANEANGLEUNIT"), $, stepEnum("RADIAN")]);
  const unitAssignment = w.entity("IFCUNITASSIGNMENT", [[lengthUnit, areaUnit, volumeUnit, angleUnit]]);

  // ------------------------------------------------------------- world + project
  const worldPlacement = w.entity("IFCAXIS2PLACEMENT3D", [w.entity("IFCCARTESIANPOINT", [[stepReal(0), stepReal(0), stepReal(0)]]), $, $]);
  const context = w.entity("IFCGEOMETRICREPRESENTATIONCONTEXT", [$, stepString("Model"), 3, stepReal(0.00001), worldPlacement, $]);
  const project = w.entity("IFCPROJECT", [
    stepString(ifcGuid(`${doc.id}:project`)),
    ownerHistory,
    stepString(doc.title || "Floorcraft Plan"),
    $,
    $,
    $,
    $,
    [context],
    unitAssignment,
  ]);

  // ------------------------------------------------------- site / building / storeys
  const sitePlacement = localPlacement(w, null, 0, 0, 0);
  const site = w.entity("IFCSITE", [
    stepString(ifcGuid(`${doc.id}:site`)),
    ownerHistory,
    stepString("Site"),
    $,
    $,
    sitePlacement,
    $,
    $,
    stepEnum("ELEMENT"),
    $,
    $,
    $,
    $,
    $,
  ]);
  const buildingPlacement = localPlacement(w, sitePlacement, 0, 0, 0);
  const building = w.entity("IFCBUILDING", [
    stepString(ifcGuid(`${doc.id}:building`)),
    ownerHistory,
    stepString(doc.title || "Floorcraft Building"),
    $,
    $,
    buildingPlacement,
    $,
    $,
    stepEnum("ELEMENT"),
    $,
    $,
    $,
  ]);
  w.entity("IFCRELAGGREGATES", [stepString(ifcGuid(`${doc.id}:agg-project`)), ownerHistory, $, $, project, [site]]);
  w.entity("IFCRELAGGREGATES", [stepString(ifcGuid(`${doc.id}:agg-site`)), ownerHistory, $, $, site, [building]]);

  const storeyByLevelId = new Map<string, Ref>();
  const storeyPlacementByLevelId = new Map<string, Ref>();
  for (const level of levels) {
    const placement = localPlacement(w, buildingPlacement, 0, 0, level.elevation);
    const storey = w.entity("IFCBUILDINGSTOREY", [
      stepString(ifcGuid(`${doc.id}:${level.id}`)),
      ownerHistory,
      stepString(level.name),
      $,
      $,
      placement,
      $,
      $,
      stepEnum("ELEMENT"),
      stepReal(level.elevation),
    ]);
    storeyByLevelId.set(level.id, storey);
    storeyPlacementByLevelId.set(level.id, placement);
  }
  w.entity("IFCRELAGGREGATES", [
    stepString(ifcGuid(`${doc.id}:agg-building`)),
    ownerHistory,
    $,
    $,
    building,
    levels.map((l) => storeyByLevelId.get(l.id)!),
  ]);

  // ------------------------------------------------------------------ per level
  for (const level of levels) {
    const storey = storeyByLevelId.get(level.id)!;
    const storeyPlacement = storeyPlacementByLevelId.get(level.id)!;
    const containedIds: Ref[] = [];

    for (const run of wallRuns(level.graph)) {
      const thickness = level.graph.edges[run.edgeIds[0]!]?.thickness ?? 114;
      const centreAlong = (run.from + run.to) / 2;
      const centre =
        run.axis === "h" ? { x: centreAlong, y: run.coord, z: 0 } : { x: run.coord, y: centreAlong, z: 0 };
      const { placement, shape } = extrudedBox(
        w,
        context,
        storeyPlacement,
        centre,
        runDirection(run),
        run.to - run.from,
        thickness,
        level.floorToCeiling,
      );
      const wall = w.entity("IFCWALLSTANDARDCASE", [
        stepString(ifcGuid(`${doc.id}:${level.id}:wall:${run.edgeIds[0]}`)),
        ownerHistory,
        $,
        $,
        $,
        placement,
        shape,
        $,
      ]);
      containedIds.push(wall);

      // Openings on this run become IfcOpeningElement voids in the wall, filled by an
      // IfcDoor/IfcWindow with no geometry of its own (see file header).
      for (const { span, opening } of openingSpansOnRun(level.graph, run)) {
        const openingCentreAlong = (span.from + span.to) / 2;
        const openingCentre =
          run.axis === "h" ? { x: openingCentreAlong, y: run.coord, z: opening.sill ?? 0 } : { x: run.coord, y: openingCentreAlong, z: opening.sill ?? 0 };
        const openingGeom = extrudedBox(
          w,
          context,
          storeyPlacement,
          openingCentre,
          runDirection(run),
          opening.width,
          thickness,
          opening.height,
        );
        const openingElement = w.entity("IFCOPENINGELEMENT", [
          stepString(ifcGuid(`${doc.id}:${level.id}:opening:${opening.id}`)),
          ownerHistory,
          $,
          $,
          $,
          openingGeom.placement,
          openingGeom.shape,
          $,
        ]);
        w.entity("IFCRELVOIDSELEMENT", [
          stepString(ifcGuid(`${doc.id}:void:${opening.id}`)),
          ownerHistory,
          $,
          $,
          wall,
          openingElement,
        ]);
        const filler = fillerEntity(w, opening, ownerHistory, ifcGuid(`${doc.id}:fill:${opening.id}`));
        if (filler) {
          w.entity("IFCRELFILLSELEMENT", [stepString(ifcGuid(`${doc.id}:rel-fill:${opening.id}`)), ownerHistory, $, $, openingElement, filler]);
        }
      }
    }

    for (const [roomId, room] of Object.entries(level.graph.rooms)) {
      const pts = polygonFromBoundary(level.graph, room.boundary);
      if (pts.length < 3) continue;
      const cartesian = pts.map((p) => w.entity("IFCCARTESIANPOINT", [[stepReal(p.x), stepReal(p.y)]]));
      cartesian.push(cartesian[0]!); // IfcPolyline used as a profile boundary must close.
      const polyline = w.entity("IFCPOLYLINE", [cartesian]);
      const profile = w.entity("IFCARBITRARYCLOSEDPROFILEDEF", [stepEnum("AREA"), $, polyline]);
      const placement = localPlacement(w, storeyPlacement, 0, 0, 0);
      const extrudeDir = w.entity("IFCDIRECTION", [[stepReal(0), stepReal(0), stepReal(1)]]);
      const solid = w.entity("IFCEXTRUDEDAREASOLID", [profile, $, extrudeDir, stepReal(level.floorToCeiling)]);
      const shapeRep = w.entity("IFCSHAPEREPRESENTATION", [context, stepString("Body"), stepString("SweptSolid"), [solid]]);
      const shape = w.entity("IFCPRODUCTDEFINITIONSHAPE", [$, $, [shapeRep]]);
      const space = w.entity("IFCSPACE", [
        stepString(ifcGuid(`${doc.id}:${level.id}:space:${roomId}`)),
        ownerHistory,
        stepString(room.name),
        $,
        stepString(room.program),
        placement,
        shape,
        $,
        stepEnum("ELEMENT"),
        stepEnum("SPACE"),
      ]);
      containedIds.push(space);
    }

    if (containedIds.length > 0) {
      w.entity("IFCRELCONTAINEDINSPATIALSTRUCTURE", [
        stepString(ifcGuid(`${doc.id}:${level.id}:contained`)),
        ownerHistory,
        $,
        $,
        containedIds,
        storey,
      ]);
    }
  }

  const timestamp = now.toISOString();
  const header = [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION((''),'2;1');`,
    `FILE_NAME(${stepString(`${doc.title || "plan"}.ifc`)},${stepString(timestamp)},(${stepString(author)}),(${stepString(organization)}),'Floorcraft','Floorcraft','');`,
    `FILE_SCHEMA(('IFC4'));`,
    "ENDSEC;",
    "DATA;",
  ].join("\n");
  const footer = ["ENDSEC;", "END-ISO-10303-21;", ""].join("\n");

  return [header, w.toString(), footer].join("\n");
}

function fillerEntity(w: StepWriter, opening: Opening, ownerHistory: Ref, guid: string): Ref | null {
  if (opening.kind === "door") {
    return w.entity("IFCDOOR", [
      stepString(guid),
      ownerHistory,
      $,
      $,
      $,
      $,
      $,
      $,
      stepReal(opening.height),
      stepReal(opening.width),
      stepEnum("DOOR"),
      $,
      $,
    ]);
  }
  if (opening.kind === "window") {
    return w.entity("IFCWINDOW", [
      stepString(guid),
      ownerHistory,
      $,
      $,
      $,
      $,
      $,
      $,
      stepReal(opening.height),
      stepReal(opening.width),
      stepEnum("WINDOW"),
      $,
      $,
    ]);
  }
  // cased openings and pass-throughs have no IFC element to fill them with — the void
  // (IfcOpeningElement) alone already records that the wall is open there.
  return null;
}
