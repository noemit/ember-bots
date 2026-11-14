// External build overlay: no product files are edited.
const fs = require('node:fs');
const path = require('node:path');
const product = process.env.PRODUCT_ROOT;
const config = {...JSON.parse(fs.readFileSync(path.join(product, 'package.json'))).build};
delete config.publish;
config.publish = null;
config.extraMetadata = {};
// Silent installation must not auto-launch before the isolated test environment is applied.
config.nsis = {...config.nsis, runAfterFinish: false, deleteAppDataOnUninstall: false};
fs.writeFileSync(process.env.MANUAL_BUILDER_CONFIG, JSON.stringify(config, null, 2));
