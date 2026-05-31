const crypto = require("crypto");

const ENCRYPTION_SECRET = process.argv[2];
const data = JSON.stringify({
  apiKey: "ollama",
  baseUrl: "http://localhost:11434/v1"
});

// Typebot uses aes-256-gcm with ENCRYPTION_SECRET directly as key
const algorithm = "aes-256-gcm";
const key = ENCRYPTION_SECRET;
const iv = crypto.randomBytes(16);
const cipher = crypto.createCipheriv(algorithm, key, iv);

let encrypted = cipher.update(data, "utf8", "hex");
encrypted += cipher.final("hex");
const authTag = cipher.getAuthTag().toString("hex");

// Typebot stores: data=encrypted (hex), iv="ivHex.authTagHex"
console.log(JSON.stringify({
  data: encrypted,
  iv: iv.toString("hex") + "." + authTag
}));
