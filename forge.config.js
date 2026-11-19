import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Remove SITL binaries for other platforms/architectures to reduce package size.
// This must run via afterCopyExtraResources (before code signing) rather than
// postPackage, otherwise deleting files invalidates the macOS signature seal.
const pruneSitlBinaries = (stagingPath, electronVersion, platform, arch, done) => {
  try {
    let sitlPath;

    if (platform === 'darwin') {
      // stagingPath is @electron/packager's temp staging dir, NOT the .app bundle:
      // the bundle is a subdirectory of it (created by renameAppAndHelpers() before
      // this hook runs), so Resources lives at <stagingPath>/<AppName>.app/Contents/Resources.
      const appBundle = fs.readdirSync(stagingPath).find((name) => name.endsWith('.app'));
      if (!appBundle) {
        console.log(`pruneSitlBinaries: no .app bundle found in ${stagingPath}, skipping`);
        return done();
      }
      sitlPath = path.join(stagingPath, appBundle, 'Contents', 'Resources', 'sitl');
    } else {
      // Windows/Linux: <stagingPath>/resources/sitl
      sitlPath = path.join(stagingPath, 'resources', 'sitl');
    }

    console.log(`pruneSitlBinaries: Checking SITL path for ${platform}: ${sitlPath}`);
    if (!fs.existsSync(sitlPath)) {
      console.log(`pruneSitlBinaries: SITL path not found, skipping: ${sitlPath}`);
      return done();
    }

    if (platform === 'win32') {
      console.log('pruneSitlBinaries: Removing non-Windows SITL binaries (linux, macos)');
      fs.rmSync(path.join(sitlPath, 'linux'), { recursive: true, force: true });
      fs.rmSync(path.join(sitlPath, 'macos'), { recursive: true, force: true });
    } else if (platform === 'darwin') {
      console.log('pruneSitlBinaries: Removing non-macOS SITL binaries (linux, windows)');
      fs.rmSync(path.join(sitlPath, 'linux'), { recursive: true, force: true });
      fs.rmSync(path.join(sitlPath, 'windows'), { recursive: true, force: true });
    } else if (platform === 'linux') {
      console.log('pruneSitlBinaries: Removing non-Linux SITL binaries (macos, windows)');
      fs.rmSync(path.join(sitlPath, 'macos'), { recursive: true, force: true });
      fs.rmSync(path.join(sitlPath, 'windows'), { recursive: true, force: true });
      // Remove wrong architecture
      if (arch === 'x64') {
        fs.rmSync(path.join(sitlPath, 'linux', 'arm64'), { recursive: true, force: true });
      } else if (arch === 'arm64') {
        // Move arm64 binary to linux root and remove x64
        const arm64Binary = path.join(sitlPath, 'linux', 'arm64', 'inav_SITL');
        const destBinary = path.join(sitlPath, 'linux', 'inav_SITL');
        if (fs.existsSync(arm64Binary)) {
          fs.rmSync(destBinary, { force: true });
          fs.renameSync(arm64Binary, destBinary);
          fs.rmSync(path.join(sitlPath, 'linux', 'arm64'), { recursive: true, force: true });
        }
      }
    }

    done();
  } catch (err) {
    done(err);
  }
};

// macOS code signing and notarization are opt-in via environment variables so
// unsigned development and fork-PR builds keep working without credentials.
// - OSX_SIGN_IDENTITY: "Developer ID Application: Name (TEAMID)" enables signing.
//   CI only exports this when MACOS_CERT_P12, MACOS_CERT_PASSWORD, and
//   MACOS_SIGN_IDENTITY are all set; a partial set leaves it unset.
// - Notarization (requires signing) uses either an App Store Connect API key
//   (APPLE_API_KEY path + APPLE_API_KEY_ID + APPLE_API_ISSUER, suited to CI) or
//   a local notarytool keychain profile (APPLE_KEYCHAIN_PROFILE).
//   A partial API-key set falls back to signed-only instead of failing the packager.
const osxSign = process.env.OSX_SIGN_IDENTITY
  ? { identity: process.env.OSX_SIGN_IDENTITY }
  : undefined;

const appleApiKey = process.env.APPLE_API_KEY;
const hasApiKeyNotarize = Boolean(
  appleApiKey &&
  process.env.APPLE_API_KEY_ID &&
  process.env.APPLE_API_ISSUER &&
  fs.existsSync(appleApiKey)
);

let osxNotarize;
if (osxSign && hasApiKeyNotarize) {
  osxNotarize = {
    appleApiKey,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_ISSUER,
  };
} else if (osxSign && process.env.APPLE_KEYCHAIN_PROFILE) {
  osxNotarize = { keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE };
}

