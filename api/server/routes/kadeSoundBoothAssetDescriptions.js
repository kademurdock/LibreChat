const { legacyAukEditCandidate } = require('@librechat/api');

// Existing takes have no edit marker. Require their own account/project link, never infer from prose alone.
async function legacyEditAssetIds(assets, user) {
  const ids = assets.filter(legacyAukEditCandidate).map(asset => asset._id);
  if (!ids.length) return new Set();
  const { KadeSoundBoothProject } = require('~/models/kadeSoundBoothProject');
  const projects = await KadeSoundBoothProject.find({ user, engine: 'scenema', 'options.auk_task': 'edit', assets: { $in: ids } }).select('assets').lean();
  return new Set(projects.flatMap(project => project.assets || []).map(String));
}

// Single renders arrive through the trusted bridge before detached description enrichment starts.
async function editMetadataForJob(user, jobId, prompt) {
  if (typeof jobId !== 'string' || !jobId) return {};
  const { KadeSoundBoothProject } = require('~/models/kadeSoundBoothProject');
  const project = await KadeSoundBoothProject.findOne({ user, engine: 'scenema', 'options.auk_task': 'edit', jobs: jobId,
    $expr: { $eq: [{ $arrayElemAt: ['$jobs', -1] }, jobId] } }).select('options.instruction script').lean();
  return project ? { aukTask: 'edit', editInstruction: String(prompt || project.options?.instruction || project.script || '') } : {};
}

module.exports = { legacyEditAssetIds, editMetadataForJob };
