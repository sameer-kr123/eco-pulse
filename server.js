require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./data.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY,
      name TEXT,
      streak INTEGER DEFAULT 5,
      xp INTEGER DEFAULT 350,
      xp_max INTEGER DEFAULT 500,
      level TEXT DEFAULT 'Level 3 Warrior',
      co2_kg INTEGER DEFAULT 42,
      water_l TEXT DEFAULT '1.2k',
      waste_kg INTEGER DEFAULT 15
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      xp_reward INTEGER,
      completed INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lat REAL,
      lng REAL,
      location TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.get('SELECT COUNT(*) as count FROM profile', (err, row) => {
    if (row && row.count === 0) {
      db.run('INSERT INTO profile (id, name) VALUES (1, "Nikhil")');
    }
  });

  db.get('SELECT COUNT(*) as count FROM quests', (err, row) => {
    if (row && row.count === 0) {
      db.run('INSERT INTO quests (title, xp_reward) VALUES ("Used a reusable bag", 10)');
      db.run('INSERT INTO quests (title, xp_reward) VALUES ("Plant-based meal today", 15)');
      db.run('INSERT INTO quests (title, xp_reward) VALUES ("Turned off AC for 2 hours", 10)');
    }
  });
});

app.get('/api/dashboard', (req, res) => {
  db.get('SELECT * FROM profile WHERE id = 1', (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM quests', (err, quests) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ user, quests });
    });
  });
});

app.post('/api/quests/toggle', (req, res) => {
  const { questId, completed } = req.body;
  const isDone = completed ? 1 : 0;

  db.get('SELECT xp_reward FROM quests WHERE id = ?', [questId], (err, quest) => {
    if (!quest) return res.status(404).json({ error: 'Quest not found' });
    db.run('UPDATE quests SET completed = ? WHERE id = ?', [isDone, questId], () => {
      const xpChange = isDone ? quest.xp_reward : -quest.xp_reward;
      db.run('UPDATE profile SET xp = xp + ? WHERE id = 1', [xpChange], () => {
        res.json({ success: true });
      });
    });
  });
});

app.get('/api/reports', (req, res) => {
  db.all('SELECT * FROM reports ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/reports', (req, res) => {
  const { lat, lng, location, description } = req.body;
  if (!lat || !lng || !description) {
    return res.status(400).json({ error: 'Missing coordinates or description.' });
  }

  db.run('INSERT INTO reports (lat, lng, location, description) VALUES (?, ?, ?, ?)', [lat, lng, location, description], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    db.run('UPDATE profile SET xp = xp + 30 WHERE id = 1');
    res.json({ id: this.lastID, success: true });
  });
});

// AI Waste Scanner
app.post('/api/ai/scan-waste', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const prompt = "Analyze this item in 3 short bullet points: 1. Material name 2. Is it recyclable? (Yes/No) 3. Exactly how to dispose/recycle it. Keep it concise.";
    const imagePart = {
      inlineData: {
        data: imageBase64,
        mimeType: "image/jpeg"
      }
    };

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;

    db.run('UPDATE profile SET xp = xp + 25, waste_kg = waste_kg + 1 WHERE id = 1');
    res.json({ result: response.text() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI Food Rescue
app.post('/api/ai/food-rescue', async (req, res) => {
  try {
    const { ingredients, imageBase64 } = req.body;
    let parts = [];

    if (imageBase64) {
      parts.push("Look at this food image, identify visible ingredients, and generate 1 zero-waste recipe with: 1. Recipe Name 2. Cooking Time 3. 3-step Instructions.");
      parts.push({
        inlineData: {
          data: imageBase64,
          mimeType: "image/jpeg"
        }
      });
    } else if (ingredients) {
      parts.push(`I have these leftover ingredients: "${ingredients}". Suggest 1 quick, zero-waste recipe with: Recipe Name, Cooking Time, and 3 Simple Steps.`);
    } else {
      return res.status(400).json({ error: 'Please enter ingredients or scan an image of food.' });
    }

    const result = await model.generateContent(parts);
    const response = await result.response;

    db.run('UPDATE profile SET xp = xp + 15 WHERE id = 1');
    res.json({ recipe: response.text() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`EcoPulse Server running on port ${PORT}`);
});