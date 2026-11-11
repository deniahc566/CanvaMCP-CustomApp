// Canva draws shapes from a subset of SVG path data (PathOpts.d in @canva/design): one M command at
// the start, no Q or T commands, and the path must be closed. Canva only checks this when the
// editing session saves, so a dry run would pass a path that the real save then rejects. Checking
// here makes both fail the same way, and Q/T curves are rewritten as the same curves drawn with C.

export type Point = { x: number; y: number };
type Command = { letter: string; args: number[] };

const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

function parse(d: string): Command[] {
  const commands: Command[] = [];
  let i = 0;
  let letter: string | undefined;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const found = () => (i < d.length ? `"${d[i]}"` : 'the end');
  const read = (flag: boolean): number => {
    skip();
    // Arc flags are single digits and may be written without separators ("a5 5 0 1010 0").
    if (flag) {
      if (d[i] === '0' || d[i] === '1') return Number(d[i++]);
      throw new Error(`Expected an arc flag (0 or 1) at position ${i + 1} of the path, found ${found()}.`);
    }
    const match = NUMBER.exec(d.slice(i));
    if (!match) throw new Error(`Expected a number at position ${i + 1} of the path, found ${found()}.`);
    i += match[0].length;
    return Number(match[0]);
  };

  for (skip(); i < d.length; skip()) {
    if (/[a-z]/i.test(d[i])) {
      letter = d[i++];
      if (!(letter.toLowerCase() in ARITY)) throw new Error(`"${letter}" isn't an SVG path command.`);
      if (letter.toLowerCase() === 'z') {
        commands.push({ letter, args: [] });
        continue;
      }
    } else if (!letter || letter.toLowerCase() === 'z') {
      throw new Error(`Expected a path command at position ${i + 1} of the path, found ${found()}.`);
    }
    const kind = letter.toLowerCase();
    const args = Array.from({ length: ARITY[kind] }, (_, k) => read(kind === 'a' && (k === 3 || k === 4)));
    commands.push({ letter, args });
    // More coordinate pairs after an M are implicit L commands.
    if (letter === 'M') letter = 'L';
    else if (letter === 'm') letter = 'l';
  }
  return commands;
}

const num = (n: number) => String(Math.round(n * 1e4) / 1e4);
const pt = (p: Point) => `${num(p.x)} ${num(p.y)}`;
const reflect = (control: Point, about: Point): Point => ({ x: 2 * about.x - control.x, y: 2 * about.y - control.y });
const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/** The control points of the cubic curve that draws the same curve as a quadratic one from `from` through `q` to `to`. */
function quadControls(from: Point, q: Point, to: Point): [Point, Point] {
  return [
    { x: from.x + (2 / 3) * (q.x - from.x), y: from.y + (2 / 3) * (q.y - from.y) },
    { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) },
  ];
}

/** One command in absolute form, with the points it touches (control points included). */
type Segment = { kind: 'M' | 'L' | 'C' | 'A' | 'Z'; text: string; to: Point; points: Point[] };

