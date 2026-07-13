const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// Serve everything in this directory as static files
app.use(express.static(path.join(__dirname), {
  // Let service worker and manifest be fetched without caching headers
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// SPA fallback — send index.html for any unknown route
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Karpathos Grid Tool running on port ${PORT}`);
});
