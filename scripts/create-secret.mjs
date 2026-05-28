import crypto from "node:crypto"

// 32 random bytes encoded as base64. Use for BETTER_AUTH_SECRET,
// NEXTAUTH_SECRET, webhook signing secrets, etc.
const secret = crypto.randomBytes(32).toString("base64")

console.log("\nGenerated secret:\n")
console.log("====================================================")
console.log(secret)
console.log("====================================================\n")
console.log("Copy this value into your .env file.\n")
