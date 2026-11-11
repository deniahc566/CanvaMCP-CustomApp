// An in-memory stand-in for the parts of @canva/design the bridge app uses: openDesign sessions
// (current page and all pages), element lists, rich text, fills, strokes, groups and design metadata.
// Unlike Canva, edits apply immediately; tests check `syncs` to see whether a batch was saved.

function richtext(initial) {
  let s = `${initial}\n`;
  const formats = [];
  return {
    formats,
    readPlaintext: () => s,
    readTextRegions: () => [{ text: s, formatting: { fontWeight: 'normal' } }],
    replaceText: ({ index, length }, chars, formatting) => {
      s = s.slice(0, index) + chars + s.slice(index + length);
      if (formatting) formats.push(['inline', index, chars.length, formatting]);
      return { bounds: { index, length: chars.length } };
    },
    formatText: (b, f) => formats.push(['inline', b.index, b.length, f]),
    formatParagraph: (b, f) => formats.push(['paragraph', b.index, b.length, f]),
  };
}

function container(state) {
  const c = { ref: state, set: (next) => void (c.ref = next) };
  return c;
}
const fill = (color, media) => ({ colorContainer: container(color ? { type: 'solid', color } : undefined), mediaContainer: container(media ? (typeof media === 'string' ? { type: media } : media) : undefined) });
const stroke = (weight, color) => ({ weight, colorContainer: container(color ? { type: 'solid', color } : undefined) });
const el = (type, top, left, width, height, extra = {}) => ({ type, top, left, width, height, rotation: 0, transparency: 0, locked: false, ...extra });

function list(items) {
  const take = (item) => {
    const i = items.indexOf(item);
    if (i === -1) throw new Error('item not in list');
    items.splice(i, 1);
  };
  return {
    items,
    count: () => items.length,
    toArray: () => [...items],
    forEach: (cb) => items.forEach(cb),
    filter: (p) => items.filter(p),
    insertBefore(ref, state) {
      const node = materialize(state);
      items.splice(ref === undefined ? items.length : items.indexOf(ref), 0, node);
      return node;
    },
    insertAfter(ref, state) {
      const node = materialize(state);
      items.splice(ref === undefined ? 0 : items.indexOf(ref) + 1, 0, node);
      return node;
    },
    moveBefore(ref, item) {
      take(item);
      items.splice(ref === undefined ? items.length : items.indexOf(ref), 0, item);
    },
    moveAfter(ref, item) {
      take(item);
      items.splice(ref === undefined ? 0 : items.indexOf(ref) + 1, 0, item);
    },
    delete: take,
  };
}

function materialize(state) {
  const box = { rotation: state.rotation ?? 0, transparency: state.transparency ?? 0 };
  switch (state.kind) {
    case 'text':
      return { ...el('text', state.top, state.left, state.width, 40), ...box, text: richtext(state.text.regions.map((r) => r.text).join('')), insertedFormatting: state.text.regions[0].formatting };
    case 'rect':
      return {
        ...el('rect', state.top, state.left, state.width, state.height),
        ...box,
        fill: fill(state.fill?.colorContainer?.color, state.fill?.mediaContainer),
        stroke: stroke(state.stroke?.weight ?? 0, state.stroke?.colorContainer?.color),
      };
    case 'shape':
      return {
        ...el('shape', state.top, state.left, state.width, state.height),
        ...box,
        viewBox: state.viewBox,
        paths: list(state.paths.map((p) => ({ d: p.d, fill: fill(p.fill?.colorContainer?.color, p.fill?.mediaContainer), stroke: p.stroke && stroke(p.stroke.weight, p.stroke.colorContainer.color) }))),
      };
    case 'embed':
      return { ...el('embed', state.top, state.left, state.width, state.height), ...box, url: state.url };
    default:
      throw new Error(`can't insert ${state.kind}`);
  }
}

