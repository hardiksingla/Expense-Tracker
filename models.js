const mongoose = require('mongoose');
const dns = require('dns');

// Fix for Node.js c-ares DNS resolving mongodb+srv SRV records on Windows / ISP DNS
try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (_) {}

const connectDB = async () => {
    try {
        if (!process.env.MONGO_URI) {
            console.warn("⚠️ MONGO_URI is missing from .env. MongoDB connection skipped.");
            return;
        }
        await mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 5000
        });
        console.log("✅ MongoDB connected successfully");
    } catch (err) {
        console.error("❌ MongoDB connection failed:", err.message);
    }
};

const userSchema = new mongoose.Schema({
    username: { type: String, required: false },
    chatId: { type: Number, required: true, unique: true },
    spreadsheetId: { type: String, required: false }, // Made false since not all users have a spreadsheet initially
    bikeSpreadsheetId: { type: String, required: false }, // Dedicated spreadsheet for Triumph Speed 400 tracker
    createdAt: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

module.exports = { connectDB, User };
