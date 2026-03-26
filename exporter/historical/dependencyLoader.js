const path = require('path');

function loadDependency(name) {
  let originalError = null;

  try {
    return require(name);
  } catch (error) {
    originalError = error;
  }

  const searchRoots = [
    __dirname,
    path.join(__dirname, '..'),
    path.join(__dirname, '..', 'test'),
  ];

  for (const root of searchRoots) {
    try {
      const resolvedPath = require.resolve(name, { paths: [root] });
      return require(resolvedPath);
    } catch (error) {
      // Keep searching.
    }
  }

  throw originalError;
}

module.exports = { loadDependency };
