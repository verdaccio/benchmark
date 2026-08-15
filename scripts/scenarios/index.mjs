import * as warmInstall from './warm-install.mjs';
import * as proxyInstall from './proxy-install.mjs';
import * as publish from './publish.mjs';
import * as unpublish from './unpublish.mjs';
import * as serve from './serve.mjs';
import * as search from './search.mjs';

// Every benchmark scenario, keyed by name. Each module exports { name, unit, run }.
export const scenarios = {
  [warmInstall.name]: warmInstall,
  [proxyInstall.name]: proxyInstall,
  [publish.name]: publish,
  [unpublish.name]: unpublish,
  [serve.name]: serve,
  [search.name]: search,
};

export const scenarioNames = Object.keys(scenarios);
