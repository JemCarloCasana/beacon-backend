import bcrypt from "bcrypt";

const password = process.argv[2];

if (!password) {
  console.error('Usage: node scripts/generateBcryptHash.js "your-password"');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
console.log(hash);
