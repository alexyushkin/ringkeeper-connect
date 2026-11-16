// Packaging for Windows (NSIS installer) and macOS (dmg + zip, one per
// architecture). Signing is used only when its secrets are present, so forks
// and local builds still produce working, unsigned installers.
//
// Windows signing (same setup as the ringkeeper repo):
//   Azure Artifact Signing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//     plus AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE
//     and WIN_PUBLISHER_NAME (exactly as on the certificate)
//   or a .pfx certificate: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (electron-builder's own variables)
// macOS signing and notarization:
//   CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application certificate)
//   and APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER)
const env = process.env;
const has = (...names) => names.every((n) => !!env[n]);

const azure = has("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE");
const macCert = has("CSC_LINK");
const notarize = macCert && (has("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID") || has("APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"));

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.ringkeeper.connect",
  productName: "Ringkeeper Connect",
  copyright: "Copyright © 2026 Alexey Yushkin",
  directories: { output: "release", buildResources: "build" },
  // Everything is bundled into dist/ by scripts/build-desktop.mjs, so no node_modules ship.
  files: ["dist/**/*", "!dist/**/*.map", "!dist/bridge.mjs", "assets/**/*", "package.json", "!node_modules/**/*"],
  extraResources: [
    // The bridge AI apps launch, and the Node/uv it and local connections run on.
    { from: "dist/bridge.mjs", to: "bridge.mjs" },
    { from: "runtimes/${platform}-${arch}", to: "runtimes", filter: ["**/*", "!.pinned"] },
  ],
  asar: true,
  // The app is in English only; Chromium's other interface languages add ~48 MB.
  electronLanguages: ["en-US"],
  publish: [{ provider: "github", owner: "alexyushkin", repo: "ringkeeper-connect", releaseType: "release" }],

  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    ...(azure
      ? {
          azureSignOptions: {
            publisherName: env.WIN_PUBLISHER_NAME || "Alexey Yushkin",
            endpoint: env.AZURE_SIGNING_ENDPOINT,
            codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
            certificateProfileName: env.AZURE_SIGNING_PROFILE,
          },
        }
      : {}),
    // Unsigned builds can't have their updates' signatures checked.
    verifyUpdateCodeSignature: azure || has("WIN_CSC_LINK"),
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Ringkeeper Connect",
    include: "build/installer.nsh",
    artifactName: "Ringkeeper-Connect-Setup-${version}.${ext}",
    deleteAppDataOnUninstall: false,
  },

  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.productivity",
    icon: "build/icon.icns",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    // No certificate: build unsigned instead of failing (forks, local builds).
    ...(macCert ? {} : { identity: null }),
    notarize,
    // Used for the zip (what auto-update downloads); the dmg has its own name below.
    artifactName: "Ringkeeper-Connect-${version}-${arch}-mac.${ext}",
  },
  dmg: { artifactName: "Ringkeeper-Connect-${version}-${arch}.${ext}" },
};