export default {
  packagerConfig: {
    executableName: "inav-configurator-jb",
    asar: false,
    icon: 'images/inav',
    osxSign,
    osxNotarize,
    extraResource: [
      'resources/public/sitl',
      'assets/linux/45-inav.rules'
    ],
    afterCopyExtraResources: [pruneSitlBinaries],
  },
  rebuildConfig: {
    // Native modules (serialport, usb) ship with prebuilt binaries for each platform.
    // vite-plugin-native handles them at build time. Skip electron-rebuild to avoid
    // requiring Visual Studio Build Tools on Windows during development.
    onlyModules: [],
  },
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'js/main/main.js',
            config: 'vite.main.config.js',
          },
          {
            entry: 'js/main/preload.js',
            config: 'vite.preload.config.js',
          },
          {
            entry: 'js/libraries/bluetooth-device-chooser/bt-device-chooser-preload.js',
            config: 'vite.preload.config.js',
          },
        ],
        renderer: [
          {
            name: 'bt_device_chooser',
            config: 'vite.bt-dc-renderer.config.js',
          },
          {
            name: 'main_window',
            config: 'vite.main-renderer.config.js',
          },
        ],
      },
    },
  ],
  hooks: {
    // appdmg sometimes unmounts the temp volume and then fails hdiutil detach
    // ("No such file or directory"). Clear leftovers before makers run.
    preMake: async () => {
      if (process.platform !== 'darwin') {
        return;
      }
      for (const vol of ['/Volumes/INAV-Configurator-JB', '/Volumes/INAV Configurator JB']) {
        try {
          execFileSync('/usr/bin/hdiutil', ['detach', vol, '-force'], { stdio: 'ignore' });
        } catch {
          // Volume was not mounted.
        }
      }
    },
    // Uniform artifact file names. JB's fork: INAV-Configurator-JB_Win64_<version>_<build label>,
    // the label from JB_BUILD_LABEL (tools/build_label.sh), as on the firmware hex files.
    postMake: async (config, makeResults) => {
      const label = process.env.JB_BUILD_LABEL || 'jb-dev';
      makeResults.forEach(result => {
        var baseName = `${result.packageJSON.productName.replaceAll(' ', '-')}_${result.platform}_${result.arch}_${result.packageJSON.version}_${label}`;
        result.artifacts.forEach(artifact => {
          var artifactStr = artifact.toString();
          var newPath = path.join(path.dirname(artifactStr), baseName + path.extname(artifactStr));
          newPath = newPath.replace('-JB_win32_ia32', '-JB_Win32');
          newPath = newPath.replace('-JB_win32_x64', '-JB_Win64');
          newPath = newPath.replace('-JB_darwin', '-JB_MacOS');
          fs.renameSync(artifactStr, newPath);
          console.log('Artifact: ' + newPath);
        });
      });
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-wix',
      config: {
        name: "INAV Configurator JB",
        shortName: "INAV JB",
        exe: "inav-configurator-jb",
        description: "Configurator for the open source flight controller software INAV.",
        programFilesFolderName: "inav-configurator-jb",
        shortcutFolderName: "INAV JB",
        manufacturer: "The INAV open source project",
        appUserModelId: "com.inav.configurator.jb",
        icon: path.join(__dirname, "./assets/windows/inav_installer_icon.ico"),
        // JB's fork: its own upgrade code, so its installer never replaces the official app
        upgradeCode: "246d85d2-b51c-4415-9c64-beb5bb4c7d64",
        ui: {
          enabled: false,
          chooseDirectory: true,
          images: {
            background: path.join(__dirname, "./assets/windows/background.jpg"),
            banner: path.join(__dirname, "./assets/windows/banner.jpg")
          }
        },
        // Standard WiX template appends the unsightly "(Machine - WSI)" to the name, so use our own template
        beforeCreate: (msiCreator) => {
          return new Promise((resolve, reject) => {
            fs.readFile(path.join(__dirname,"./assets/windows/wix.xml"), "utf8" , (err, content) => {
                if (err) {
                    reject (err);
                }
                msiCreator.wixTemplate = content;
                resolve();
            });
          });
        }
      }
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        // Keep name and volume title identical and space-free. A mismatch makes
        // appdmg detach the wrong /Volumes path; spaces flake on CI hdiutil.
        name: "INAV-Configurator-JB",
        title: "INAV-Configurator-JB",
        background: "./assets/osx/dmg-background.png",
        icon: "./images/inav.icns"
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32', 'linux', 'darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          name: "inav-configurator-jb",
          productName: "INAV Configurator JB",
          categories: ["Utility"],
          icon: "./assets/linux/icon/inav_icon_128.png",
          description: "Configurator for the open source flight controller software INAV.",
          homepage: "https://github.com/inavflight/",
          scripts: {
            postinst: "./assets/linux/postinst",
            postrm: "./assets/linux/postrm",
          },
        }
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          name: "inav-configurator-jb",
          productName: "INAV Configurator JB",
          license: "GPL-3.0",
          categories: ["Utility"],
          icon: "./assets/linux/icon/inav_icon_128.png",
          description: "Configurator for the open source flight controller software INAV.",
          homepage: "https://github.com/inavflight/",
          scripts: {
            post: "./assets/linux/postinst",
            postun: "./assets/linux/postrm",
          },
        }
      },
    },
  ],
};
