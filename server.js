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

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

let db = null;

// Track online count per room
const roomUsersMap = new Map();

// --- Pure JS Database Setup (sql.js) ---
async function initDatabase() {
    const SQL = await initSqlJs();
    
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT NOT NULL,
        username TEXT NOT NULL,
        content TEXT,
        type TEXT NOT NULL CHECK(type IN ('text', 'file')),
        file_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL DEFAULT 'default',
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Auto-migrate old SQLite schema files missing newer columns
    const messageColumns = [
        { name: "room_id", type: "TEXT NOT NULL DEFAULT 'default'" },
        { name: "session_id", type: "TEXT NOT NULL DEFAULT 'user_anon'" },
        { name: "sender_id", type: "TEXT NOT NULL DEFAULT 'user_anon'" },
        { name: "username", type: "TEXT NOT NULL DEFAULT 'Guest'" },
        { name: "content", type: "TEXT DEFAULT ''" },
        { name: "text", type: "TEXT DEFAULT ''" },
        { name: "type", type: "TEXT NOT NULL DEFAULT 'text'" },
        { name: "file_id", type: "INTEGER" }
    ];

    messageColumns.forEach(col => {
        try {
            db.run(`ALTER TABLE messages ADD COLUMN ${col.name} ${col.type}`);
        } catch (e) { /* Column already exists */ }
    });

    try {
        db.run("ALTER TABLE files ADD COLUMN room_id TEXT NOT NULL DEFAULT 'default'");
    } catch (e) { /* Column already exists */ }

    saveDb();
    console.log('Connected to sql.js SQLite database successfully.');

    // Schedule periodic retention cleanup every 15 minutes
    cleanupExpiredItems();
    setInterval(cleanupExpiredItems, 15 * 60 * 1000);
}

function cleanupExpiredItems() {
    if (!db) return;
    try {
        // Delete files older than 48 hours (48 * 3600 = 172800 seconds)
        const fileStmt = db.prepare("SELECT id, stored_name, room_id FROM files WHERE strftime('%s', 'now') - strftime('%s', created_at) > 172800");
        const expiredFiles = [];
        while (fileStmt.step()) {
            expiredFiles.push(fileStmt.getAsObject());
        }
        fileStmt.free();

        expiredFiles.forEach(f => {
            const filePath = path.join(UPLOAD_DIR, f.stored_name);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            db.run("DELETE FROM files WHERE id = ?", [f.id]);
            db.run("DELETE FROM messages WHERE file_id = ?", [f.id]);
            if (f.room_id) io.to(f.room_id).emit('file:deleted', { id: f.id });
        });

        // Delete text messages older than 7 days (7 * 86400 = 604800 seconds)
        db.run("DELETE FROM messages WHERE strftime('%s', 'now') - strftime('%s', created_at) > 604800");
        saveDb();
        console.log('[CLEANUP] Expired files (>48h) and text messages (>7d) purged.');
    } catch (e) {
        console.error('[CLEANUP ERROR]:', e);
    }
}

function saveDb() {
    if (!db) return;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    } catch (e) {
        console.error('Error exporting/saving database:', e);
    }
}

// --- Multer Storage Setup ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        let safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!safeName) safeName = 'uploaded_file';
        const uniqueName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_SIZE } });

// --- Express Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// Health check endpoint for UptimeRobot / Cron-Job to prevent Render sleep
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

let dbPromise = null;
async function getDb() {
    if (!db) {
        if (!dbPromise) dbPromise = initDatabase();
        await dbPromise;
    }
    return db;
}

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

// --- REST API Endpoints ---