export function createFakeEditor() {
  let syncs = 0;
  const page1 = {
    type: 'absolute',
    id: 'PAGE1',
    locked: false,
    dimensions: { width: 1920, height: 1080 },
    background: fill('#ffffff'),
    elements: list([
      el('rect', 0, 0, 1920, 1080, { fill: fill(undefined, 'image'), stroke: stroke(0) }),
      el('text', 100, 120, 900, 140, { text: richtext('Q3 Launch Plan') }),
      el('group', 300, 120, 600, 200, {
        contents: list([
          el('text', 300, 120, 600, 60, { text: richtext('Subtitle goes here') }),
          el('shape', 380, 120, 80, 80, { viewBox: { top: 0, left: 0, width: 10, height: 10 }, paths: list([{ d: 'M0 0 L10 0 L10 10 Z', fill: fill('#ff0000'), stroke: undefined }]) }),
        ]),
      }),
      el('text', 1000, 120, 400, 40, { text: richtext('Confidential'), locked: true }),
      el('rect', 600, 1500, 300, 200, { fill: fill('#00aaff'), stroke: stroke(2, '#000000') }),
    ]),
  };
  const page2 = { type: 'absolute', id: 'PAGE2', locked: false, dimensions: { width: 1920, height: 1080 }, background: fill('#000000'), elements: list([el('text', 50, 50, 500, 60, { text: richtext('Page two title') })]) };
  const pages = [page1, page2];

  const helpersFor = (page) => ({
    elementStateBuilder: {
      createTextElement: (o) => ({ kind: 'text', ...o }),
      createRectElement: (o) => ({ kind: 'rect', ...o }),
      createShapeElement: (o) => ({ kind: 'shape', ...o }),
      createEmbedElement: (o) => ({ kind: 'embed', ...o }),
    },
    group: async ({ elements }) => {
      const at = Math.min(...elements.map((e) => page.elements.items.indexOf(e)));
      for (const e of elements) page.elements.delete(e);
      const group = el('group', Math.min(...elements.map((e) => e.top)), Math.min(...elements.map((e) => e.left)), 100, 100, { contents: list([...elements]) });
      page.elements.items.splice(at, 0, group);
      return group;
    },
    ungroup: async ({ element }) => {
      const at = page.elements.items.indexOf(element);
      const parts = element.contents.toArray();
      page.elements.items.splice(at, 1, ...parts);
      return parts;
    },
  });

  // Like @canva/asset's upload: hands back a ref at once and resolves whenUploaded later.
  const uploads = [];
  const upload = async (opts) => {
    uploads.push(opts);
    return { ref: `IMAGEREF${uploads.length}`, whenUploaded: async () => {} };
  };

  // Like Canva, refuse to save while a page opened with openPage is still open.
  let pageOpen = false;
  const sync = async () => {
    if (pageOpen) throw new Error('Cannot sync design - a page is open. Wait for `openPage` to resolve before syncing.');
    syncs++;
  };
  const sdk = {
    openDesign: async (opts, callback) => {
      if (opts.type === 'current_page') return callback({ page: page1, helpers: helpersFor(page1), sync });
      const refs = pages.map((p) => ({ type: 'absolute', locked: p.locked, page: p }));
      return callback({
        pageRefs: list(refs),
        helpers: {
          openPage: async (ref, cb) => {
            pageOpen = true;
            try {
              await cb({ page: ref.page, helpers: helpersFor(ref.page) });
            } finally {
              pageOpen = false;
            }
            return { status: 'executed' };
          },
        },
        sync,
      });
    },
    getDesignMetadata: async () => ({ title: 'Launch deck', durationInSeconds: 0, pageMetadata: pages.map((p) => ({ type: 'absolute', id: p.id, dimensions: p.dimensions })) }),
    getDesignToken: async () => ({ token: `h.${Buffer.from(JSON.stringify({ designId: 'DAFAKE123', aud: 'app' })).toString('base64url')}.sig` }),
    upload,
  };
  return { sdk, pages, syncs: () => syncs, uploads };
}
