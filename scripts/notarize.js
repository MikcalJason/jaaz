// scripts/notarize.js
import { notarize } from "@electron/notarize";

export default async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  // Skip notarization if Apple credentials are not configured (local dev builds)
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_PASSWORD || !process.env.TEAM_ID) {
    console.log("⚠️ Apple credentials not set — skipping notarization (local build)");
    return;
  }

  const appPath = `${appOutDir}/Jaaz.app`;
  console.log("appPath", appPath);
  return await notarize({
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_PASSWORD,
    teamId: process.env.TEAM_ID,
  });
}
