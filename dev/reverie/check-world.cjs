const fs = require('node:fs');
const path = require('node:path');
require('../../api/test/reverie-bootstrap.cjs');
const { compileReverie } = require('@librechat/api');
try {
  const file = path.resolve(
    process.argv[2] || 'api/app/clients/tools/kademoo/world/waterfront.rev',
  );
  const world = compileReverie(fs.readFileSync(file, 'utf8'));
  console.log(
    `${world.places.length} places, ${world.actions.length} actions, ${world.links.length} connecting exits: source valid.`,
  );
  console.log('Production seeding also verifies that existing connector rooms are present.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
