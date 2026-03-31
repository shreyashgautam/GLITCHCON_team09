const { MongoClient } = require('mongodb');

let clientPromise = null;

function getMongoUri() {
  const uri = String(process.env.MONGO_URI || '').trim();
  return uri || null;
}

async function getMongoClient() {
  const uri = getMongoUri();
  if (!uri) {
    throw new Error('MONGO_URI is not configured');
  }
  if (!clientPromise) {
    const client = new MongoClient(uri);
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

async function getDb() {
  const client = await getMongoClient();
  const dbName = String(process.env.MONGO_DB_NAME || '').trim();
  return dbName ? client.db(dbName) : client.db();
}

module.exports = { getMongoClient, getDb };

