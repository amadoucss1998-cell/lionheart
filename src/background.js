// Work that should finish after the response is sent (e.g. staff alerts).
// On Vercel the function would otherwise be frozen once it responds, so the
// promise is handed to waitUntil(); elsewhere the process simply keeps running.
function runInBackground(promise) {
  const guarded = Promise.resolve(promise).catch((err) => console.error('[background]', err));
  if (process.env.VERCEL) {
    try {
      require('@vercel/functions').waitUntil(guarded);
    } catch (err) {
      console.error('[background] waitUntil unavailable', err.message);
    }
  }
  return guarded;
}

module.exports = { runInBackground };
