require('dotenv').config();
const { MongoClient } = require('mongodb');

const email = process.argv[2];
if (!email) { console.log('Usage: node delete-user.js <email>'); process.exit(1); }

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('jarvis');
  const result = await db.collection('users').deleteOne({ email: email.toLowerCase() });
  console.log(result.deletedCount ? `Deleted user: ${email}` : `No user found with email: ${email}`);
  await client.close();
}

run().catch(console.error);
