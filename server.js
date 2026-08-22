require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
const MODEL_NAME = 'gemini-3.6-flash';

app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./data.db');

db.serialize(() => {
  // Profile Table
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

  // Quests Table
  db.run(`
    CREATE TABLE IF NOT EXISTS quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      xp_reward INTEGER,
      completed INTEGER DEFAULT 0
    )
  `);

  // Waste Reports Table (New)
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

  // Seed default data
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

// Dashboard Data
app.get('/api/dashboard', (req, res) => {
  db.get('SELECT * FROM profile WHERE id = 1', (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM quests', (err, quests) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ user, quests });
    });
  });
});

// Toggle Quest XP
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

// Get All Saved Map Reports
app.get('/api/reports', (req, res) => {
  db.all('SELECT * FROM reports ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Save New Waste Report to DB
app.post('/api/reports', (req, res) => {
  const { lat, lng, location, description } = req.body;
  if (!lat || !lng || !description) {
    return res.status(400).json({ error: 'Missing coordinates or description.' });
  }

  const sql = 'INSERT INTO reports (lat, lng, location, description) VALUES (?, ?, ?, ?)';
  db.run(sql, [lat, lng, location, description], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    // Reward user +30 XP for reporting
    db.run('UPDATE profile SET xp = xp + 30 WHERE id = 1');
    res.json({ id: this.lastID, success: true });
  });
});

// AI Waste Scanner
app.post('/api/ai/scan-waste', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [
        {
          parts: [
            { text: "Analyze this item in 3 short bullet points: 1. Material name 2. Is it recyclable? (Yes/No) 3. Exactly how to dispose/recycle it. Keep it concise." },
            { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }
          ]
        }
      ]
    });

    db.run('UPDATE profile SET xp = xp + 25, waste_kg = waste_kg + 1 WHERE id = 1');
    res.json({ result: response.text });
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
      parts.push({ text: "Look at this food image, identify visible ingredients, and generate 1 zero-waste recipe with: 1. Recipe Name 2. Cooking Time 3. 3-step Instructions." });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
    } else if (ingredients) {
      parts.push({ text: `I have these leftover ingredients: "${ingredients}". Suggest 1 quick, zero-waste recipe with: Recipe Name, Cooking Time, and 3 Simple Steps.` });
    } else {
      return res.status(400).json({ error: 'Please enter ingredients or scan an image of food.' });
    }

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ parts }]
    });

    db.run('UPDATE profile SET xp = xp + 15 WHERE id = 1');
    res.json({ recipe: response.text });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`EcoPulse Server running at http://localhost:${PORT}`);
});