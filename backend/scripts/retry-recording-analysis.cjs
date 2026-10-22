// Recover only this device owner's historical 422 failures, preserving completed stages.
require('dotenv').config({ quiet: true });
const { MongoClient, ObjectId } = require('mongodb');
const { Queue } = require('bullmq');
(async () => {
  const mongo = new MongoClient(process.env.MONGODB_URI);
  const queues = [];
  try {
    await mongo.connect();
    const collection = mongo.db().collection('analysis_jobs');
    const reference = await collection.findOne({ _id: new ObjectId('6ad173ce0fe7a4b6bcdac809') });
    if (!reference) throw new Error('Reference recording not found');
    for (const [name, stage] of [['audio.scan', 'scanStage'], ['speech.diarize', 'diarizationStage']]) {
      const queue = new Queue(name, { prefix: 'kid-audio', connection: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) } });
      queues.push(queue);
      for (const job of await queue.getFailed(0, 100)) {
        if (!job.failedReason?.includes('status 422') || job.data.tenantId !== reference.tenantId) continue;
        const filter = { _id: new ObjectId(job.data.analysisId), tenantId: reference.tenantId, [`${stage}.status`]: 'FAILED', audioDeletedAt: { $exists: false } };
        const document = await collection.findOne(filter);
        if (!document) continue;
        if (!process.argv.includes('--apply')) { console.log('eligible', name, document.originalFileName); continue; }
        const changed = await collection.updateOne(filter, { $set: { status: 'PROCESSING', [`${stage}.status`]: 'QUEUED', [`${stage}.progress`]: 0, failureReason: null, updatedAt: new Date() } });
        if (!changed.modifiedCount) continue;
        try { await job.retry('failed'); console.log('retried', name, document.originalFileName); }
        catch (error) { await collection.updateOne({ ...filter, [`${stage}.status`]: 'QUEUED' }, { $set: { status: document.status, [stage]: document[stage], failureReason: document.failureReason } }); throw error; }
      }
    }
  } finally { await Promise.all(queues.map(queue => queue.close())); await mongo.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
