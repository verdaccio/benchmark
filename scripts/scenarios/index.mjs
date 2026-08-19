import * as warmInstall from './warm-install.mjs';
import * as proxyInstall from './proxy-install.mjs';
import * as publish from './publish.mjs';
import * as unpublish from './unpublish.mjs';
import * as serve from './serve.mjs';
import * as search from './search.mjs';
import * as monorepo from './monorepo.mjs';
import * as bigpkg from './bigpkg.mjs';

// Every benchmark scenario, keyed by name. Each module exports { name, unit, run }.
// A scenario may also export `optIn: true` to stay out of the default run set.
export const scenarios = {
  [warmInstall.name]: warmInstall,
  [proxyInstall.name]: proxyInstall,
  [publish.name]: publish,
  [unpublish.name]: unpublish,
  [serve.name]: serve,
  [search.name]: search,
  [monorepo.name]: monorepo,
  [bigpkg.name]: bigpkg,
};

// All registered names — valid values for --scenarios.
export const scenarioNames = Object.keys(scenarios);

// The set `pnpm bench` runs by default: everything except opt-in scenarios (e.g.
// `monorepo`), which are heavy/special and must be requested explicitly by name.
export const defaultScenarioNames = scenarioNames.filter((n) => !scenarios[n].optIn);
