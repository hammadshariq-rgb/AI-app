// Dump a real database, wipe it, restore it, and check everything came back —
// types included. A backup that has never been restored is a hope, not a backup.
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { dump, restore } = require('./backup');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL ' + n + (x ? ' — ' + x : '')); } };

(async () => {
  const m = await MongoMemoryServer.create();
  const uri = m.getUri();
  const PASS = 'a-long-test-passphrase-123';
  const c = new MongoClient(uri); await c.connect();
  const db = c.db('jarvis');
  const id = new ObjectId();
  const when = new Date('2026-01-02T03:04:05Z');
  await db.collection('users').insertOne({ _id: id, email: 'a@example.com', createdAt: when, n: 7 });
  await db.collection('connections').insertMany([{ userId: id.toString(), service: 'instagram', access_token: 'enc:v1:jwt:x' }, { userId: 'b', service: 'youtube' }]);

  const { file, counts } = await dump(uri, PASS);
  ok('every collection is counted', counts.users === 1 && counts.connections === 2, JSON.stringify(counts));
  ok('the file is encrypted (no email visible)', !file.includes(Buffer.from('a@example.com')));
  ok('nor a token', !file.includes(Buffer.from('enc:v1:jwt')));

  let threw = ''; try { await restore(uri, 'the-wrong-passphrase-xx', file); } catch (e) { threw = e.message; }
  ok('a wrong passphrase is refused', /wrong passphrase/.test(threw), threw);

  threw = ''; try { await restore(uri, PASS, file); } catch (e) { threw = e.message; }
  ok('restore will not overwrite live data by accident', /already has/.test(threw), threw);

  await db.dropDatabase();
  const r = await restore(uri, PASS, file);
  ok('restore reports what it put back', r.restored.users === 1 && r.restored.connections === 2);
  const u = await db.collection('users').findOne({ email: 'a@example.com' });
  ok('the user is back', !!u);
  ok('its _id is still an ObjectId', u && u._id instanceof ObjectId && u._id.equals(id));
  ok('its date is still a Date', u && u.createdAt instanceof Date && u.createdAt.getTime() === when.getTime());
  ok('connections are back', (await db.collection('connections').countDocuments()) === 2);

  const tampered = Buffer.from(file); tampered[tampered.length - 5] ^= 1;
  threw = ''; try { await restore(uri, PASS, tampered, { replace: true }); } catch (e) { threw = e.message; }
  ok('a tampered file is refused', !!threw);

  await c.close(); await m.stop();
  console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
