// Photo storage.
//  - Supabase Storage when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
//    (required on Vercel, whose disk is temporary). Files go into a public bucket
//    and the database stores their public URL.
//  - Otherwise the local disk (DATA_DIR/uploads), served at /uploads/<file>.
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./db');

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'lionheart-uploads';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');

const useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);
if (!useSupabase && process.env.VERCEL) {
  console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set: photo uploads will not be kept on Vercel.');
}
if (!useSupabase) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

let client;
let bucketReady;
function supabase() {
  if (!client) {
    const { createClient } = require('@supabase/supabase-js');
    client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

// Creates the public bucket the first time it is needed.
function ensureBucket() {
  if (!bucketReady) {
    bucketReady = (async () => {
      const { data } = await supabase().storage.getBucket(BUCKET);
      if (data) return;
      const { error } = await supabase().storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: '10MB',
        allowedMimeTypes: Object.keys(EXT),
      });
      if (error && !/already exists/i.test(error.message)) throw error;
    })().catch((err) => {
      bucketReady = null;
      throw err;
    });
  }
  return bucketReady;
}

function newName(mimetype) {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${EXT[mimetype] || ''}`;
}

// Saves an uploaded image (multer memory file) and returns what to store in the
// database: a public URL (Supabase) or a bare file name (local disk).
async function saveImage(file, folder = 'products') {
  const name = newName(file.mimetype);
  if (useSupabase) {
    await ensureBucket();
    const objectPath = `${folder}/${name}`;
    const { error } = await supabase().storage.from(BUCKET).upload(objectPath, file.buffer, {
      contentType: file.mimetype,
      cacheControl: '31536000',
      upsert: false,
    });
    if (error) throw new Error(`Photo upload failed: ${error.message}`);
    return supabase().storage.from(BUCKET).getPublicUrl(objectPath).data.publicUrl;
  }
  await fs.promises.writeFile(path.join(UPLOAD_DIR, name), file.buffer);
  return name;
}

async function saveImages(files, folder) {
  return Promise.all((files || []).map((f) => saveImage(f, folder)));
}

// Deletes a stored image; failures are ignored (the record is already gone).
async function removeImage(stored) {
  if (!stored) return;
  try {
    if (/^https?:\/\//.test(stored)) {
      const marker = `/storage/v1/object/public/${BUCKET}/`;
      const i = stored.indexOf(marker);
      if (useSupabase && i !== -1) await supabase().storage.from(BUCKET).remove([decodeURIComponent(stored.slice(i + marker.length))]);
      return;
    }
    await fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(stored)));
  } catch {
    /* ignore */
  }
}

// URL for an image stored either way.
function imageUrl(stored) {
  if (!stored) return '';
  return /^https?:\/\//.test(stored) ? stored : `/uploads/${encodeURIComponent(stored)}`;
}

module.exports = {
  saveImage,
  saveImages,
  removeImage,
  imageUrl,
  UPLOAD_DIR,
  useSupabase,
  storageOrigin: useSupabase ? new URL(SUPABASE_URL).origin : '',
  BUCKET,
};
