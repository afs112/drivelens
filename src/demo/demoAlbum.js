/**
 * Offline Demo Shared Album Dataset
 * Provides SVG artistic photography across nested folders with 3 simulated friends
 * in both English ('en', default) and Chinese ('zh') using localized strings from src/i18n.js.
 */
import { MESSAGES } from '../i18n.js';

export const DEMO_STORAGE_KEY = 'drivelens_demo_state_v1';

const DEMO_PERSONA_DEFS = [
  { id: 'me', color: '#38bdf8' },
  { id: 'lin', color: '#f472b6' },
  { id: 'jie', color: '#34d399' },
];

function normalizeLang(lang) {
  return lang === 'zh' ? 'zh' : 'en';
}

function demoMsg(lang, key) {
  const code = normalizeLang(lang);
  return MESSAGES[code]?.[key] ?? MESSAGES.en[key] ?? key;
}

export function getDemoPersonas(lang = 'en') {
  const code = normalizeLang(lang);
  return DEMO_PERSONA_DEFS.map((p) => ({
    id: p.id,
    name: demoMsg(code, `demo.persona.${p.id}.name`),
    email: demoMsg(code, `demo.persona.${p.id}.email`),
    color: p.color,
  }));
}

export const DEMO_PERSONAS = getDemoPersonas('en');

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function estimateLabelPillWidth(label) {
  let px = 28;
  for (const ch of String(label || '')) {
    px += ch.charCodeAt(0) > 127 ? 13 : 7.4;
  }
  return Math.max(120, Math.round(px));
}

