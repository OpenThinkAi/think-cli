import { maybeMigrateEngramsToIndex } from './lib/paths.js';

// Run one-time path migration before any command handler checks for
// the existence of ~/.think/index/ (formerly ~/.think/engrams/).
maybeMigrateEngramsToIndex();

import { buildProgram } from './program.js';

buildProgram().parse();
