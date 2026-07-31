require('dotenv').config();
const { MongoClient } = require('mongodb');

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('jarvis');
  const result = await db.collection('users').updateOne(
    { email: 'hammadshariq610@gmail.com' },
    { $set: { subscriptionStatus: 'active', lastActiveAt: Date.now() } }
  );
  console.log('Modified:', result.modifiedCount);
  const user = await db.collection('users').findOne({ email: 'hammadshariq610@gmail.com' });
  console.log('Current status:', user.subscriptionStatus);
  await client.close();
}

run().catch(console.error);
