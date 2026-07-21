export function signingPlan(platform = process.platform) {
  if (platform !== "darwin") return [];
  return ["host-helper-executable", "host-helper-bundle", "outer-electron-app"];
}

export function verificationCommandPlan(appPath) {
  const helper = `${appPath}/Contents/Resources/host-computer/HomunComputerService.app`;
  const helperExecutable = `${helper}/Contents/MacOS/HomunComputerService`;
  const gatewayExecutable = `${appPath}/Contents/Resources/bin/local-first-desktop-gateway`;
  return [
    ["lipo", ["-archs", helperExecutable]],
    ["lipo", ["-archs", gatewayExecutable]],
    ["codesign", ["--verify", "--strict", "--verbose=4", helper]],
    ["codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]],
    ["spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]],
    ["xcrun", ["stapler", "validate", appPath]],
  ];
}

export const forbiddenHelperEntitlements = Object.freeze([
  "com.apple.security.network.client",
  "com.apple.security.network.server",
  "com.apple.security.device.audio-input",
  "com.apple.security.device.camera",
  "com.apple.security.personal-information.addressbook",
  "com.apple.security.personal-information.calendars",
  "com.apple.security.personal-information.location",
  "com.apple.security.automation.apple-events",
  "com.apple.security.get-task-allow",
]);

export function parseDeveloperIdIdentity(output) {
  for (const line of String(output).split("\n")) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application:/);
    if (match) return match[1];
  }
  return null;
}
