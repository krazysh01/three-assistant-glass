const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = 3000;

// Serve static files from the current directory
app.use(express.static(__dirname));

// Serve index.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// New route to get animation files
app.get('/animations', (req, res) => {
  const animationsDir = path.join(__dirname, 'animations');
  fs.readdir(animationsDir, (err, files) => {
    if (err) {
      console.error('Error reading animations directory:', err);
      res.status(500).json({ error: 'Unable to read animations directory' });
    } else {
      const fbxFiles = files.filter(file => file.endsWith('.fbx'));
      res.json(fbxFiles);
    }
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});