function makeArtSvg({ w, h, skyTop, skyMid, skyBot, sunColor, sunX, sunY, sunR, m1, m2, m3, water, stars, label, palette }) {
  const starDots = stars
    ? Array.from({ length: 28 }, (_, i) => {
        const cx = ((i * 73 + 19) % 94) + 3;
        const cy = ((i * 41 + 11) % 45) + 3;
        const r = i % 3 === 0 ? 1.7 : 0.9;
        const op = (0.45 + (i % 5) * 0.12).toFixed(2);
        return `<circle cx="${cx}%" cy="${cy}%" r="${r}" fill="#fff" opacity="${op}"/>`;
      }).join('')
    : '';

  const treeLayer =
    palette === 'autumn'
      ? `<g opacity="0.92">
         <polygon points="${w * 0.08},${h * 0.8} ${w * 0.14},${h * 0.56} ${w * 0.2},${h * 0.8}" fill="#d97706"/>
         <polygon points="${w * 0.15},${h * 0.82} ${w * 0.22},${h * 0.52} ${w * 0.29},${h * 0.82}" fill="#b45309"/>
         <polygon points="${w * 0.72},${h * 0.81} ${w * 0.79},${h * 0.54} ${w * 0.86},${h * 0.81}" fill="#f59e0b"/>
         <polygon points="${w * 0.82},${h * 0.82} ${w * 0.89},${h * 0.58} ${w * 0.96},${h * 0.82}" fill="#92400e"/>
       </g>`
      : '';

  const portraitSilhouette =
    palette === 'portrait'
      ? `<g opacity="0.94">
         <circle cx="${w * 0.5}" cy="${h * 0.44}" r="${Math.min(w, h) * 0.11}" fill="#1e1b2e"/>
         <path d="M ${w * 0.32} ${h} C ${w * 0.34} ${h * 0.62}, ${w * 0.66} ${h * 0.62}, ${w * 0.68} ${h} Z" fill="#181526"/>
         <circle cx="${w * 0.5}" cy="${h * 0.44}" r="${Math.min(w, h) * 0.19}" fill="none" stroke="${sunColor}" stroke-opacity="0.32" stroke-width="6"/>
       </g>`
      : '';

  const waterLayer = water
    ? `<rect x="0" y="${h * 0.72}" width="${w}" height="${h * 0.28}" fill="${water}" opacity="0.9"/>
       <ellipse cx="${w * sunX}" cy="${h * 0.83}" rx="${w * 0.14}" ry="${h * 0.014}" fill="${sunColor}" opacity="0.45"/>
       <ellipse cx="${w * sunX}" cy="${h * 0.88}" rx="${w * 0.09}" ry="${h * 0.01}" fill="${sunColor}" opacity="0.32"/>`
    : '';

  const pillWidth = Math.min(w - 36, estimateLabelPillWidth(label));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${skyTop}"/>
        <stop offset="55%" stop-color="${skyMid}"/>
        <stop offset="100%" stop-color="${skyBot}"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="${sunColor}" stop-opacity="0.95"/>
        <stop offset="45%" stop-color="${sunColor}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${sunColor}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#sky)"/>
    ${starDots}
    <circle cx="${w * sunX}" cy="${h * sunY}" r="${sunR * 2.8}" fill="url(#glow)"/>
    <circle cx="${w * sunX}" cy="${h * sunY}" r="${sunR}" fill="${sunColor}" opacity="0.95"/>
    <path d="M 0 ${h * 0.68} L ${w * 0.18} ${h * 0.43} L ${w * 0.36} ${h * 0.59} L ${w * 0.58} ${h * 0.34} L ${w * 0.79} ${h * 0.55} L ${w} ${h * 0.4} L ${w} ${h} L 0 ${h} Z" fill="${m1}"/>
    <path d="M 0 ${h * 0.76} L ${w * 0.24} ${h * 0.54} L ${w * 0.45} ${h * 0.69} L ${w * 0.68} ${h * 0.48} L ${w * 0.88} ${h * 0.64} L ${w} ${h * 0.56} L ${w} ${h} L 0 ${h} Z" fill="${m2}"/>
    <path d="M 0 ${h * 0.82} Q ${w * 0.28} ${h * 0.68} ${w * 0.56} ${h * 0.77} T ${w} ${h * 0.73} L ${w} ${h} L 0 ${h} Z" fill="${m3}"/>
    ${waterLayer}
    ${treeLayer}
    ${portraitSilhouette}
    <rect x="18" y="${h - 40}" width="${pillWidth}" height="24" rx="12" fill="rgba(10,12,18,0.45)"/>
    <text x="30" y="${h - 24}" fill="rgba(255,255,255,0.84)" font-family="sans-serif" font-size="12" font-weight="600">${escapeXml(label)}</text>
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const DEMO_FOLDERS = [
  { id: 'demo-root', parentId: null, depth: 0 },
  { id: 'demo-d1', parentId: 'demo-root', depth: 1 },
  { id: 'demo-d2', parentId: 'demo-root', depth: 1 },
  { id: 'demo-d3', parentId: 'demo-root', depth: 1 },
  { id: 'demo-aerial', parentId: 'demo-root', depth: 1 },
];

const DEMO_SPECS = [
  {
    id: 'demo-p01',
    parentId: 'demo-d1',
    w: 1200,
    h: 800,
    time: '2026-10-12T07:18:22+08:00',
    size: 8420190,
    cam: ['SONY', 'ILCE-7M4', 24, 2.8, 0.004, 100],
    art: { skyTop: '#0f172a', skyMid: '#1e3a5f', skyBot: '#f59e0b', sunColor: '#fde68a', sunX: 0.7, sunY: 0.42, sunR: 34, m1: '#23354f', m2: '#18253a', m3: '#0f1826', water: '#16283f', stars: false },
  },
  {
    id: 'demo-p02',
    parentId: 'demo-d1',
    w: 800,
    h: 1000,
    time: '2026-10-12T09:42:10+08:00',
    size: 6910320,
    cam: ['FUJIFILM', 'X-T5', 35, 4.0, 0.001, 160],
    art: { skyTop: '#0c4a6e', skyMid: '#0284c7', skyBot: '#bae6fd', sunColor: '#fef9c3', sunX: 0.25, sunY: 0.24, sunR: 28, m1: '#475569', m2: '#334155', m3: '#1e293b', water: null, stars: false },
  },
  {
    id: 'demo-p03',
    parentId: 'demo-d1',
    w: 1280,
    h: 720,
    time: '2026-10-12T16:15:04+08:00',
    size: 7340112,
    cam: ['SONY', 'ILCE-7M4', 50, 1.8, 0.0005, 100],
    art: { skyTop: '#1e1b4b', skyMid: '#4338ca', skyBot: '#fb923c', sunColor: '#fed7aa', sunX: 0.52, sunY: 0.48, sunR: 42, m1: '#312e81', m2: '#1e1b4b', m3: '#0f172a', water: null, stars: false },
  },
  {
    id: 'demo-p04',
    parentId: 'demo-d2',
    w: 1200,
    h: 800,
    time: '2026-10-13T07:04:51+08:00',
    size: 11240500,
    cam: ['NIKON', 'Z8', 70, 5.6, 0.002, 200],
    art: { skyTop: '#1c1917', skyMid: '#7c2d12', skyBot: '#f59e0b', sunColor: '#fbbf24', sunX: 0.78, sunY: 0.28, sunR: 30, m1: '#b45309', m2: '#78350f', m3: '#292524', water: null, stars: false },
  },
  {
    id: 'demo-p05',
    parentId: 'demo-d2',
    w: 900,
    h: 900,
    time: '2026-10-13T10:12:30+08:00',
    size: 9120400,
    cam: ['NIKON', 'Z8', 85, 2.8, 0.00125, 100],
    art: { skyTop: '#0369a1', skyMid: '#38bdf8', skyBot: '#e0f2fe', sunColor: '#fffbeb', sunX: 0.22, sunY: 0.2, sunR: 26, m1: '#64748b', m2: '#475569', m3: '#b45309', water: null, stars: false },
  },
  {
    id: 'demo-p06',
    parentId: 'demo-d2',
    w: 1200,
    h: 800,
    time: '2026-10-13T18:48:19+08:00',
    size: 10450110,
    cam: ['SONY', 'ILCE-7M4', 24, 2.0, 0.01, 400],
    art: { skyTop: '#2e1065', skyMid: '#9d174d', skyBot: '#fb7185', sunColor: '#fda4af', sunX: 0.36, sunY: 0.56, sunR: 38, m1: '#4c1d95', m2: '#3b0764', m3: '#1e1b4b', water: null, stars: true },
  },
  {
    id: 'demo-p07',
    parentId: 'demo-d2',
    w: 800,
    h: 1200,
    time: '2026-10-13T22:31:05+08:00',
    size: 12850900,
    cam: ['SONY', 'ILCE-7M4', 16, 1.8, 15, 3200],
    art: { skyTop: '#020617', skyMid: '#0f172a', skyBot: '#1e3a8a', sunColor: '#38bdf8', sunX: 0.5, sunY: 0.35, sunR: 45, m1: '#0f172a', m2: '#090d16', m3: '#030712', water: null, stars: true },
  },
  {
    id: 'demo-p08',
    parentId: 'demo-d3',
    w: 1200,
    h: 800,
    time: '2026-10-14T08:40:12+08:00',
    size: 8740200,
    cam: ['FUJIFILM', 'X-T5', 56, 2.2, 0.002, 125],
    art: { skyTop: '#1e3a8a', skyMid: '#60a5fa', skyBot: '#fef08a', sunColor: '#fde047', sunX: 0.8, sunY: 0.25, sunR: 30, m1: '#78350f', m2: '#92400e', m3: '#451a03', water: null, stars: false, palette: 'autumn' },
  },
  {
    id: 'demo-p09',
    parentId: 'demo-d3',
    w: 850,
    h: 1060,
    time: '2026-10-14T11:15:40+08:00',
    size: 7910000,
    cam: ['FUJIFILM', 'X-T5', 35, 2.0, 0.001, 160],
    art: { skyTop: '#065f46', skyMid: '#d97706', skyBot: '#fde68a', sunColor: '#fef3c7', sunX: 0.45, sunY: 0.32, sunR: 26, m1: '#9a3412', m2: '#7c2d12', m3: '#431407', water: '#134e4a', stars: false, palette: 'autumn' },
  },
  {
    id: 'demo-p10',
    parentId: 'demo-d3',
    w: 800,
    h: 1200,
    time: '2026-10-14T16:52:18+08:00',
    size: 9630420,
    cam: ['SONY', 'ILCE-7M4', 85, 1.4, 0.0008, 100],
    art: { skyTop: '#451a03', skyMid: '#b45309', skyBot: '#fbbf24', sunColor: '#fef08a', sunX: 0.5, sunY: 0.44, sunR: 50, m1: '#78350f', m2: '#451a03', m3: '#292524', water: null, stars: false, palette: 'portrait' },
  },
  {
    id: 'demo-p11',
    parentId: 'demo-d3',
    w: 1200,
    h: 800,
    time: '2026-10-14T17:38:00+08:00',
    size: 8190500,
    cam: ['SONY', 'ILCE-7M4', 35, 2.8, 0.002, 125],
    art: { skyTop: '#1e293b', skyMid: '#ea580c', skyBot: '#fdba74', sunColor: '#ffedd5', sunX: 0.62, sunY: 0.48, sunR: 32, m1: '#334155', m2: '#1e293b', m3: '#0f172a', water: null, stars: false, palette: 'portrait' },
  },
  {
    id: 'demo-p12',
    parentId: 'demo-d3',
    w: 1000,
    h: 1000,
    time: '2026-10-14T19:20:45+08:00',
    size: 6410200,
    cam: ['FUJIFILM', 'X-T5', 23, 1.4, 0.016, 800],
    art: { skyTop: '#1c1917', skyMid: '#44403c', skyBot: '#d97706', sunColor: '#fbbf24', sunX: 0.34, sunY: 0.4, sunR: 34, m1: '#292524', m2: '#1c1917', m3: '#0c0a09', water: null, stars: false },
  },
  {
    id: 'demo-p13',
    parentId: 'demo-aerial',
    w: 1280,
    h: 720,
    time: '2026-10-15T11:05:11+08:00',
    size: 13450000,
    cam: ['DJI', 'Mavic 3 Pro', 24, 2.8, 0.001, 100],
    art: { skyTop: '#0f766e', skyMid: '#14b8a6', skyBot: '#99f6e4', sunColor: '#ecfeff', sunX: 0.7, sunY: 0.22, sunR: 22, m1: '#115e59', m2: '#134e4a', m3: '#042f2e', water: '#2dd4bf', stars: false },
  },
  {
    id: 'demo-p14',
    parentId: 'demo-aerial',
    w: 1200,
    h: 800,
    time: '2026-10-15T17:55:29+08:00',
    size: 14820100,
    cam: ['DJI', 'Mavic 3 Pro', 70, 2.8, 0.0025, 100],
    art: { skyTop: '#020617', skyMid: '#1e1b4b', skyBot: '#f97316', sunColor: '#fde047', sunX: 0.5, sunY: 0.36, sunR: 30, m1: '#4338ca', m2: '#1e1b4b', m3: '#0f172a', water: '#1e293b', stars: true },
  },
  {
    id: 'demo-p15',
    parentId: 'demo-aerial',
    w: 1350,
    h: 750,
    time: '2026-10-16T08:12:44+08:00',
    size: 15210000,
    cam: ['DJI', 'Mavic 3 Pro', 24, 4.0, 0.00125, 100],
    art: { skyTop: '#1e3a8a', skyMid: '#3b82f6', skyBot: '#f8fafc', sunColor: '#ffffff', sunX: 0.3, sunY: 0.25, sunR: 35, m1: '#475569', m2: '#334155', m3: '#1e293b', water: null, stars: false },
  },
  {
    id: 'demo-v01',
    parentId: 'demo-aerial',
    w: 1280,
    h: 720,
    time: '2026-10-16T18:30:00+08:00',
    size: 48620000,
    mimeType: 'video/mp4',
    durationMillis: 24000,
    cam: ['DJI', 'Mavic 3 Pro', 24, 2.8, 0.02, 200],
    art: { skyTop: '#3b0764', skyMid: '#be185d', skyBot: '#fb923c', sunColor: '#fef08a', sunX: 0.52, sunY: 0.45, sunR: 36, m1: '#4c1d95', m2: '#312e81', m3: '#0f172a', water: null, stars: true },
  },
];

const DEFAULT_TAG_DEFS = {
  'tag-pick': { id: 'tag-pick', color: 'emerald', createdBy: 'me' },
  'tag-retouch': { id: 'tag-retouch', color: 'amber', createdBy: 'me' },
  'tag-social': { id: 'tag-social', color: 'pink', createdBy: 'lin' },
  'tag-golden': { id: 'tag-golden', color: 'red', createdBy: 'me' },
  'tag-stars': { id: 'tag-stars', color: 'violet', createdBy: 'jie' },
  'tag-portrait': { id: 'tag-portrait', color: 'cyan', createdBy: 'lin' },
  'tag-drone': { id: 'tag-drone', color: 'blue', createdBy: 'jie' },
  'tag-sharp': { id: 'tag-sharp', color: 'slate', createdBy: 'me' },
};

const INITIAL_NOTE_FILES = {
  me: new Set(['demo-p01', 'demo-p04', 'demo-p06', 'demo-p07', 'demo-p14']),
  lin: new Set(['demo-p01', 'demo-p06', 'demo-p10', 'demo-p11']),
  jie: new Set(['demo-p04', 'demo-p14', 'demo-p15', 'demo-v01']),
};

function buildDefaultTagSchema(lang = 'en') {
  const code = normalizeLang(lang);
  const tags = {};
  for (const [id, def] of Object.entries(DEFAULT_TAG_DEFS)) {
    tags[id] = {
      id: def.id,
      name: demoMsg(code, `demo.tag.${id}.name`),
      color: def.color,
      group: demoMsg(code, `demo.tag.${id}.group`),
      deleted: false,
      updatedAt: 1763400000000,
      createdBy: def.createdBy,
    };
  }
  return { version: 1, tags };
}

export const DEFAULT_TAG_SCHEMA = buildDefaultTagSchema('en');

function noteFor(lang, memberId, fileId) {
  if (!INITIAL_NOTE_FILES[memberId]?.has(fileId)) return '';
  return demoMsg(lang, `demo.note.${memberId}.${fileId}`);
}

function buildInitialMembersData(lang = 'en') {
  const code = normalizeLang(lang);
  const personas = getDemoPersonas(code);
  return {
    me: {
      version: 1,
      member: { ...personas[0], updatedAt: 1763410000000 },
      items: {
        'demo-p01': {
          rating: 5,
          favorite: true,
          note: noteFor(code, 'me', 'demo-p01'),
          tags: { 'tag-pick': { active: true, updatedAt: 1763410000000 }, 'tag-sharp': { active: true, updatedAt: 1763410000000 } },
          updatedAt: 1763410000000,
        },
        'demo-p04': {
          rating: 5,
          favorite: true,
          note: noteFor(code, 'me', 'demo-p04'),
          tags: { 'tag-pick': { active: true, updatedAt: 1763410000000 }, 'tag-golden': { active: true, updatedAt: 1763410000000 } },
          updatedAt: 1763410000000,
        },
        'demo-p06': {
          rating: 4,
          favorite: false,
          note: noteFor(code, 'me', 'demo-p06'),
          tags: { 'tag-retouch': { active: true, updatedAt: 1763410000000 } },
          updatedAt: 1763410000000,
        },
        'demo-p07': {
          rating: 5,
          favorite: true,
          note: noteFor(code, 'me', 'demo-p07'),
          tags: { 'tag-pick': { active: true, updatedAt: 1763410000000 }, 'tag-stars': { active: true, updatedAt: 1763410000000 } },
          updatedAt: 1763410000000,
        },
        'demo-p10': {
          rating: 4,
          favorite: false,
          note: '',
          tags: { 'tag-portrait': { active: true, updatedAt: 1763410000000 }, 'tag-social': { active: true, updatedAt: 1763410000000 } },
          updatedAt: 1763410000000,
        },
        'demo-p14': {
          rating: 5,
          favorite: true,
          note: noteFor(code, 'me', 'demo-p14'),
          tags: { 'tag-pick': { active: true, updatedAt: 1763410000000 }, 'tag-golden': { active: true, updatedAt: 1763410000000 }, 'tag-drone': { active: true, updatedAt: 1763410000000 } },
          updatedAt: 1763410000000,
        },
      },
    },
    lin: {
      version: 1,
      member: { ...personas[1], updatedAt: 1763411000000 },
      items: {
        'demo-p01': { rating: 5, favorite: true, note: noteFor(code, 'lin', 'demo-p01'), tags: {}, updatedAt: 1763411000000 },
        'demo-p02': { rating: 4, favorite: false, note: '', tags: { 'tag-social': { active: true, updatedAt: 1763411000000 } }, updatedAt: 1763411000000 },
        'demo-p06': { rating: 5, favorite: true, note: noteFor(code, 'lin', 'demo-p06'), tags: { 'tag-social': { active: true, updatedAt: 1763411000000 } }, updatedAt: 1763411000000 },
        'demo-p08': { rating: 4, favorite: false, note: '', tags: { 'tag-sharp': { active: true, updatedAt: 1763411000000 } }, updatedAt: 1763411000000 },
        'demo-p10': { rating: 5, favorite: true, note: noteFor(code, 'lin', 'demo-p10'), tags: { 'tag-pick': { active: true, updatedAt: 1763411000000 } }, updatedAt: 1763411000000 },
        'demo-p11': { rating: 5, favorite: true, note: noteFor(code, 'lin', 'demo-p11'), tags: { 'tag-portrait': { active: true, updatedAt: 1763411000000 }, 'tag-social': { active: true, updatedAt: 1763411000000 } }, updatedAt: 1763411000000 },
        'demo-p12': { rating: 4, favorite: false, note: '', tags: { 'tag-social': { active: true, updatedAt: 1763411000000 } }, updatedAt: 1763411000000 },
      },
    },
    jie: {
      version: 1,
      member: { ...personas[2], updatedAt: 1763412000000 },
      items: {
        'demo-p04': { rating: 5, favorite: true, note: noteFor(code, 'jie', 'demo-p04'), tags: {}, updatedAt: 1763412000000 },
        'demo-p07': { rating: 5, favorite: true, note: '', tags: { 'tag-sharp': { active: true, updatedAt: 1763412000000 } }, updatedAt: 1763412000000 },
        'demo-p13': { rating: 4, favorite: false, note: '', tags: { 'tag-drone': { active: true, updatedAt: 1763412000000 } }, updatedAt: 1763412000000 },
        'demo-p14': { rating: 5, favorite: true, note: noteFor(code, 'jie', 'demo-p14'), tags: { 'tag-sharp': { active: true, updatedAt: 1763412000000 } }, updatedAt: 1763412000000 },
        'demo-p15': { rating: 4, favorite: true, note: noteFor(code, 'jie', 'demo-p15'), tags: { 'tag-drone': { active: true, updatedAt: 1763412000000 }, 'tag-retouch': { active: true, updatedAt: 1763412000000 } }, updatedAt: 1763412000000 },
        'demo-v01': { rating: 5, favorite: true, note: noteFor(code, 'jie', 'demo-v01'), tags: { 'tag-drone': { active: true, updatedAt: 1763412000000 }, 'tag-pick': { active: true, updatedAt: 1763412000000 } }, updatedAt: 1763412000000 },
      },
    },
  };
}

function buildDemoFolders(lang = 'en') {
  const code = normalizeLang(lang);
  return DEMO_FOLDERS.map((f) => ({
    id: f.id,
    name: demoMsg(code, `demo.folder.${f.id}`),
    parentId: f.parentId,
    depth: f.depth,
  }));
}

function buildDemoFiles(lang = 'en') {
  const code = normalizeLang(lang);
  return DEMO_SPECS.map((spec) => {
    const [cameraMake, cameraModel, focalLength, aperture, exposureTime, isoSpeed] = spec.cam;
    const isVideo = spec.mimeType && spec.mimeType.startsWith('video/');
    const label = demoMsg(code, `demo.file.${spec.id}.label`);
    return {
      id: spec.id,
      name: demoMsg(code, `demo.file.${spec.id}.name`),
      parentId: spec.parentId,
      mimeType: spec.mimeType || 'image/jpeg',
      size: spec.size,
      createdTime: spec.time,
      modifiedTime: spec.time,
      isDemo: true,
      demoDataUrl: makeArtSvg({ w: spec.w, h: spec.h, ...spec.art, label }),
      webViewLink: '',
      imageMediaMetadata: isVideo
        ? { width: spec.w, height: spec.h, time: spec.time }
        : {
            width: spec.w,
            height: spec.h,
            time: spec.time,
            cameraMake,
            cameraModel,
            focalLength,
            aperture,
            exposureTime,
            isoSpeed,
          },
      videoMediaMetadata: isVideo
        ? { width: spec.w, height: spec.h, durationMillis: spec.durationMillis || 15000 }
        : null,
    };
  });
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function localizeDemoState(state, lang = 'en') {
  const code = normalizeLang(lang);
  const folderIds = new Set(DEMO_FOLDERS.map((f) => f.id));
  const specsById = new Map(DEMO_SPECS.map((s) => [s.id, s]));
  const personas = getDemoPersonas(code);
  const personaById = new Map(personas.map((p) => [p.id, p]));

  const rootFolder = {
    ...(state?.rootFolder || {}),
    id: 'demo-root',
    name: demoMsg(code, 'demo.folder.demo-root'),
    canWrite: true,
  };

  const folders =
    Array.isArray(state?.folders) && state.folders.length > 0
      ? state.folders.map((f) =>
          folderIds.has(f.id) ? { ...f, name: demoMsg(code, `demo.folder.${f.id}`) } : { ...f }
        )
      : buildDemoFolders(code);

  const files =
    Array.isArray(state?.files) && state.files.length > 0
      ? state.files.map((file) => {
          const spec = specsById.get(file.id);
          if (!spec) return { ...file };
          const label = demoMsg(code, `demo.file.${spec.id}.label`);
          return {
            ...file,
            name: demoMsg(code, `demo.file.${spec.id}.name`),
            demoDataUrl: makeArtSvg({ w: spec.w, h: spec.h, ...spec.art, label }),
          };
        })
      : buildDemoFiles(code);

  const srcTags = state?.tagSchema?.tags || {};
  const nextTags = {};
  for (const [tagId, tag] of Object.entries(srcTags)) {
    const def = DEFAULT_TAG_DEFS[tagId];
    if (def && tag) {
      const enName = demoMsg('en', `demo.tag.${tagId}.name`);
      const zhName = demoMsg('zh', `demo.tag.${tagId}.name`);
      const enGroup = demoMsg('en', `demo.tag.${tagId}.group`);
      const zhGroup = demoMsg('zh', `demo.tag.${tagId}.group`);
      const nameUnedited = !tag.name || tag.name === enName || tag.name === zhName;
      const groupUnedited = !tag.group || tag.group === enGroup || tag.group === zhGroup;
      nextTags[tagId] = {
        ...tag,
        name: nameUnedited ? demoMsg(code, `demo.tag.${tagId}.name`) : tag.name,
        group: groupUnedited ? demoMsg(code, `demo.tag.${tagId}.group`) : tag.group,
      };
    } else {
      nextTags[tagId] = tag ? { ...tag } : tag;
    }
  }
  const tagSchema = {
    version: state?.tagSchema?.version || 1,
    tags: nextTags,
  };

  const srcMembers = state?.membersData || {};
  const nextMembers = {};
  for (const [memberId, record] of Object.entries(srcMembers)) {
    if (!record) continue;
    const targetPersona = personaById.get(memberId);
    let nextMember = record.member ? { ...record.member } : { id: memberId };

    if (targetPersona) {
      const enName = demoMsg('en', `demo.persona.${memberId}.name`);
      const zhName = demoMsg('zh', `demo.persona.${memberId}.name`);
      const nameUnedited = !nextMember.name || nextMember.name === enName || nextMember.name === zhName;
      if (nameUnedited) {
        nextMember = {
          ...nextMember,
          name: targetPersona.name,
          email: targetPersona.email,
          color: nextMember.color || targetPersona.color,
        };
      }
    }

    const srcItems = record.items || {};
    const nextItems = {};
    const memberNoteSet = INITIAL_NOTE_FILES[memberId];
    for (const [fileId, item] of Object.entries(srcItems)) {
      if (!item) continue;
      if (memberNoteSet?.has(fileId)) {
        const enNote = demoMsg('en', `demo.note.${memberId}.${fileId}`);
        const zhNote = demoMsg('zh', `demo.note.${memberId}.${fileId}`);
        if (item.note === enNote || item.note === zhNote) {
          nextItems[fileId] = { ...item, note: demoMsg(code, `demo.note.${memberId}.${fileId}`) };
        } else {
          nextItems[fileId] = { ...item };
        }
      } else {
        nextItems[fileId] = { ...item };
      }
    }

    nextMembers[memberId] = {
      ...record,
      member: nextMember,
      items: nextItems,
    };
  }

  let currentUser = state?.currentUser ? { ...state.currentUser } : undefined;
  if (currentUser && personaById.has(currentUser.id)) {
    const targetPersona = personaById.get(currentUser.id);
    const enName = demoMsg('en', `demo.persona.${currentUser.id}.name`);
    const zhName = demoMsg('zh', `demo.persona.${currentUser.id}.name`);
    if (!currentUser.name || currentUser.name === enName || currentUser.name === zhName) {
      currentUser = { ...currentUser, ...targetPersona };
    }
  }

  return {
    ...(state || {}),
    rootFolder,
    folders,
    files,
    tagSchema,
    membersData: nextMembers,
    ...(currentUser ? { currentUser } : {}),
  };
}

export function createDemoDataset(lang = 'en') {
  const code = normalizeLang(lang);
  const files = buildDemoFiles(code);
  const folders = buildDemoFolders(code);
  const rootFolder = { id: 'demo-root', name: demoMsg(code, 'demo.folder.demo-root'), canWrite: true };

  let saved = null;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DEMO_STORAGE_KEY) : null;
    if (raw) saved = JSON.parse(raw);
  } catch {
    saved = null;
  }

  const rawTagSchema = saved?.tagSchema || buildDefaultTagSchema(code);
  const rawMembersData = saved?.membersData || buildInitialMembersData(code);
  const activePersonaId = saved?.activePersonaId || 'me';

  const localized = localizeDemoState(
    {
      rootFolder,
      folders,
      files,
      tagSchema: deepClone(rawTagSchema),
      membersData: deepClone(rawMembersData),
    },
    code
  );

  return {
    rootFolder: localized.rootFolder,
    folders: localized.folders,
    files: localized.files,
    tagSchema: localized.tagSchema,
    membersData: localized.membersData,
    activePersonaId,
  };
}

export function saveDemoState({ tagSchema, membersData, activePersonaId }) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        DEMO_STORAGE_KEY,
        JSON.stringify({ tagSchema, membersData, activePersonaId })
      );
    }
  } catch {
    // Ignore storage quota errors in demo mode
  }
}

export function resetDemoState(lang = 'en') {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(DEMO_STORAGE_KEY);
    }
  } catch {
    // Ignore
  }
  return createDemoDataset(lang);
}
