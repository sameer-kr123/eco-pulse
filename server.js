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
  // 1. Profile Table
  db.run(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY,
      name TEXT DEFAULT 'Nikhil',
      streak INTEGER DEFAULT 0,
      xp INTEGER DEFAULT 0,
      xp_max INTEGER DEFAULT 100,
      level TEXT DEFAULT 'Level 1 - 🌱 Eco Rookie',
      co2_kg INTEGER DEFAULT 0,
      water_l TEXT DEFAULT '0',
      waste_kg INTEGER DEFAULT 0,
      last_active_date TEXT DEFAULT ''
    )
  `);

  // Safe initial seed for user
  db.run(`
    INSERT OR IGNORE INTO profile (id, name, streak, xp, xp_max, level, co2_kg, water_l, waste_kg, last_active_date) 
    VALUES (1, 'Nikhil', 0, 0, 100, 'Level 1 - 🌱 Eco Rookie', 0, '0', 0, '')
  `);

 // 2. Quests Table
  db.run(`
    CREATE TABLE IF NOT EXISTS quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      xp_reward INTEGER,
      completed INTEGER DEFAULT 0,
      last_completed_date TEXT DEFAULT ''
    )
  `);

  // Ensure column exists for existing DBs
  db.run(`ALTER TABLE quests ADD COLUMN last_completed_date TEXT DEFAULT ''`, () => {});

  // Safe seed for initial quests
  db.run(`INSERT OR IGNORE INTO quests (id, title, xp_reward, completed, last_completed_date) VALUES (1, 'Brought a Reusable Bag', 15, 0, '')`);
  db.run(`INSERT OR IGNORE INTO quests (id, title, xp_reward, completed, last_completed_date) VALUES (2, 'Zero Leftover Meal', 20, 0, '')`);
  db.run(`INSERT OR IGNORE INTO quests (id, title, xp_reward, completed, last_completed_date) VALUES (3, 'Walk / Cycle Short Trips', 25, 0, '')`);
  // 3. Reports Table
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
});
// Evaluate Streak Status, Expiration, and Multipliers
function evaluateStreak(profile) {
  if (!profile || !profile.last_active_date) {
    return { streak: 0, multiplier: 1.0, diffDays: 999 };
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const lastDate = new Date(profile.last_active_date);
  const today = new Date(todayStr);
  const diffDays = Math.round((today - lastDate) / (1000 * 60 * 60 * 24));

  let currentStreak = profile.streak || 0;

  // Streak resets to 0 if more than 1 day missed
  if (diffDays > 1) {
    currentStreak = 0;
  }

  // Calculate XP Multiplier
  let multiplier = 1.0;
  if (currentStreak >= 14) multiplier = 2.0;
  else if (currentStreak >= 7) multiplier = 1.5;
  else if (currentStreak >= 3) multiplier = 1.2;

  return { streak: currentStreak, multiplier, diffDays };
}
app.get('/api/dashboard', (req, res) => {
  const todayStr = new Date().toISOString().split('T')[0];

  // Auto-refresh quests if last completed date is not today
  db.run(`UPDATE quests SET completed = 0 WHERE last_completed_date != ?`, [todayStr], () => {
    db.get('SELECT * FROM profile WHERE id = 1', (err, user) => {
      if (err) return res.status(500).json({ error: err.message });

      const streakData = evaluateStreak(user);

      // If streak expired while user was away, sync DB automatically
      const updateStreak = (streakData.streak !== user?.streak)
        ? new Promise((resolve) => db.run('UPDATE profile SET streak = ? WHERE id = 1', [streakData.streak], resolve))
        : Promise.resolve();

      updateStreak.then(() => {
        db.all('SELECT * FROM quests', (err, quests) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({
            user: { ...user, streak: streakData.streak, multiplier: streakData.multiplier },
            quests
          });
        });
      });
    });
  });
});

// Claim Quest, Increase XP & Manage Daily Streak
app.post('/api/quests/toggle', (req, res) => {
  const { questId, completed } = req.body;
  const isDone = completed ? 1 : 0;
  const todayStr = new Date().toISOString().split('T')[0];

  db.get('SELECT xp_reward, completed FROM quests WHERE id = ?', [questId], (err, quest) => {
    if (err) return res.status(500).json({ error: err.message });
    if (isDone && quest && quest.completed === 1) {
      return res.status(400).json({ error: 'Quest already claimed for today!' });
    }

    const rawXp = quest ? quest.xp_reward : (parseInt(req.body.xp, 10) || 15);

    db.get('SELECT xp, streak, last_active_date FROM profile WHERE id = 1', (err, profile) => {
      if (err) return res.status(500).json({ error: err.message });

      const streakData = evaluateStreak(profile);
      let newStreak = streakData.streak;

      if (isDone) {
        if (!profile?.last_active_date) {
          newStreak = 1;
        } else if (streakData.diffDays === 1) {
          newStreak += 1;
        } else if (streakData.diffDays > 1) {
          newStreak = 1;
        }
      }

      // Apply streak multiplier boost
      const earnedXp = Math.round(rawXp * streakData.multiplier);
      const xpChange = isDone ? earnedXp : -earnedXp;

      // 1. Update Profile (XP, Streak, Active Date)
      db.run(
        'UPDATE profile SET xp = MAX(0, xp + ?), streak = ?, last_active_date = ? WHERE id = 1',
        [xpChange, newStreak, todayStr],
        function (updateErr) {
          if (updateErr) return res.status(500).json({ error: updateErr.message });

          // 2. Mark Quest as Completed & Record Today's Date
          db.run(
            'UPDATE quests SET completed = ?, last_completed_date = ? WHERE id = ?',
            [isDone, isDone ? todayStr : '', questId],
            function (questErr) {
              if (questErr) return res.status(500).json({ error: questErr.message });

              db.get('SELECT * FROM profile WHERE id = 1', (fetchErr, updatedUser) => {
                if (fetchErr) return res.status(500).json({ error: fetchErr.message });
                res.json({ success: true, user: updatedUser, earnedXp, multiplier: streakData.multiplier });
              });
            }
          );
        }
      );
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
        
        // Award +30 XP, 3kg waste diverted, 8kg CO2 saved, and 300L water saved
        db.run(
          'UPDATE profile SET xp = xp + 30, waste_kg = waste_kg + 3, co2_kg = co2_kg + 8, water_l = CAST(COALESCE(water_l, 0) AS INTEGER) + 300 WHERE id = 1',
          function (updateErr) {
            if (updateErr) console.error('Profile update error:', updateErr);
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
  "recyclable": true
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
    
    // Clean up markdown formatting in response text
    let rawText = response.text().trim();
    if (rawText.startsWith('```json')) {
      rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    } else if (rawText.startsWith('```')) {
      rawText = rawText.replace(/```/g, '').trim();
    }

    const parsedData = JSON.parse(rawText);

    // Ensure database write completes before returning response to client
    db.run(
      'UPDATE profile SET xp = xp + 25, waste_kg = waste_kg + 1, co2_kg = co2_kg + 3, water_l = CAST(COALESCE(water_l, 0) AS INTEGER) + 120 WHERE id = 1',
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json(parsedData);
      }
    );
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

    db.run(
      'UPDATE profile SET xp = xp + 20, waste_kg = waste_kg + 1, co2_kg = co2_kg + 2, water_l = CAST(COALESCE(water_l, 0) AS INTEGER) + 250 WHERE id = 1',
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json(parsedRecipe);
      }
    );
  } catch (error) {
    console.error("Food Rescue Error:", error);
    res.status(500).json({ error: error.message || 'Failed to generate recipe' });
  }
});
// Update / Create Profile
app.post('/api/profile/update', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  db.run(
    'UPDATE profile SET name = ? WHERE id = 1',
    [name.trim()],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, name: name.trim() });
    }
  );
});
// Database seed for community leaderboard if table doesn't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    xp INTEGER,
    streak INTEGER,
    avatar TEXT
  )`);

  // Insert mock competitors if empty
  db.get("SELECT COUNT(*) as count FROM leaderboard", (err, row) => {
    if (row && row.count === 0) {
      db.run("INSERT INTO leaderboard (name, xp, streak, avatar) VALUES ('Aarav Sharma', 620, 12, 'A')");
      db.run("INSERT INTO leaderboard (name, xp, streak, avatar) VALUES ('Priya Patel', 410, 8, 'P')");
      db.run("INSERT INTO leaderboard (name, xp, streak, avatar) VALUES ('Rohan Verma', 280, 4, 'R')");
      db.run("INSERT INTO leaderboard (name, xp, streak, avatar) VALUES ('Ananya Iyer', 190, 3, 'A')");
    }
  });
});
// Get Live Community Leaderboard (Including You)
app.get('/api/leaderboard', (req, res) => {
  db.get('SELECT name, xp, streak FROM profile WHERE id = 1', (err, user) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all('SELECT name, xp, streak, avatar FROM leaderboard', (err, competitors) => {
      if (err) return res.status(500).json({ error: err.message });

      const userName = user?.name || 'You';
      const userInitial = userName.charAt(0).toUpperCase();

      const allUsers = [
        ...(competitors || []),
        { 
          name: userName, 
          xp: user?.xp || 0, 
          streak: user?.streak || 0, 
          isCurrent: true, 
          avatar: userInitial 
        }
      ];

      // Sort by highest XP descending
      allUsers.sort((a, b) => b.xp - a.xp);

      res.json(allUsers);
    });
  });
});

// Complete any Quest with Custom XP & Streak addition
app.post('/api/profile/quest', (req, res) => {
  const xpReward = parseInt(req.body.xp) || 15;
  db.run(
    'UPDATE profile SET xp = xp + ?, streak = streak + 1 WHERE id = 1',
    [xpReward],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM profile WHERE id = 1', (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, user: row, addedXp: xpReward });
      });
    }
  );
});
app.listen(PORT, () => {
  console.log(`EcoPulse Server running on port ${PORT}`);
});