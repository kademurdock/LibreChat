const fs = require('fs-extra');

async function postBuild() {
  try {
    await fs.copy('public/assets', 'dist/assets');
    await fs.copy('public/robots.txt', 'dist/robots.txt');
    // Kade fork: Android sideload APK needs to be reachable at
    // kademurdock.com/Kade-AI.apk for direct-download install. Vite's
    // publicDir:false (production builds) means nothing in client/public
    // reaches client/dist automatically except what's explicitly copied
    // here — this is why robots.txt worked but a newly-added file
    // wouldn't, until it's added to this list too. See docs/ANDROID_SIDELOAD
    // notes for the alternative (email) distribution path.
    await fs.copy('public/Kade-AI.apk', 'dist/Kade-AI.apk');
    console.log('✅ PWA icons, robots.txt, and Kade-AI.apk copied successfully. Glob pattern warnings resolved.');
  } catch (err) {
    console.error('❌ Error copying files:', err);
    process.exit(1);
  }
}

postBuild();
