import { runMountUnloadScenario } from './mount-unload-scenario.js';
import { reportScenario } from './scenario.js';

await reportScenario('mount-unload', runMountUnloadScenario, {
  mode: 0o600,
  failed: 'Mount removal scenario failed. Run the focused test for assertion details.',
});
