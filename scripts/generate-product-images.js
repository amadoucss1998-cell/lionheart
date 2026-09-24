// Generates a product photo for each sample product with Google's Gemini
// image model and saves it as public/static/products/<sku>.jpg (1200×900).
// The app attaches these to the matching products automatically.
//
//   GEMINI_API_KEY=… node scripts/generate-product-images.js            # only missing photos
//   GEMINI_API_KEY=… node scripts/generate-product-images.js --force    # regenerate all
//   GEMINI_API_KEY=… node scripts/generate-product-images.js RF-DECRA-BD TL-6060-P
//
// Needs a Gemini API key with billing enabled (image models have no free quota).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PRODUCTS } = require('../src/seed');

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const OUT = path.join(__dirname, '..', 'public', 'static', 'products');

const STYLE =
  'Professional e-commerce catalogue photograph, realistic, sharp focus, soft even studio lighting, ' +
  'clean light grey seamless background, product centred with some space around it. ' +
  'No text, no logos, no brand badges, no watermark, no people.';

// What each product should look like (kept close to the listing).
const SUBJECTS = {
  'EL-PH-001': 'a modern black Android smartphone with a large 6.7 inch edge-to-edge screen, shown front and back side by side, triple camera module visible',
  'EL-TV-055': 'a 55 inch slim 4K smart LED television on a slim stand, screen showing a colourful landscape',
  'EL-AC-18K': 'a white wall-mounted split air conditioner indoor unit with its matching outdoor compressor unit beside it',
  'MC-BLK-415': 'an industrial automatic concrete block making machine (QT4-15 type) painted yellow and blue, with a stack of grey hollow concrete blocks in front, in a factory yard',
  'MC-GEN-100': 'a 100 kVA silent diesel generator in a soundproof steel canopy, dark blue, on a skid base',
  'HE-EXC-20T': 'a yellow 20-ton crawler excavator with the bucket lowered, on a light gravel surface, three-quarter view',
  'HE-WL-5T': 'a yellow 5-ton front wheel loader with a large bucket, three-quarter front view',
  'HE-HOWO-371': 'a heavy-duty 6x4 tipper dump truck with a red cab and a large steel dump body, three-quarter front view',
  'VH-PRADO-19': 'a white full-size 4x4 SUV in the style of a Land Cruiser Prado, clean and glossy, three-quarter front view',
  'VH-PU-4X4': 'a silver double cabin 4x4 pickup truck, three-quarter front view',
  'FN-SOFA-L7': 'a large modern grey fabric L-shaped sectional sofa with cushions, seating for seven',
  'FN-DESK-EX': 'an executive office desk in walnut wood finish with a side return cabinet and drawers',
  'BM-REB-400': 'bundles of deformed steel reinforcing bars (rebar) stacked in a warehouse, ribbed texture visible',
  'BM-PLY-18': 'a neat stack of 18mm marine plywood sheets with dark brown film-faced surface, edges showing wood layers',
  'TL-6060-P': 'glossy polished 60x60 cm porcelain floor tiles with a light marble pattern, a few tiles fanned out, reflecting light',
  'TL-3060-W': 'rectangular 30x60 cm ceramic wall tiles in soft white and grey, some leaning upright, clean modern look',
  'SW-WC-1P': 'a white one-piece ceramic toilet with a soft-close seat, three-quarter view',
  'SW-VAN-80': 'an 80 cm bathroom vanity cabinet with a white ceramic basin, chrome faucet and a rectangular mirror above',
  'RF-DECRA-BD': 'several terracotta-red stone-coated steel roofing tile sheets (Decra style), stacked with one angled to show the textured granule surface',
  'RF-ZINC-03': 'a stack of silver galvanized corrugated zinc roofing sheets, wavy profile clearly visible',
  'DW-SEC-96': 'a dark brown steel security front door with its frame, decorative panels and a multi-point lock handle, standing upright',
  'DW-ALU-SL': 'a white aluminium sliding window with two glass panels and a fitted mosquito net, standing upright',
  'ES-PV-550': 'a large monocrystalline solar panel with black half-cut cells and a silver aluminium frame, tilted slightly',
  'ES-HYB-10': 'a white hybrid solar inverter unit next to a stack of lithium battery modules, home energy storage system',
};

async function generate(sku, subject) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${STYLE} Subject: ${subject}.` }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:3' } },
    }),
    signal: AbortSignal.timeout(180000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error?.message?.split('\n')[0] || 'error'}`);
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error('no image returned');
  const file = path.join(OUT, `${sku.toLowerCase()}.jpg`);
  await sharp(Buffer.from(part.inlineData.data, 'base64'))
    .resize(1200, 900, { fit: 'cover' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(file);
  return file;
}

(async () => {
  if (!KEY) {
    console.error('Set GEMINI_API_KEY first.');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.filter((a) => !a.startsWith('--'));
  const skus = PRODUCTS.map((p) => p[2]).filter((sku) => !only.length || only.includes(sku));
  let failed = 0;
  for (const sku of skus) {
    const file = path.join(OUT, `${sku.toLowerCase()}.jpg`);
    if (!force && !only.length && fs.existsSync(file)) continue;
    try {
      const out = await generate(sku, SUBJECTS[sku]);
      console.log(`✓ ${sku}  ${Math.round(fs.statSync(out).size / 1024)} KB`);
    } catch (err) {
      failed++;
      console.error(`✗ ${sku}  ${err.message}`);
      if (/HTTP 4(01|03|29)/.test(err.message)) break; // key/quota problem: stop early
    }
  }
  process.exit(failed ? 1 : 0);
})();
