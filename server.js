require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE, 10) || (25 * 1024 * 1024);
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_PATH = path.join(__dirname, 'database.db');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

let dbPromise = null;

async function getDb() {
    if (!db) {
        if (!dbPromise) dbPromise = initDatabase();
        await dbPromise;
    }
    return db;
}

// Middleware to ensure DB is initialized
app.use(async (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/download')) {
        try {
            await getDb();
        } catch (err) {
            return res.status(500).json({ error: 'Database initialization failed: ' + err.message });
        }
    }
    next();
});

// --- Pure JS Database Setup ---
async function initDatabase() {
    const SQL = await initSqlJs();
    
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }
    
    db.run(`CREATE TABLE IF NOT EXISTS clipboard (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL DEFAULT '',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`INSERT OR IGNORE INTO clipboard (id, content) VALUES (1, '')`);
    
    // Clean initial startup expired items
    cleanupExpiredItems();
    // Schedule periodic cleanup every 15 minutes
    setInterval(cleanupExpiredItems, 15 * 60 * 1000);
    
    saveDb();
    console.log('Connected to SQLite database & initialized cleanup timers.');
}

function cleanupExpiredItems() {
    if (!db) return;
    try {
        // Delete files older than 48 hours (48 * 3600 seconds)
        const fileStmt = db.prepare("SELECT id, stored_name FROM files WHERE strftime('%s', 'now') - strftime('%s', uploaded_at) > 172800");
        const expiredFiles = [];
        while (fileStmt.step()) {
            expiredFiles.push(fileStmt.getAsObject());
        }
        fileStmt.free();

        expiredFiles.forEach(f => {
            const filePath = path.join(UPLOAD_DIR, f.stored_name);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            db.run("DELETE FROM files WHERE id = ?", [f.id]);
            io.emit('file:deleted', { id: f.id });
        });

        // Delete text messages older than 7 days (7 * 86400 seconds = 604800 seconds)
        db.run("DELETE FROM messages WHERE strftime('%s', 'now') - strftime('%s', created_at) > 604800");
        saveDb();
    } catch (e) {
        console.error("Error running cleanup expired items:", e);
    }
}

function saveDb() {
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    } catch (e) {
        console.error("Error saving DB:", e);
    }
}

// --- Authentication Setup ---
function authMiddleware(req, res, next) {
    return next();
}

io.use((socket, next) => {
    return next();
});

// --- Multer Setup ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        let safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!safeName) safeName = 'uploaded_file';
        cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`);
    }
});

