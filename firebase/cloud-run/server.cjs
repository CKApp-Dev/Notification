'use strict';

const { createServer } = require('node:http');
const { Firestore } = require('firebase-admin/firestore');
const { Expo } = require('expo-server-sdk');
const { runNotificationWorker } = require('./lib/run');
const { createHandler } = require('./adapter.cjs');

if (process.env.GOOGLE_CLOUD_PROJECT !== 'ck-app-database') {
  console.error('Set GOOGLE_CLOUD_PROJECT to ck-app-database.');
  process.exit(1);
}

const db = new Firestore({ projectId: 'ck-app-database' });
const gateway = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN || undefined, maxConcurrentRequests: 2 });
const server = createServer(createHandler(() => runNotificationWorker(db, gateway)));
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');

process.on('SIGTERM', () => {
  server.close(() => {
    db.terminate().then(() => process.exit(0), () => process.exit(1));
  });
});