// POST /api/room/create - Generate a new secure 6-character room code
app.post('/api/room/create', (req, res) => {
    try {
        let roomId;
        let exists = true;
        
        while (exists) {
            roomId = crypto.randomBytes(3).toString('hex').toLowerCase(); // e.g. 6-char hex code
            const stmt = db.prepare('SELECT room_id FROM rooms WHERE room_id = ?');
            stmt.bind([roomId]);
            exists = stmt.step();
            stmt.free();
        }

        db.run('INSERT INTO rooms (room_id) VALUES (?)', [roomId]);
        saveDb();

        res.json({ success: true, room_id: roomId });
    } catch (err) {
        console.error('Error creating room:', err);
        res.status(500).json({ error: 'Failed to create room' });
    }
});

// POST /api/room/join - Verify room existence
app.post('/api/room/join', (req, res) => {
    try {
        const roomId = (req.body.room_id || '').trim().toLowerCase();
        if (!roomId) return res.status(400).json({ error: 'Room ID is required' });

        const stmt = db.prepare('SELECT room_id FROM rooms WHERE room_id = ?');
        stmt.bind([roomId]);
        const found = stmt.step();
        stmt.free();

        if (!found) {
            return res.status(404).json({ error: 'Room not found. Please check your room ID or create a new room.' });
        }

        res.json({ success: true, room_id: roomId });
    } catch (err) {
        console.error('Error joining room:', err);
        res.status(500).json({ error: 'Failed to join room' });
    }
});

