const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        if (!process.env.MONGO_URI) {
            console.warn("⚠️ MONGO_URI is missing from .env. MongoDB connection skipped.");
            return;
        }
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ MongoDB connected successfully");
    } catch (err) {
        console.error("❌ MongoDB connection failed:", err.message);
    }
};

const userSchema = new mongoose.Schema({
    username: { type: String, required: false },
    chatId: { type: Number, required: true, unique: true },
    spreadsheetId: { type: String, required: false }, // Made false since not all users have a spreadsheet initially
    createdAt: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

module.exports = { connectDB, User };
