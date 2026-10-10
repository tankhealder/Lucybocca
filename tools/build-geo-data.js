// Baut geo-data.js (stumme Europakarte + Zielgebiete für die Geo-App) aus Natural-Earth-Daten (gemeinfrei).
// Aufruf: node tools/build-geo-data.js <Ordner mit den Natural-Earth-GeoJSON-Dateien>
// Benötigt: ne_50m_land, ne_50m_admin_0_boundary_lines_land, ne_10m_rivers_lake_centerlines,
//           ne_10m_lakes, ne_10m_geography_regions_polys, ne_10m_geography_marine_polys
// Quelle: https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
if (!dir) { console.error('Bitte den Ordner mit den Natural-Earth-Dateien angeben.'); process.exit(1); }
const load = f => JSON.parse(fs.readFileSync(path.join(dir, f + '.geojson'), 'utf8')).features;

/* ---------- Ausschnitt und Projektion (flächentreu, Mitte Europa) ---------- */
const BOX = { w:-26, e:62, s:33.5, n:72 };          // Island bis Ural/Kaspisches Meer
const LON0 = 17 * Math.PI / 180, LAT0 = 52 * Math.PI / 180;
function laea(lon, lat){                            // Lambert Azimutal flächentreu
  const l = lon * Math.PI / 180, p = lat * Math.PI / 180;
  const k = Math.sqrt(2 / (1 + Math.sin(LAT0) * Math.sin(p) + Math.cos(LAT0) * Math.cos(p) * Math.cos(l - LON0)));
  return [k * Math.cos(p) * Math.sin(l - LON0), -k * (Math.cos(LAT0) * Math.sin(p) - Math.sin(LAT0) * Math.cos(p) * Math.cos(l - LON0))];
}
// Rahmen der Karte aus den Ecken/Kanten des Ausschnitts bestimmen
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (let lon = BOX.w; lon <= BOX.e; lon += 1) for (const lat of [BOX.s, BOX.n, (BOX.s + BOX.n) / 2]) {
  const [x, y] = laea(lon, lat); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
}
// sichtbarer Bereich etwas enger (die Ecken der Projektion sind leer)
const padX = (maxX - minX) * .06, padY = (maxY - minY) * .03;
minX += padX; maxX -= padX; minY += padY; maxY -= padY * 2;
const W = 1000, H = Math.round(W * (maxY - minY) / (maxX - minX));
const proj = ([lon, lat]) => { const [x, y] = laea(lon, lat); return [(x - minX) / (maxX - minX) * W, (y - minY) / (maxY - minY) * H]; };

