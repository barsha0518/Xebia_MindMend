const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const http = require('http'); // <-- Added for Socket.IO
require('dotenv').config();
const uri="mongodb+srv://garghimanshi093:mindMend@cluster0.mafkrsd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const MONGO_URI = process.env.MONGO_URI || uri

const app = express();

const server = http.createServer(app); // <-- Use HTTP server for Socket.IO

// --- Socket.IO setup ---
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: "*", // Change for production!
    methods: ["GET", "POST"]
  }
});



app.use(cors());
app.use(express.json());
const bookingRoutes = require('./routes/booking');
app.use('/api', bookingRoutes);
app.use("/api/mood", require("./routes/mood"));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer setup for credentials upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage: storage });

// User Schema
const userSchema = new mongoose.Schema({
  name: { type: String },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['therapist', 'client'], required: true },
  // Therapist fields
  licenseNumber: String,
  expertise: [String],
  yearsExperience: Number,
  institution: String,
  credentials: String, // file path
  // Client fields
  age: Number,
  preferredLanguage: String,
  concerns: [String],
  communicationMode: String,
});
const User = mongoose.model('User', userSchema);

// Message Schema
const messageSchema = new mongoose.Schema({
  sender: { type: String, required: true }, // You can use user id or name
  message: { type: String, required: true },
  sentTime: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// Connect to MongoDB
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('MongoDB connected successfully');
}).catch((err) => {
  console.error('MongoDB connection error:', err);
});

// JWT Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Role-based Middleware
function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

// Sign Up Route
app.post('/api/signup', upload.single('credentials'), async (req, res) => {
  try {
    // Debug: log incoming fields and file
    console.log('Signup body:', req.body);
    console.log('Signup file:', req.file);

    const { email, password, role } = req.body;
    if (!email || !password || !role) {
      return res.status(400).json({ error: 'Email, password, and role are required.' });
    }
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Email already registered.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    let userData = { email, password: hashedPassword, role };
    if (role === 'therapist') {
      userData.name = req.body.name; 
      userData.licenseNumber = req.body.licenseNumber;
      userData.expertise = req.body.expertise ? Array.isArray(req.body.expertise) ? req.body.expertise : [req.body.expertise] : [];
      userData.yearsExperience = req.body.yearsExperience;
      userData.institution = req.body.institution;
      userData.credentials = req.file ? req.file.path : '';
    } else if (role === 'client') {
      userData.name = req.body.name; 
      userData.age = req.body.age;
      userData.preferredLanguage = req.body.preferredLanguage;
      userData.concerns = req.body.concerns ? Array.isArray(req.body.concerns) ? req.body.concerns : [req.body.concerns] : [];
      userData.communicationMode = req.body.communicationMode;
    }
    const user = new User(userData);
    await user.save();
    res.status(201).json({ message: 'User registered successfully.' });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Login Route
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid credentials.' });
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, role: user.role, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all therapists for frontend dropdown
app.get('/api/therapists', async (req, res) => {
  try {
    // Fetch all users with role 'therapist', selecting only needed fields
    const therapists = await User.find({ role: 'therapist' }, 'name email _id');
    res.json(therapists);
  } catch (err) {
    console.error('Error fetching therapists:', err);
    res.status(500).json({ error: 'Failed to fetch therapists' });
  }
});


// Example protected route
app.get('/api/profile', authenticateToken, (req, res) => {
  res.json({ message: 'Profile data', user: req.user });
});


// ---- COMMUNITY CHAT FEATURE ----

// REST endpoint to fetch last 100 messages
app.get('/api/community/messages', async (req, res) => {
  try {
    const messages = await Message.find().sort({ sentTime: 1 }).limit(100);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.IO logic for real-time chat
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Listen for incoming chat messages
  socket.on('sendMessage', async (msg) => {
    try {
      // Save message to DB
      const savedMsg = await Message.create(msg);
      // Broadcast to all clients
      io.emit('receiveMessage', savedMsg);
    } catch (err) {
      console.error('Message save error:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// ---- END COMMUNITY CHAT FEATURE ----


const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));