// Copies the front-end libraries (GSAP) and web fonts into public/vendor so a CDN
// (e.g. Vercel's) can serve them as static files. Locally the app serves the
// same files straight from node_modules, so this step is optional there.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const copies = [
  ['node_modules/gsap/dist/gsap.min.js', 'public/vendor/gsap/gsap.min.js'],
  ['node_modules/gsap/dist/ScrollTrigger.min.js', 'public/vendor/gsap/ScrollTrigger.min.js'],
  ['node_modules/@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2', 'public/vendor/fonts/schibsted-grotesk-latin-wght-normal.woff2'],
  ['node_modules/@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-italic.woff2', 'public/vendor/fonts/schibsted-grotesk-latin-wght-italic.woff2'],
  ['node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'public/vendor/fonts/jetbrains-mono-latin-400-normal.woff2'],
  ['node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2', 'public/vendor/fonts/jetbrains-mono-latin-500-normal.woff2'],
];
for (const [from, to] of copies) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(root, to));
}
console.log(`Copied ${copies.length} front-end library files into public/vendor.`);
