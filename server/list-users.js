require('dotenv').config();
const { MongoClient } = require('mongodb');

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('jarvis');
  const users = await db.collection('users').find({}, { projection: { email: 1, subscriptionStatus: 1, stripeCustomerId: 1, createdAt: 1 } }).toArray();
  console.log('Users in MongoDB:');
  users.forEach(u => console.log(' -', u.email, '| status:', u.subscriptionStatus, '| stripeId:', u.stripeCustomerId, '| created:', new Date(u.createdAt).toISOString()));
  if (!users.length) console.log('(none)');
  await client.close();
}

run().catch(console.error);