/* ---------- Hilfen: Zuschneiden (lon/lat-Rechteck), Vereinfachen, Pfade ---------- */
function clipRing(ring){                             // Sutherland-Hodgman gegen BOX (etwas größer)
  const b = { w:BOX.w - 4, e:BOX.e + 4, s:BOX.s - 4, n:BOX.n + 4 };
  const edges = [
    [p => p[0] >= b.w, (a, c) => [b.w, a[1] + (c[1] - a[1]) * (b.w - a[0]) / (c[0] - a[0])]],
    [p => p[0] <= b.e, (a, c) => [b.e, a[1] + (c[1] - a[1]) * (b.e - a[0]) / (c[0] - a[0])]],
    [p => p[1] >= b.s, (a, c) => [a[0] + (c[0] - a[0]) * (b.s - a[1]) / (c[1] - a[1]), b.s]],
    [p => p[1] <= b.n, (a, c) => [a[0] + (c[0] - a[0]) * (b.n - a[1]) / (c[1] - a[1]), b.n]],
  ];
  let out = ring;
  for (const [inside, cut] of edges){
    const inp = out; out = [];
    if (!inp.length) break;
    let prev = inp[inp.length - 1];
    for (const cur of inp){
      if (inside(cur)){ if (!inside(prev)) out.push(cut(prev, cur)); out.push(cur); }
      else if (inside(prev)) out.push(cut(prev, cur));
      prev = cur;
    }
  }
  return out;
}
function simplify(pts, tol){                         // Douglas-Peucker
  if (pts.length < 3) return pts;
  // geschlossene Ringe (Anfang = Ende) in zwei Hälften teilen, sonst ist der Abstand zur „Strecke“ immer 0
  const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
  if (fx === lx && fy === ly && pts.length > 4){ const mid = pts.length >> 1; return [...simplify(pts.slice(0, mid + 1), tol), ...simplify(pts.slice(mid), tol).slice(1)]; }
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length){
    const [a, b] = stack.pop(); let idx = -1, max = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++){ const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len; if (d > max){ max = d; idx = i; } }
    if (idx > 0){ keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const r1 = v => Math.round(v * 10) / 10;
const ringsOf = g => g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
const linesOf = g => g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
function polyRings(features, tol = .6, minArea = 2){
  const rings = [];
  for (const f of features) for (const ring of ringsOf(f.geometry)){
    const c = clipRing(ring); if (c.length < 3) continue;
    const p = simplify(c.map(proj), tol).map(([x, y]) => [r1(x), r1(y)]);
    let area = 0; for (let i = 0; i < p.length; i++){ const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; area += x1 * y2 - x2 * y1; }
    if (p.length >= 3 && Math.abs(area / 2) >= minArea) rings.push(p);
  }
  return rings;
}
function lineParts(features, tol = .5){
  const parts = [];
  for (const f of features) for (const line of linesOf(f.geometry)){
    const inside = line.filter(([x, y]) => x > BOX.w - 2 && x < BOX.e + 2 && y > BOX.s - 2 && y < BOX.n + 2);
    if (inside.length < 2) continue;
    parts.push(simplify(inside.map(proj), tol).map(([x, y]) => [r1(x), r1(y)]));
  }
  return parts;
}
const dPoly = rings => rings.map(r => 'M' + r.map(p => p.join(' ')).join('L') + 'Z').join('');
const dLine = parts => parts.map(r => 'M' + r.map(p => p.join(' ')).join('L')).join('');

/* ---------- Grundkarte ---------- */
const land = polyRings(load('ne_50m_land'), .5, 1.5);
const borders = lineParts(load('ne_50m_admin_0_boundary_lines_land'), .6);

/* ---------- Ziele (was im Test abgefragt wird) ---------- */
const marine = load('ne_10m_geography_marine_polys'), regions = load('ne_10m_geography_regions_polys');
const rivers = load('ne_10m_rivers_lake_centerlines'), lakes = load('ne_10m_lakes');
const byName = (list, names, key = 'name') => list.filter(f => names.includes(f.properties[key]));
const T = {};   // id → { kind:'area'|'line'|'point', rings/parts/pt }
const area = (id, feats, tol) => { const rings = polyRings(feats, tol || .8, .5); if (!rings.length) throw new Error('leer: ' + id); T[id] = { kind:'area', rings }; };
const line = (id, feats) => { const parts = lineParts(feats, .4); if (!parts.length) throw new Error('leer: ' + id); T[id] = { kind:'line', parts }; };
const point = (id, lon, lat) => { T[id] = { kind:'point', pt:proj([lon, lat]).map(r1) }; };

// Meere (mit Nebenmeeren/Buchten, damit ein Tipp dorthin auch zählt)
area('atlantik', byName(marine, ['North Atlantic Ocean','Bay of Biscay','Norwegian Sea','Irish Sea','Bristol Channel','Inner Seas','English Channel','Denmark Strait']), 1.2);
area('nordsee', byName(marine, ['North Sea','Skagerrak','Waddenzee']));
area('ostsee', byName(marine, ['Baltic Sea','Gulf of Finland','Gulf of Bothnia','Gulf of Riga','Kattegat','Øresund','Mecklenburger Bucht']));
area('schwarzesmeer', byName(marine, ['Black Sea','Sea of Azov']));
area('mittelmeer', byName(marine, ['Mediterranean Sea','Tyrrhenian Sea','Adriatic Sea','Ionian Sea','Aegean Sea','Balearic Sea','Ligurian Sea','Alboran Sea','Sea of Crete','Gulf of Sidra','Gulf of Gabès','Golfe du Lion']), 1);
area('kaspisches', byName(marine, ['Caspian Sea','Garabogaz Bay']));
// Inseln
const R = n => byName(regions, [n], 'NAME');
area('island', R('ICELAND')); area('irland', R('IRELAND')); area('zypern', R('Cyprus')); area('kreta', R('Crete'));
area('sizilien', R('Sicilia')); area('sardinien', R('Sardegna')); area('korsika', R('Corse')); area('balearen', R('Balearic Islands'));
// Halbinseln (Apenninhalbinsel gibt es nicht als Fläche: selbst nachgezeichnet, lon/lat)
area('iberisch', R('PENÍNSULA IBÉRICA')); area('skandinavisch', R('SCANDINAVIA')); area('kola', R('KOLA PENINSULA')); area('balkan', R('BALKAN PEN.'));
area('apennin', [{ geometry:{ type:'Polygon', coordinates:[[[7.6,44.1],[9.5,44.4],[12.3,44.6],[13.6,43.6],[16.1,41.9],[18.6,40.3],[17.9,39.9],[16.6,38.4],[15.6,37.9],[15.6,40.1],[13.8,41.1],[12.2,41.8],[10.5,42.9],[10.1,44.0],[8.2,43.8],[7.6,44.1]]] } }]);
// Gebirge (werden auch gezeichnet)
area('pyrenaeen', R('PYRENEES')); area('alpen', R('ALPS')); area('karpaten', [...R('CARPATHIAN MOUNTAINS'), ...R('Transylvanian Alps')]);
area('skanden', R('KJØLEN MOUNTAINS')); area('uralgebirge', R('URAL MOUNTAINS')); area('apenninen', R('APPENNINI')); area('kaukasus', R('CAUCASUS MTS.'));
// Flüsse und Seen
const RV = (...names) => rivers.filter(f => names.includes(f.properties.name) || names.includes(f.properties.name_en));
line('ebro', RV('Ebro')); line('rhone', RV('Rhône')); line('po', RV('Po')); line('loire', RV('Loire')); line('themse', RV('Thames'));
line('rhein', RV('Rhein','Rhin','Rhine')); line('elbe', RV('Elbe')); line('oder', RV('Oder')); line('weichsel', RV('Vistula'));
line('donau', RV('Danube','Donau')); line('dnipro', RV('Dnipro','Dnieper')); line('wolga', RV('Volga')); line('ural', RV('Ural'));
area('ladoga', byName(lakes, ['Lake Ladoga'])); area('onega', byName(lakes, ['Lake Onega']));
// Städte
point('madrid', -3.70, 40.42); point('london', -0.13, 51.51); point('paris', 2.35, 48.86); point('berlin', 13.40, 52.52);
point('rom', 12.50, 41.90); point('wien', 16.37, 48.21); point('budapest', 19.04, 47.50); point('athen', 23.73, 37.98);
point('istanbul', 28.98, 41.01); point('moskau', 37.62, 55.76); point('stockholm', 18.07, 59.33);

/* ---------- Ausgabe ---------- */
const out = {
  w:W, h:H,
  land:dPoly(land), borders:dLine(borders),
  lakes:dPoly([...T.ladoga.rings, ...T.onega.rings, ...T.kaspisches.rings]),
  mountains:['pyrenaeen','alpen','karpaten','skanden','uralgebirge','apenninen','kaukasus'].map(id => dPoly(T[id].rings)).join(''),
  rivers:['ebro','rhone','po','loire','themse','rhein','elbe','oder','weichsel','donau','dnipro','wolga','ural'].map(id => dLine(T[id].parts)).join(''),
  targets:Object.fromEntries(Object.entries(T).map(([id, t]) => [id, t.kind === 'area' ? { k:'a', r:t.rings } : t.kind === 'line' ? { k:'l', p:t.parts } : { k:'p', pt:t.pt }])),
};
const file = path.join(__dirname, '..', 'geo-data.js');
fs.writeFileSync(file, '// Automatisch erzeugt von tools/build-geo-data.js aus Natural-Earth-Daten (gemeinfrei). Nicht von Hand ändern.\nconst GEO = ' + JSON.stringify(out) + ';\n');
console.log(`geo-data.js: ${W}×${H}, ${(fs.statSync(file).size / 1024).toFixed(0)} KB, Ziele: ${Object.keys(T).length}`);
