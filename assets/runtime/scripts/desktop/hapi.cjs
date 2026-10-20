const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Hapi, hubOrigin, projectMessages, sseFrames } = require('./hapi-core.js')({ fs, path, randomUUID, hash: value => createHash('sha256').update(value).digest('hex') });

module.exports = { Hapi, hubOrigin, projectMessages, sseFrames };
