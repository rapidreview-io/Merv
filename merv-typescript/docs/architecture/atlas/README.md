# Atlas

An explorable map of the plugins, compiled from source. Build it, then open the page:

```sh
npm run docs:architecture
open docs/architecture/atlas/index.html
```

The page is self-contained and makes no network requests. `atlas.json` and `index.html` are build output and are not committed, so the map is always as current as the code you built it from.

## What is compiled, and from where

`scripts/atlas.ts` reads the code with the TypeScript type checker. Nothing here is hand-maintained except `realms.json`.

| On the map                         | Source                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Plugins, sizes, files, imports     | `packages/*/src` and `packages/*/web`                                                      |
| Service contracts (the wall ports) | Each `declare module 'cordis' { interface Context }` entry, resolved to its type's members |
| Who calls which method             | Every property access whose receiver has a service's type                                  |
| Hooks                              | Methods that take a callback and return a way to unregister it                             |
| Tools                              | Native tool definitions (`name` + `description`)                                           |
| Events                             | `type:` values passed to event writers, matched against consumers' `types: [...]`          |
| Tables and table reach             | `CREATE TABLE` owners, and SQL in other packages that names those tables                   |
| State machines                     | Exported `WorkflowDefinition` values, imported at build time                               |
| Layout                             | Dependency depth from the declared Cordis injections, settled with a force layout          |

`realms.json` names which packages are research logic, which are libraries, and display labels.

## Using it

Drag to pan, scroll to zoom. Hover a plugin to light its channels; click to dive into it. Inside a plugin, methods, tools and events sit on the wall, files and tables inside it, neighbours around it. Hover a port for its signature and callers; click a neighbour to travel there. Escape or the globe returns to the whole map. `/` jumps to a plugin. The legend buttons toggle each kind of channel; the eye shows every channel on the whole map; the flask expands the research plugins.
