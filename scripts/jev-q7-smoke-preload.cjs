const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
const serverOnlyShim = require.resolve("./jev-q7-server-only.cjs");

Module._resolveFilename = function resolveFilename(request, parent, ...rest) {
  if (request === "server-only") return serverOnlyShim;
  return originalResolveFilename.call(this, request, parent, ...rest);
};
