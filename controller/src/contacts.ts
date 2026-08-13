export type ContactKind = "finger" | "palm" | "unknown";

export type Contact = {
  id: number;
  radius: number;
  minor: number;
  kind: ContactKind;
  at: number;
};

const FINGER_MAX = 36;
const PALM_MIN = 44;
const RELATIVE_RATIO = 1.75;
const RELATIVE_GAP = 8;
const UNKNOWN_MS = 24;

function eccentricity(radius: number, minor: number): number {
  return radius / Math.max(minor, 0.5);
}

function kindFromShape(radius: number, minor: number): ContactKind {
  if (radius <= 1) return "unknown";
  const ecc = eccentricity(radius, minor);
  if (radius >= PALM_MIN) return "palm";
  if (radius >= 26 && ecc >= 2.15) return "palm";
  if (radius <= FINGER_MAX) return "finger";
  return ecc >= 1.9 ? "palm" : "finger";
}

function applyRelative(contacts: Contact[]): void {
  const known = contacts.filter((c) => c.radius > 1);
  if (known.length < 2) return;
  const minR = Math.min(...known.map((c) => c.radius));
  for (const c of known) {
    if (c.radius >= minR * RELATIVE_RATIO && c.radius >= minR + RELATIVE_GAP) {
      c.kind = "palm";
    }
  }
}

function finalizeUnknown(c: Contact, now: number): void {
  if (c.kind !== "unknown") return;
  if (now - c.at >= UNKNOWN_MS) c.kind = "finger";
}

export function radiusFromTouch(touch: Touch): { radius: number; minor: number } {
  const rx = Number.isFinite(touch.radiusX) ? touch.radiusX : 0;
  const ry = Number.isFinite(touch.radiusY) ? touch.radiusY : 0;
  const major = Math.max(rx, ry);
  const minor = Math.min(rx, ry) || major;
  return { radius: major, minor };
}

export function radiusFromPointer(ev: PointerEvent): { radius: number; minor: number } {
  const w = ev.width || 0;
  const h = ev.height || 0;
  if (w <= 2 && h <= 2) return { radius: 0, minor: 0 };
  const major = Math.max(w, h) / 2;
  const minor = Math.min(w, h) / 2;
  return { radius: major, minor };
}

export class ContactMap {
  private readonly contacts = new Map<number, Contact>();

  upsert(
    id: number,
    radius: number,
    minor: number,
    now: number,
    pointerType?: string,
  ): Contact {
    const prev = this.contacts.get(id);
    const nextRadius = radius > 1 ? radius : prev?.radius ?? 0;
    const nextMinor = minor > 0.5 ? minor : prev?.minor ?? nextRadius;
    let kind: ContactKind =
      pointerType === "pen" || pointerType === "mouse"
        ? "finger"
        : kindFromShape(nextRadius, nextMinor);
    if (kind === "unknown" && prev?.kind === "finger") kind = "finger";
    const contact: Contact = {
      id,
      radius: nextRadius,
      minor: nextMinor,
      kind,
      at: prev?.at ?? now,
    };
    this.contacts.set(id, contact);
    this.reclassify(now);
    return this.contacts.get(id)!;
  }

  delete(id: number): void {
    this.contacts.delete(id);
    this.reclassify(performance.now());
  }

  get(id: number): Contact | undefined {
    return this.contacts.get(id);
  }

  fingers(): Contact[] {
    return [...this.contacts.values()]
      .filter((c) => c.kind === "finger")
      .sort((a, b) => a.radius - b.radius || a.id - b.id);
  }

  tick(now = performance.now()): void {
    this.reclassify(now);
  }

  private reclassify(now: number): void {
    const list = [...this.contacts.values()];
    for (const c of list) finalizeUnknown(c, now);
    applyRelative(list);
    for (const c of list) this.contacts.set(c.id, c);
  }
}