/** Every command as absolute M, L, C, A or Z; `rewrite` is set when Q or T had to become C. */
function absolute(commands: Command[]): { segments: Segment[]; rewrite: boolean } {
  let cur: Point = { x: 0, y: 0 };
  let start = cur;
  // The last control point of the previous C/S (or Q/T), which a following S (or T) reflects.
  let lastCubic: Point | undefined;
  let lastQuad: Point | undefined;
  let rewrite = false;
  const segments: Segment[] = [];
  const curve = (c1: Point, c2: Point, to: Point) => segments.push({ kind: 'C', text: `C${pt(c1)} ${pt(c2)} ${pt(to)}`, to, points: [c1, c2, to] });

  for (const { letter, args } of commands) {
    const rel = letter !== letter.toUpperCase();
    const at = (x: number, y: number): Point => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    let nextCubic: Point | undefined;
    let nextQuad: Point | undefined;
    switch (letter.toLowerCase()) {
      case 'm':
        cur = start = at(args[0], args[1]);
        segments.push({ kind: 'M', text: `M${pt(cur)}`, to: cur, points: [cur] });
        break;
      case 'l':
      case 'h':
      case 'v': {
        const kind = letter.toLowerCase();
        cur = kind === 'l' ? at(args[0], args[1]) : kind === 'h' ? { x: rel ? cur.x + args[0] : args[0], y: cur.y } : { x: cur.x, y: rel ? cur.y + args[0] : args[0] };
        segments.push({ kind: 'L', text: `L${pt(cur)}`, to: cur, points: [cur] });
        break;
      }
      case 'c':
      case 's': {
        const c1 = letter.toLowerCase() === 'c' ? at(args[0], args[1]) : lastCubic ? reflect(lastCubic, cur) : cur;
        const rest = letter.toLowerCase() === 'c' ? args.slice(2) : args;
        const c2 = at(rest[0], rest[1]);
        const to = at(rest[2], rest[3]);
        curve(c1, c2, to);
        nextCubic = c2;
        cur = to;
        break;
      }
      case 'q':
      case 't': {
        const q = letter.toLowerCase() === 'q' ? at(args[0], args[1]) : lastQuad ? reflect(lastQuad, cur) : cur;
        const to = letter.toLowerCase() === 'q' ? at(args[2], args[3]) : at(args[0], args[1]);
        curve(...quadControls(cur, q, to), to);
        nextQuad = q;
        cur = to;
        rewrite = true;
        break;
      }
      case 'a': {
        const to = at(args[5], args[6]);
        // An arc can bulge past its end points; widen the box by its radii at both ends to cover it.
        const [rx, ry] = [Math.abs(args[0]), Math.abs(args[1])];
        const around = (p: Point) => [{ x: p.x - rx, y: p.y - ry }, { x: p.x + rx, y: p.y + ry }];
        segments.push({ kind: 'A', text: `A${args.slice(0, 5).map(num).join(' ')} ${pt(to)}`, to, points: [...around(cur), ...around(to), to] });
        cur = to;
        break;
      }
      case 'z':
        segments.push({ kind: 'Z', text: 'Z', to: start, points: [] });
        cur = start;
        break;
    }
    lastCubic = nextCubic;
    lastQuad = nextQuad;
  }
  return { segments, rewrite };
}

/**
 * Check SVG path data against what Canva accepts for a shape path. Returns it unchanged, or, when it
 * uses Q or T, rewritten with absolute M, L, C, A and Z commands. Throws with a reason otherwise.
 */
export function normalizeShapePath(d: string): string {
  const commands = parse(d);
  if (commands[0]?.letter.toLowerCase() !== 'm') throw new Error('A shape path must start with an M command.');
  if (commands.slice(1).some((c) => c.letter.toLowerCase() === 'm')) {
    throw new Error('Canva allows only one M command per path. Draw each separate outline as its own entry in paths.');
  }
  const { segments, rewrite } = absolute(commands);
  const last = segments.at(-1)!;
  if (last.kind !== 'Z' && !near(last.to, segments[0].to)) {
    throw new Error('Canva only draws closed paths: end the path with Z, or finish it at the point where it starts.');
  }
  return rewrite ? segments.map((s) => s.text).join(' ') : d;
}

export interface Subpath {
  /** Absolute M, L, C, A and Z commands, starting with its one M. */
  d: string;
  /** Ends with Z or back at its starting point. */
  closed: boolean;
  /** Only straight lines (no curves or arcs). */
  straight: boolean;
  /** The points a straight subpath runs through, in order. */
  points: Point[];
}

/**
 * Any SVG path data split into subpaths in absolute form, with the box around everything it draws.
 * For turning arbitrary SVG paths into Canva shape paths, which allow one M each and must be closed.
 */
export function absoluteSubpaths(d: string): { subpaths: Subpath[]; bounds: { x: number; y: number; width: number; height: number } } {
  const commands = parse(d);
  if (commands[0]?.letter.toLowerCase() !== 'm') throw new Error('Path data must start with an M command.');
  const { segments } = absolute(commands);
  const subpaths: Subpath[] = [];
  let run: Segment[] = [];
  const flush = () => {
    // A lone M draws nothing.
    if (run.length > 1) {
      const last = run.at(-1)!;
      subpaths.push({
        d: run.map((s) => s.text).join(' '),
        closed: last.kind === 'Z' || near(last.to, run[0].to),
        straight: run.every((s) => s.kind === 'M' || s.kind === 'L' || s.kind === 'Z'),
        points: run.filter((s) => s.kind === 'M' || s.kind === 'L').map((s) => s.to),
      });
    }
    run = [];
  };
  for (const s of segments) {
    if (s.kind === 'M') flush();
    run.push(s);
  }
  flush();
  const all = segments.flatMap((s) => s.points);
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { subpaths, bounds: all.length ? { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y } : { x: 0, y: 0, width: 0, height: 0 } };
}
