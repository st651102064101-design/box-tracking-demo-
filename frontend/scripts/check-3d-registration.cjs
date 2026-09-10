const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Execute module initialization without starting WebGL or fetching warehouse data.
// Syntax checks alone cannot detect registration accidentally nested in createScene.
const source = fs.readFileSync(process.argv[2] || 'public/loc3d.js', 'utf8')
  .replace(/^import .*;\r?$/gm, '');
const window = {};
vm.runInNewContext(source, {
  window,
  THREE: { Color: class {}, BoxGeometry: class {} },
});
assert.equal(typeof window.LocationWarehouse3D?.mount, 'function');
assert.equal(typeof window.LocationWarehouse3D?.unmount, 'function');
console.log('3D registration OK');