const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_SIZE } });

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for uptime monitors
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// --- REST API Endpoints ---
app.post('/api/auth', (req, res) => {
    if (process.env.CLIPBOARD_PASSWORD && req.body.password === process.env.CLIPBOARD_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        sessions.add(token);
        return res.json({ success: true, token });
    }
    return res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/clipboard', authMiddleware, (req, res) => {
    try {
        const stmt = db.prepare("SELECT content, updated_at FROM clipboard WHERE id = 1");
        stmt.step();
        const row = stmt.getAsObject();
        stmt.free();
        res.json(row || { content: '', updated_at: null });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/clipboard', authMiddleware, (req, res) => {
    try {
        db.run("UPDATE clipboard SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1", [req.body.content]);
        saveDb();
        const stmt = db.prepare("SELECT updated_at FROM clipboard WHERE id = 1");
        stmt.step();
        const row = stmt.getAsObject();
        stmt.free();
        if (row) io.emit('clipboard:update', { content: req.body.content, updated_at: row.updated_at });
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/api/files', authMiddleware, (req, res) => {
    try {
        const stmt = db.prepare("SELECT id, original_name, size, uploaded_at FROM files ORDER BY uploaded_at DESC");
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        res.json(rows);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        db.run("INSERT INTO files (original_name, stored_name, size) VALUES (?, ?, ?)", [req.file.originalname, req.file.filename, req.file.size]);
        saveDb();
        const lastId = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
        const stmt = db.prepare("SELECT id, original_name, size, uploaded_at FROM files WHERE id = ?");
        stmt.bind([lastId]);
        stmt.step();
        const row = stmt.getAsObject();
        stmt.free();
        if (row) io.emit('file:uploaded', row);
        res.json({ success: true, file: row });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/download/:id', authMiddleware, (req, res) => {
    try {
        const stmt = db.prepare("SELECT original_name, stored_name FROM files WHERE id = ?");
        stmt.bind([req.params.id]);
        stmt.step();
        const row = stmt.getAsObject();
        stmt.free();
        if (!row) return res.status(404).json({ error: 'File not found' });
        const filePath = path.join(UPLOAD_DIR, row.stored_name);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
        res.download(filePath, row.original_name);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.delete('/api/file/:id', authMiddleware, (req, res) => {
    try {
        const stmt = db.prepare("SELECT stored_name FROM files WHERE id = ?");
        stmt.bind([req.params.id]);
        stmt.step();
        const row = stmt.getAsObject();
        stmt.free();
        if (!row) return res.status(404).json({ error: 'File not found' });
        
        const filePath = path.join(UPLOAD_DIR, row.stored_name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
        db.run("DELETE FROM files WHERE id = ?", [req.params.id]);
        saveDb();
        io.emit('file:deleted', { id: parseInt(req.params.id) });
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/api/messages', authMiddleware, (req, res) => {
    try {
        const stmt = db.prepare("SELECT id, sender_id, text, created_at FROM messages ORDER BY created_at ASC");
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        res.json(rows);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/messages', authMiddleware, (req, res) => {
    try {
        const text = (req.body.text || '').trim();
        const senderId = req.body.sender_id || 'anonymous';
        if (!text) return res.status(400).json({ error: 'Message text cannot be empty' });

        db.run("INSERT INTO messages (sender_id, text) VALUES (?, ?)", [senderId, text]);
        saveDb();
        
        const stmt = db.prepare("SELECT id, sender_id, text, created_at FROM messages ORDER BY id DESC LIMIT 1");
        stmt.step();
        const msg = stmt.getAsObject();
        stmt.free();

        console.log('Created chat message:', msg);
        if (msg && msg.id) {
            io.emit('chat:message', msg);
        }
        res.json({ success: true, message: msg });
    } catch (err) { 
        console.error('Error saving message REST:', err);
        res.status(500).json({ error: err.message }); 
    }
});

app.delete('/api/messages', authMiddleware, (req, res) => {
    try {
        db.run("DELETE FROM messages");
        saveDb();
        io.emit('chat:cleared');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- WebSocket Events ---
io.on('connection', (socket) => {
    socket.on('clipboard:update', (data) => {
        const content = data.content || '';
        try {
            db.run("UPDATE clipboard SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1", [content]);
            saveDb();
            const stmt = db.prepare("SELECT updated_at FROM clipboard WHERE id = 1");
            stmt.step();
            const row = stmt.getAsObject();
            stmt.free();
            if (row) socket.broadcast.emit('clipboard:update', { content, updated_at: row.updated_at });
        } catch (err) { 
            console.error(err); 
        }
    });

    socket.on('chat:send', (data) => {
        const text = (data.text || '').trim();
        const senderId = data.sender_id || 'anonymous';
        if (!text) return;
        try {
            db.run("INSERT INTO messages (sender_id, text) VALUES (?, ?)", [senderId, text]);
            saveDb();
            const stmt = db.prepare("SELECT id, sender_id, text, created_at FROM messages ORDER BY id DESC LIMIT 1");
            stmt.step();
            const msg = stmt.getAsObject();
            stmt.free();
            if (msg) io.emit('chat:message', msg);
        } catch (err) {
            console.error('Error saving chat message socket:', err);
        }
    });

    socket.on('user:typing', () => {
        socket.broadcast.emit('user:typing');
    });

    socket.on('disconnect', () => {});
});

// --- Start Server ---
initDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
});