// POST /api/messages - Save message via REST and emit to room
app.post('/api/messages', (req, res) => {
    try {
        const { room_id, session_id, username, content } = req.body;
        const targetRoom = (room_id || '').trim().toLowerCase();
        if (!targetRoom || !content || !content.trim()) {
            return res.status(400).json({ error: 'Room ID and message content are required' });
        }

        const textValue = content.trim();
        db.run(
            'INSERT INTO messages (room_id, session_id, sender_id, username, content, text, type, file_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
            [targetRoom, session_id || 'user_anon', session_id || 'user_anon', username || 'Guest', textValue, textValue, 'text']
        );
        const msgId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        saveDb();

        const stmt = db.prepare('SELECT id, room_id, session_id, username, content, type, file_id, created_at FROM messages WHERE id = ?');
        stmt.bind([msgId]);
        stmt.step();
        const msgObject = stmt.getAsObject();
        stmt.free();

        io.to(targetRoom).emit('message:new', msgObject);
        res.json({ success: true, message: msgObject });
    } catch (err) {
        console.error('Error saving message via REST:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/messages?room_id=xyz - Get room history
app.get('/api/messages', (req, res) => {
    try {
        const roomId = (req.query.room_id || '').trim().toLowerCase();
        console.log(`[DEBUG GET /api/messages] Querying messages for room_id: "${roomId}"`);
        if (!roomId) return res.status(400).json({ error: 'Room ID required' });

        const database = db;
        if (!database) {
            console.error('[DEBUG GET /api/messages] Database instance is null');
            return res.status(500).json({ error: 'Database instance is null' });
        }

        const query = `
            SELECT 
                m.id, m.room_id, m.session_id, m.username, m.content, m.type, m.file_id, m.created_at,
                f.original_name, f.stored_name, f.size
            FROM messages m
            LEFT JOIN files f ON m.file_id = f.id
            WHERE m.room_id = ?
            ORDER BY m.id DESC
            LIMIT 100
        `;
        const stmt = database.prepare(query);
        stmt.bind([roomId]);
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        console.log(`[DEBUG GET /api/messages] Found ${rows.length} messages for room "${roomId}"`);
        res.json(rows.reverse());
    } catch (err) {
        console.error('[DEBUG GET /api/messages EXCEPTION]:', err);
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// POST /api/upload - Handle file upload within room
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    try {
        const { originalname, filename, size } = req.file;
        const roomId = (req.body.room_id || '').trim().toLowerCase();
        const sessionId = req.body.session_id || 'user_anon';
        const username = req.body.username || 'Guest';

        if (!roomId) return res.status(400).json({ error: 'Room ID required' });

        db.run(
            'INSERT INTO files (room_id, original_name, stored_name, size) VALUES (?, ?, ?, ?)',
            [roomId, originalname, filename, size]
        );
        const fileId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];

        db.run(
            'INSERT INTO messages (room_id, session_id, sender_id, username, content, text, type, file_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [roomId, sessionId, sessionId, username, originalname, originalname, 'file', fileId]
        );
        const msgId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        saveDb();

        const stmt = db.prepare(`
            SELECT 
                m.id, m.room_id, m.session_id, m.username, m.content, m.type, m.file_id, m.created_at,
                f.original_name, f.stored_name, f.size
            FROM messages m
            LEFT JOIN files f ON m.file_id = f.id
            WHERE m.id = ?
        `);
        stmt.bind([msgId]);
        stmt.step();
        const messageObject = stmt.getAsObject();
        stmt.free();

        io.to(roomId).emit('file:uploaded', messageObject);
        res.json({ success: true, message: messageObject });
    } catch (err) {
        console.error('Error uploading file:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /download/:id - File download with safety check
app.get('/download/:id', (req, res) => {
    try {
        const stmt = db.prepare('SELECT original_name, stored_name FROM files WHERE id = ?');
        stmt.bind([req.params.id]);
        stmt.step();
        const fileRecord = stmt.getAsObject();
        stmt.free();

        if (!fileRecord || !fileRecord.stored_name) {
            return res.status(404).json({ error: 'File record not found' });
        }

        const safeFilename = path.basename(fileRecord.stored_name);
        const filePath = path.join(UPLOAD_DIR, safeFilename);

        if (!filePath.startsWith(UPLOAD_DIR)) {
            return res.status(403).json({ error: 'Access denied: Directory traversal prevented' });
        }

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File missing on server disk' });
        }

        res.download(filePath, fileRecord.original_name);
    } catch (err) {
        console.error('Error serving download:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Socket.IO Event Handlers ---
io.on('connection', (socket) => {
    let currentRoomId = null;

    socket.on('room:join', (data) => {
        const roomId = (data.room_id || '').trim().toLowerCase();
        if (!roomId) return;

        currentRoomId = roomId;
        socket.join(roomId);

        const currentCount = (roomUsersMap.get(roomId) || 0) + 1;
        roomUsersMap.set(roomId, currentCount);

        io.to(roomId).emit('users:count', currentCount);
    });

    socket.on('message:new', (data) => {
        const { room_id, session_id, username, content } = data;
        const targetRoom = (room_id || currentRoomId || '').trim().toLowerCase();
        if (!targetRoom || !content || !content.trim()) return;

        try {
            const textValue = content.trim();
            db.run(
                'INSERT INTO messages (room_id, session_id, sender_id, username, content, text, type, file_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
                [targetRoom, session_id || 'user_anon', session_id || 'user_anon', username || 'Guest', textValue, textValue, 'text']
            );
            const msgId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
            saveDb();

            const stmt = db.prepare('SELECT id, room_id, session_id, username, content, type, file_id, created_at FROM messages WHERE id = ?');
            stmt.bind([msgId]);
            stmt.step();
            const msgObject = stmt.getAsObject();
            stmt.free();

            io.to(targetRoom).emit('message:new', msgObject);
        } catch (err) {
            console.error('Error handling socket message:new:', err);
        }
    });

    socket.on('message:typing', (data) => {
        const targetRoom = (data.room_id || currentRoomId || '').trim().toLowerCase();
        if (targetRoom) {
            socket.to(targetRoom).emit('message:typing', data);
        }
    });

    socket.on('disconnect', () => {
        if (currentRoomId) {
            const currentCount = Math.max(0, (roomUsersMap.get(currentRoomId) || 1) - 1);
            if (currentCount === 0) {
                roomUsersMap.delete(currentRoomId);
            } else {
                roomUsersMap.set(currentRoomId, currentCount);
            }
            io.to(currentRoomId).emit('users:count', currentCount);
        }
    });
});

// --- Start Server ---
initDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`Shared Clipboard server listening on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
