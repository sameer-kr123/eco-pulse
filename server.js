require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

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

// AI Community Waste Report (Auto-Drafting & Severity Analysis)
app.post('/api/reports', async (req, res) => {
  try {
    const { lat, lng, location, description, imageBase64 } = req.body;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing location coordinates.' });
    }

    let severity = "Moderate Waste";
    let complaintDraft = `Official Waste Clearance Request:\nLocation: ${location || 'Coordinates ' + lat + ', ' + lng}\nDetails: ${description || 'Illegal garbage accumulation reported.'}\nPlease take prompt action to clear this hotspot.`;

    // If an image or description is provided, use Gemini to classify and draft an official complaint
    if (imageBase64 || description) {
      const prompt = `You are a municipal civic assistant. Analyze this reported garbage hotspot (Description: "${description || 'None'}") and generate a JSON response matching:
{
  "severity": "High Biohazard" | "Plastic Accumulation" | "Drainage Blockage" | "General Litter",
  "complaint_draft": "A professional, polite 2-sentence complaint addressed to municipal sanitation authorities requesting quick clearance with the coordinates (${lat}, ${lng})."
}
Return ONLY valid JSON.`;

      let parts = [prompt];
      if (imageBase64) {
        parts.push({
          inlineData: {
            data: imageBase64,
            mimeType: "image/jpeg"
          }
        });
      }

      const result = await model.generateContent(parts);
      const response = await result.response;
      
      let rawText = response.text().trim();
      if (rawText.startsWith('```json')) {
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      } else if (rawText.startsWith('```')) {
        rawText = rawText.replace(/```/g, '').trim();
      }

      const parsed = JSON.parse(rawText);
      severity = parsed.severity || severity;
      complaintDraft = parsed.complaint_draft || complaintDraft;
    }

    db.run(
      'INSERT INTO reports (lat, lng, location, description) VALUES (?, ?, ?, ?)',
      [lat, lng, location || `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`, `${severity} - ${description || 'Hotspot reported'}`],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE profile SET xp = xp + 30 WHERE id = 1');
        res.json({
          id: this.lastID,
          success: true,
          severity,
          complaintDraft,
          lat,
          lng
        });
      }
    );
  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ error: error.message || 'Failed to submit report' });
  }
});// AI Community Waste Report (Auto-Drafting & Severity Analysis)
app.post('/api/reports', async (req, res) => {
  try {
    const { lat, lng, location, description, imageBase64 } = req.body;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing location coordinates.' });
    }

    let severity = "Moderate Waste";
    let complaintDraft = `Official Waste Clearance Request:\nLocation: ${location || 'Coordinates ' + lat + ', ' + lng}\nDetails: ${description || 'Illegal garbage accumulation reported.'}\nPlease take prompt action to clear this hotspot.`;

    // If an image or description is provided, use Gemini to classify and draft an official complaint
    if (imageBase64 || description) {
      const prompt = `You are a municipal civic assistant. Analyze this reported garbage hotspot (Description: "${description || 'None'}") and generate a JSON response matching:
{
  "severity": "High Biohazard" | "Plastic Accumulation" | "Drainage Blockage" | "General Litter",
  "complaint_draft": "A professional, polite 2-sentence complaint addressed to municipal sanitation authorities requesting quick clearance with the coordinates (${lat}, ${lng})."
}
Return ONLY valid JSON.`;

      let parts = [prompt];
      if (imageBase64) {
        parts.push({
          inlineData: {
            data: imageBase64,
            mimeType: "image/jpeg"
          }
        });
      }

      const result = await model.generateContent(parts);
      const response = await result.response;
      
      let rawText = response.text().trim();
      if (rawText.startsWith('```json')) {
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      } else if (rawText.startsWith('```')) {
        rawText = rawText.replace(/```/g, '').trim();
      }

      const parsed = JSON.parse(rawText);
      severity = parsed.severity || severity;
      complaintDraft = parsed.complaint_draft || complaintDraft;
    }

    db.run(
      'INSERT INTO reports (lat, lng, location, description) VALUES (?, ?, ?, ?)',
      [lat, lng, location || `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`, `${severity} - ${description || 'Hotspot reported'}`],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE profile SET xp = xp + 30 WHERE id = 1');
        res.json({
          id: this.lastID,
          success: true,
          severity,
          complaintDraft,
          lat,
          lng
        });
      }
    );
  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ error: error.message || 'Failed to submit report' });
  }
});
// AI Waste Scanner (Structured 3-Second Bin Output)
app.post('/api/ai/scan-waste', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const prompt = `Analyze this waste/item image. Return ONLY a valid JSON object matching this exact schema:
{
  "item_name": "Short name of item",
  "bin_type": "Blue (Dry/Recycle)" | "Green (Organic/Wet)" | "Red (Hazardous/E-Waste)" | "Black (Landfill)",
  "bin_color": "blue" | "green" | "red" | "black",
  "prep_tip": "One short sentence on what to do before throwing (e.g., Rinse residue, crush flat, remove cap)",
  "recyclable": true | false
}
Do not include markdown fences or any other text outside the JSON.`;

    const imagePart = {
      inlineData: {
        data: imageBase64,
        mimeType: "image/jpeg"
      }
    };

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    
    // Clean up potential markdown formatting in response text
    let rawText = response.text().trim();
    if (rawText.startsWith('```json')) {
      rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    } else if (rawText.startsWith('```')) {
      rawText = rawText.replace(/```/g, '').trim();
    }

    const parsedData = JSON.parse(rawText);

    db.run('UPDATE profile SET xp = xp + 25, waste_kg = waste_kg + 1 WHERE id = 1');
    res.json(parsedData);
  } catch (error) {
    console.error("Waste Scan Error:", error);
    res.status(500).json({ error: error.message || 'Failed to analyze item' });
  }
});

// AI Food Rescue (Structured Zero-Waste Recipe Output)
app.post('/api/ai/food-rescue', async (req, res) => {
  try {
    const { ingredients, imageBase64 } = req.body;
    let parts = [];

    const prompt = `You are a zero-waste chef. Analyze the provided ingredients or image. Return ONLY a valid JSON object matching this exact schema:
{
  "recipe_name": "Appealing, simple recipe name",
  "cook_time": "e.g., 15 mins",
  "difficulty": "Easy" | "Medium",
  "eat_first_warning": "Name 1 ingredient that spoils fastest and needs to be used immediately",
  "ingredients_used": ["List of main ingredients"],
  "substitutions": "1 quick pantry swap tip if they are missing common seasoning/oil",
  "instructions": [
    "Step 1: Prep and chop...",
    "Step 2: Cook...",
    "Step 3: Garnish and serve..."
  ]
}
Keep steps ultra-simple and focused on saving food from going to waste. Do not include markdown fences or any text outside JSON.`;

    if (imageBase64) {
      parts.push(prompt);
      parts.push({
        inlineData: {
          data: imageBase64,
          mimeType: "image/jpeg"
        }
      });
    } else if (ingredients) {
      parts.push(`${prompt}\n\nAvailable Ingredients: ${ingredients}`);
    } else {
      return res.status(400).json({ error: 'Please enter ingredients or scan food items.' });
    }

    const result = await model.generateContent(parts);
    const response = await result.response;

    let rawText = response.text().trim();
    if (rawText.startsWith('```json')) {
      rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    } else if (rawText.startsWith('```')) {
      rawText = rawText.replace(/```/g, '').trim();
    }

    const parsedRecipe = JSON.parse(rawText);

    db.run('UPDATE profile SET xp = xp + 15 WHERE id = 1');
    res.json(parsedRecipe);
  } catch (error) {
    console.error("Food Rescue Error:", error);
    res.status(500).json({ error: error.message || 'Failed to generate recipe' });
  }
});

// Complete a Daily Micro-Habit Quest
app.post('/api/profile/quest', (req, res) => {
  db.run('UPDATE profile SET xp = xp + 10, streak_days = streak_days + 1 WHERE id = 1', function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Habit completed! +10 XP' });
  });
});

app.listen(PORT, () => {
  console.log(`EcoPulse Server running on port ${PORT}`);
});