// The shared voice core lives at ../shared, outside the Expo project root. Metro
// only bundles and watches what is under the root unless told otherwise, so
// without watchFolders an edit in shared/ never reaches a running bundler (and a
// cold start fails to resolve it at all).
//
// nodeModulesPaths keeps resolution pointing at the phone's own node_modules: the
// repo root has its own, with a different React in it, and a file under shared/
// resolving `react` there would load two copies.
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.watchFolders = [path.resolve(__dirname, '..', 'shared')]
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  ...(config.resolver.nodeModulesPaths ?? []),
]

module.exports = config
